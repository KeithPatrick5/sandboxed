const crypto = require("crypto");
const {env, send, readBody, safeEqual, db, extendAccess, handlerError} = require("../lib/server");

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = sortObject(value[key]);
    return result;
  }, {});
}

module.exports = async function handler(request, response) {
  if (request.method !== "POST") return send(response, 405, {error:"Method not allowed"});
  try {
    if (!env("NOWPAYMENTS_IPN_SECRET")) throw Object.assign(new Error("NOWPayments webhook is not configured"), {status:503, code:"NOWPAYMENTS_NOT_CONFIGURED"});
    const payload = await readBody(request);
    const expected = crypto.createHmac("sha512", env("NOWPAYMENTS_IPN_SECRET"))
      .update(JSON.stringify(sortObject(payload)))
      .digest("hex");
    if (!safeEqual(request.headers["x-nowpayments-sig"], expected)) return send(response, 400, {error:"Invalid NOWPayments signature"});
    const externalId = String(payload.payment_id || payload.invoice_id || payload.order_id || "");
    const existing = await db(`payment_events?provider=eq.nowpayments&external_id=eq.${encodeURIComponent(externalId)}&select=id`, {prefer:""});
    if (existing?.length) return send(response, 200, {received:true, duplicate:true});
    const orderParts = String(payload.order_id || "").split(":");
    const userId = orderParts[0] === "sandboxed" ? orderParts[1] : "";
    if (payload.payment_status === "finished" && userId) {
      const profiles = await db(`profiles?id=eq.${encodeURIComponent(userId)}&select=access_until`, {prefer:""});
      const current = profiles?.[0]?.access_until ? Date.parse(profiles[0].access_until) : 0;
      const until = new Date(Math.max(Date.now(), current) + 365 * 86400000);
      await extendAccess(userId, until, {subscription_status:"active"});
    }
    await db("payment_events", {
      method:"POST",
      body:{provider:"nowpayments", external_id:externalId, user_id:userId || null, status:String(payload.payment_status || "unknown"), amount:Number(payload.price_amount || 0) || null, currency:String(payload.price_currency || "usd"), payload},
      prefer:"return=minimal"
    });
    return send(response, 200, {received:true});
  } catch (error) {
    return handlerError(response, error);
  }
};
