const crypto = require("crypto");
const {
  env,
  send,
  readRawBody,
  safeEqual,
  db,
  updateProfile,
  extendAccess,
  suspendMembershipAccess,
  membershipPlan,
  planForStripePriceId,
  handlerError
} = require("../lib/server");

function checkoutPaymentPlan(object) {
  const plan = planForStripePriceId(object?.metadata?.price_id);
  const claimedPlan = object?.metadata?.plan ? membershipPlan(object.metadata.plan) : plan;
  return object?.payment_status === "paid" &&
    String(object?.currency || "").toLowerCase() === "usd" &&
    plan && claimedPlan?.code === plan.code &&
    Number(object?.amount_total) === plan.priceCents &&
    String(object?.subscription || "").startsWith("sub_")
    ? plan
    : null;
}

function isExpectedCheckoutPayment(object) {
  return Boolean(checkoutPaymentPlan(object));
}

function invoiceSubscriptionId(object) {
  const subscription = object?.parent?.subscription_details?.subscription ?? object?.subscription;
  return typeof subscription === "string" ? subscription : String(subscription?.id || "");
}

function invoicePriceIds(object) {
  return (object?.lines?.data || []).map((line) => {
    const price = line?.pricing?.price_details?.price ?? line?.price;
    return typeof price === "string" ? price : String(price?.id || "");
  }).filter(Boolean);
}

function invoicePaymentPlan(object, expectedSubscriptionId = "") {
  const subscriptionId = invoiceSubscriptionId(object);
  const plans = [...new Set(invoicePriceIds(object).map(planForStripePriceId).filter(Boolean))];
  const plan = plans.length === 1 ? plans[0] : null;
  const metadata = object?.parent?.subscription_details?.metadata || object?.metadata || {};
  const claimedPlan = metadata.plan ? membershipPlan(metadata.plan) : plan;
  const claimedPrice = String(metadata.price_id || "");
  return String(object?.currency || "").toLowerCase() === "usd" &&
    plan && claimedPlan?.code === plan.code &&
    (!claimedPrice || planForStripePriceId(claimedPrice)?.code === plan.code) &&
    Number(object?.amount_paid) === plan.priceCents &&
    subscriptionId.startsWith("sub_") &&
    (!expectedSubscriptionId || subscriptionId === expectedSubscriptionId)
    ? plan
    : null;
}

function isExpectedInvoicePayment(object, expectedSubscriptionId = "") {
  return Boolean(invoicePaymentPlan(object, expectedSubscriptionId));
}

function verifySignature(raw, header) {
  const parts = String(header || "").split(",").map((part) => part.split("="));
  const timestamp = parts.find(([key]) => key === "t")?.[1];
  const signatures = parts.filter(([key]) => key === "v1").map(([,value]) => value);
  if (!timestamp || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = crypto.createHmac("sha256", env("STRIPE_WEBHOOK_SECRET")).update(`${timestamp}.${raw}`).digest("hex");
  return signatures.some((signature) => safeEqual(signature, expected));
}

async function eventSeen(id) {
  const rows = await db(`payment_events?provider=eq.stripe&external_id=eq.${encodeURIComponent(id)}&select=id`, {prefer:""});
  return Boolean(rows?.length);
}

async function profileByCustomer(customerId) {
  const rows = await db(`profiles?stripe_customer_id=eq.${encodeURIComponent(customerId)}&select=id,stripe_subscription_id`, {prefer:""});
  return rows?.[0] || null;
}

async function userByCustomer(customerId) {
  return (await profileByCustomer(customerId))?.id || "";
}

async function stripeObject(path) {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers:{Authorization:`Bearer ${env("STRIPE_SECRET_KEY")}`},
    signal:AbortSignal.timeout(12000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload?.error?.message || "Stripe record could not be retrieved"), {status:502, code:"STRIPE_ERROR"});
  return payload;
}

async function customerForAccessEvent(eventType, object) {
  if (object?.customer) return String(object.customer);
  if (String(eventType).startsWith("charge.dispute.") && object?.charge) {
    const charge = await stripeObject(`charges/${encodeURIComponent(String(object.charge))}`);
    return String(charge?.customer || "");
  }
  return "";
}

function stripeAccessAction(eventType, object) {
  if (eventType === "charge.refunded" && Number(object?.amount_refunded) > 0) return "refunded";
  if (eventType === "charge.dispute.created") return "disputed";
  if (eventType === "charge.dispute.closed") return object?.status === "won" ? "active" : "disputed";
  return "";
}

