const {env, baseUrl, send, requireUser, ensureProfile, handlerError} = require("../lib/server");

module.exports = async function handler(request, response) {
  if (request.method !== "POST") return send(response, 405, {error:"Method not allowed"});
  try {
    if (!env("NOWPAYMENTS_API_KEY") || !env("NOWPAYMENTS_IPN_SECRET")) {
      throw Object.assign(new Error("Crypto payments are not configured yet"), {status:503, code:"NOWPAYMENTS_NOT_CONFIGURED"});
    }
    const {user} = await requireUser(request);
    await ensureProfile(user);
    const orderId = `sandboxed:${user.id}:${Date.now()}`;
    const now = await fetch("https://api.nowpayments.io/v1/invoice", {
      method:"POST",
      headers:{"x-api-key":env("NOWPAYMENTS_API_KEY"), "Content-Type":"application/json"},
      body:JSON.stringify({
        price_amount:20,
        price_currency:"usd",
        order_id:orderId,
        order_description:"Sandboxed annual membership",
        ipn_callback_url:`${baseUrl()}/api/nowpayments-ipn`,
        success_url:`${baseUrl()}/?payment=success`,
        cancel_url:`${baseUrl()}/?payment=cancelled`
      }),
      signal:AbortSignal.timeout(12000)
    });
    const payload = await now.json();
    const url = payload.invoice_url || payload.pay_url;
    if (!now.ok || !url) throw Object.assign(new Error(payload?.message || "Crypto invoice could not be created"), {status:502, code:"NOWPAYMENTS_ERROR"});
    return send(response, 200, {url});
  } catch (error) {
    return handlerError(response, error);
  }
};
