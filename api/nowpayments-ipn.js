const crypto = require("crypto");
const {ANNUAL_PRICE_USD, env, send, readBody, safeEqual, db, extendAccess, handlerError} = require("../lib/server");

const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function orderUserId(orderId) {
  const match = String(orderId || "").match(/^sandboxed:([^:]+):(\d+)$/);
  return match && USER_ID_PATTERN.test(match[1]) ? match[1] : "";
}

function isExpectedPayment(payload) {
  return payload?.payment_status === "finished" &&
    String(payload?.price_currency || "").toLowerCase() === "usd" &&
    Number(payload?.price_amount) >= ANNUAL_PRICE_USD;
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = sortObject(value[key]);
    return result;
  }, {});
}

function paymentEventFields(externalId, userId, payload, status, accessUntil = null) {
  return {
    provider:"nowpayments",
    external_id:externalId,
    user_id:userId || null,
    status,
    amount:Number(payload.price_amount || 0) || null,
    currency:String(payload.price_currency || "usd"),
    payload:{
      invoice_id:payload.invoice_id || null,
      payment_id:payload.payment_id || null,
      order_id:payload.order_id || null,
      payment_status:payload.payment_status || null,
      price_amount:Number(payload.price_amount || 0) || null,
      price_currency:payload.price_currency || null,
      ...(accessUntil ? {access_until:accessUntil} : {})
    }
  };
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
    if (!externalId) return send(response, 400, {error:"Missing NOWPayments transaction ID"});
    const existing = await db(`payment_events?provider=eq.nowpayments&external_id=eq.${encodeURIComponent(externalId)}&select=id,status,payload`, {prefer:""});
    let event = existing?.[0] || null;
    if (event?.status === "finished") return send(response, 200, {received:true, duplicate:true});
    const userId = orderUserId(payload.order_id);

    if (isExpectedPayment(payload) && userId) {
      let accessUntil = event?.payload?.access_until || "";
      if (!accessUntil) {
        const profiles = await db(`profiles?id=eq.${encodeURIComponent(userId)}&select=access_until`, {prefer:""});
        const current = profiles?.[0]?.access_until ? Date.parse(profiles[0].access_until) : 0;
        accessUntil = new Date(Math.max(Date.now(), current) + 365 * 86400000).toISOString();
      }
      const activating = paymentEventFields(externalId, userId, payload, "activating", accessUntil);
      if (event) {
        const rows = await db(`payment_events?id=eq.${encodeURIComponent(event.id)}`, {
          method:"PATCH", body:activating, prefer:"return=representation"
        });
        event = rows?.[0] || event;
      } else {
        const rows = await db("payment_events", {method:"POST", body:activating, prefer:"return=representation"});
        event = rows?.[0];
      }
      await extendAccess(userId, accessUntil, {subscription_status:"active"});
      await db(`payment_events?id=eq.${encodeURIComponent(event.id)}`, {
        method:"PATCH",
        body:paymentEventFields(externalId, userId, payload, "finished", accessUntil),
        prefer:"return=minimal"
      });
      return send(response, 200, {received:true, activated:true});
    }

    // NOWPayments sends several callbacks for one payment. Keep the latest
    // status instead of treating the first non-final callback as the only one.
    const fields = paymentEventFields(externalId, userId, payload, String(payload.payment_status || "unknown"));
    if (event) {
      if (event.status !== "activating") {
        await db(`payment_events?id=eq.${encodeURIComponent(event.id)}`, {method:"PATCH", body:fields, prefer:"return=minimal"});
      }
    } else {
      await db("payment_events", {method:"POST", body:fields, prefer:"return=minimal"});
    }
    return send(response, 200, {received:true});
  } catch (error) {
    return handlerError(response, error);
  }
};

module.exports.orderUserId = orderUserId;
module.exports.isExpectedPayment = isExpectedPayment;
module.exports.paymentEventFields = paymentEventFields;