module.exports = async function handler(request, response) {
  if (request.method !== "POST") return send(response, 405, {error:"Method not allowed"});
  try {
    if (!env("STRIPE_WEBHOOK_SECRET")) throw Object.assign(new Error("Stripe webhook is not configured"), {status:503, code:"STRIPE_NOT_CONFIGURED"});
    const raw = await readRawBody(request);
    if (!verifySignature(raw, request.headers["stripe-signature"])) return send(response, 400, {error:"Invalid Stripe signature"});
    const event = JSON.parse(raw);
    if (await eventSeen(event.id)) return send(response, 200, {received:true, duplicate:true});
    const object = event.data?.object || {};
    let userId = object.metadata?.user_id || object.client_reference_id || "";

    if (event.type === "checkout.session.completed" && userId) {
      const plan = checkoutPaymentPlan(object);
      const invoiceId = typeof object.invoice === "string" ? object.invoice : object.invoice?.id;
      if (plan && invoiceId) {
        const invoice = await stripeObject(`invoices/${encodeURIComponent(invoiceId)}`);
        const invoicePlan = invoicePaymentPlan(invoice, String(object.subscription || ""));
        const periodEnd = invoice.lines?.data?.reduce((latest, line) => Math.max(latest, Number(line.period?.end) || 0), 0) || 0;
        if (invoicePlan?.code === plan.code && periodEnd) {
          await extendAccess(userId, new Date(periodEnd * 1000), {
            subscription_status:"active",
            stripe_customer_id:String(object.customer || ""),
            stripe_subscription_id:String(object.subscription || ""),
            membership_plan:plan.code,
            membership_provider:"stripe"
          });
        }
      }
    }

    if (event.type === "invoice.paid") {
      const customerProfile = object.customer ? await profileByCustomer(String(object.customer)) : null;
      const metadataUserId = object?.parent?.subscription_details?.metadata?.user_id || "";
      if (!userId) userId = metadataUserId || customerProfile?.id || "";
      const periodEnd = object.lines?.data?.reduce((latest, line) => Math.max(latest, Number(line.period?.end) || 0), 0) || 0;
      const subscriptionId = invoiceSubscriptionId(object);
      const plan = invoicePaymentPlan(object, metadataUserId ? "" : customerProfile?.stripe_subscription_id || "");
      if (userId && periodEnd && plan) {
        await extendAccess(userId, new Date(periodEnd * 1000), {
          subscription_status:"active",
          stripe_subscription_id:subscriptionId,
          membership_plan:plan.code,
          membership_provider:"stripe"
        });
      }
    }

    if (event.type === "invoice.payment_failed") {
      if (!userId && object.customer) userId = await userByCustomer(String(object.customer));
      if (userId) await updateProfile(userId, {subscription_status:"past_due"});
    }

    if (event.type === "customer.subscription.deleted") {
      if (!userId && object.customer) userId = await userByCustomer(String(object.customer));
      if (userId) await updateProfile(userId, {subscription_status:"cancelled"});
    }

    const accessAction = stripeAccessAction(event.type, object);
    if (accessAction) {
      if (!userId) {
        const customerId = await customerForAccessEvent(event.type, object);
        if (customerId) userId = await userByCustomer(customerId);
      }
      if (userId) {
        if (accessAction === "active") await updateProfile(userId, {subscription_status:"active"});
        else await suspendMembershipAccess(userId, accessAction);
      }
    }

    await db("payment_events", {
      method:"POST",
      body:{
        provider:"stripe",
        external_id:event.id,
        user_id:userId || null,
        status:event.type,
        amount:Number(object.amount_total ?? object.amount_paid ?? 0) / 100 || null,
        currency:object.currency || null,
        payload:{
          event_type:event.type,
          created:event.created || null,
          livemode:Boolean(event.livemode),
          customer:object.customer || null,
          subscription:object.subscription || null,
          charge:object.charge || (String(object.object || "") === "charge" ? object.id : null),
          dispute_status:object.status || null,
          amount_refunded:Number(object.amount_refunded) || null
        }
      },
      prefer:"return=minimal"
    });
    return send(response, 200, {received:true});
  } catch (error) {
    return handlerError(response, error);
  }
};

module.exports.config = {api:{bodyParser:false}};
module.exports.isExpectedCheckoutPayment = isExpectedCheckoutPayment;
module.exports.isExpectedInvoicePayment = isExpectedInvoicePayment;
module.exports.checkoutPaymentPlan = checkoutPaymentPlan;
module.exports.invoicePaymentPlan = invoicePaymentPlan;
module.exports.stripeAccessAction = stripeAccessAction;
module.exports.invoiceSubscriptionId = invoiceSubscriptionId;
module.exports.invoicePriceIds = invoicePriceIds;
