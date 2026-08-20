const crypto = require("crypto");
const {env, send, readRawBody, safeEqual, db, updateProfile, extendAccess, handlerError} = require("../lib/server");

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

    if (event.type === "checkout.session.completed" && userId && ["paid", "no_payment_required"].includes(object.payment_status)) {
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
      if (userId && periodEnd) await extendAccess(userId, new Date(periodEnd * 1000), {subscription_status:"active"});
    }

    if (event.type === "invoice.payment_failed") {
      if (!userId && object.customer) userId = await userByCustomer(String(object.customer));
      if (userId) await updateProfile(userId, {subscription_status:"past_due"});
    }

    if (event.type === "customer.subscription.deleted") {
      if (!userId && object.customer) userId = await userByCustomer(String(object.customer));
      if (userId) await updateProfile(userId, {subscription_status:"cancelled"});
    }

    await db("payment_events", {
      method:"POST",
      body:{provider:"stripe", external_id:event.id, user_id:userId || null, status:event.type, amount:object.amount_paid ? Number(object.amount_paid) / 100 : null, currency:object.currency || null, payload:event},
      prefer:"return=minimal"
    });
    return send(response, 200, {received:true});
  } catch (error) {
    return handlerError(response, error);
  }
};

module.exports.config = {api:{bodyParser:false}};
