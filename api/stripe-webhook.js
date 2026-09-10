const crypto = require("crypto");
const {ANNUAL_PRICE_CENTS, env, send, readRawBody, safeEqual, db, updateProfile, extendAccess, suspendMembershipAccess, handlerError} = require("../lib/server");

function isExpectedCheckoutPayment(object) {
  return object?.payment_status === "paid" &&
    String(object?.currency || "").toLowerCase() === "usd" &&
    Number(object?.amount_total) === ANNUAL_PRICE_CENTS;
}

function isExpectedInvoicePayment(object) {
  return String(object?.currency || "").toLowerCase() === "usd" &&
    Number(object?.amount_paid) >= ANNUAL_PRICE_CENTS;
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

async function userByCustomer(customerId) {
  const rows = await db(`profiles?stripe_customer_id=eq.${encodeURIComponent(customerId)}&select=id`, {prefer:""});
  return rows?.[0]?.id || "";
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

    if (event.type === "checkout.session.completed" && userId && isExpectedCheckoutPayment(object)) {
      const until = new Date(Date.now() + 365 * 86400000);
      await extendAccess(userId, until, {
        subscription_status:"active",
        stripe_customer_id:String(object.customer || ""),
        stripe_subscription_id:String(object.subscription || "")
      });
    }

    if (event.type === "invoice.paid") {
      if (!userId && object.customer) userId = await userByCustomer(String(object.customer));
      const periodEnd = object.lines?.data?.reduce((latest, line) => Math.max(latest, Number(line.period?.end) || 0), 0) || 0;
      if (userId && periodEnd && isExpectedInvoicePayment(object)) {
        await extendAccess(userId, new Date(periodEnd * 1000), {subscription_status:"active"});
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
module.exports.stripeAccessAction = stripeAccessAction;
