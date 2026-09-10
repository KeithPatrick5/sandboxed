const {env, send, requireUser, rateLimit, db, handlerError} = require("../lib/server");
const {orderUserId, processPayment} = require("./nowpayments-ipn");

module.exports = async function handler(request, response) {
  if (request.method !== "POST") return send(response, 405, {error:"Method not allowed"});
  try {
    if (!env("NOWPAYMENTS_API_KEY")) throw Object.assign(new Error("Crypto payments are not configured yet"), {status:503, code:"NOWPAYMENTS_NOT_CONFIGURED"});
    rateLimit(request, "nowpayments-reconcile", 10, 600);
    const {user} = await requireUser(request);
    const invoices = await db(`payment_events?provider=eq.nowpayments_invoice&user_id=eq.${encodeURIComponent(user.id)}&status=neq.finished&select=id,payload&order=created_at.desc&limit=10`, {prefer:""});
    if (!invoices?.length) return send(response, 200, {checked:true, activated:false});

    const now = await fetch("https://api.nowpayments.io/v1/payment/?limit=100&page=0&sortBy=created_at&orderBy=desc", {
      headers:{"x-api-key":env("NOWPAYMENTS_API_KEY")},
      signal:AbortSignal.timeout(12000)
    });
    const payload = await now.json().catch(() => ({}));
    if (!now.ok) throw Object.assign(new Error(payload?.message || "Crypto payment status could not be checked"), {status:502, code:"NOWPAYMENTS_ERROR"});
    const payments = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.payments) ? payload.payments : [];
    const orders = new Map(invoices.map((invoice) => [String(invoice?.payload?.order_id || ""), invoice]));
    let latestStatus = "not_found";

    for (const payment of payments) {
      const orderId = String(payment?.order_id || "");
      const invoice = orders.get(orderId);
      if (!invoice || orderUserId(orderId) !== user.id) continue;
      const result = await processPayment(payment);
      latestStatus = String(payment.payment_status || "unknown");
      await db(`payment_events?id=eq.${encodeURIComponent(invoice.id)}`, {
        method:"PATCH",
        body:{status:latestStatus, payload:{...invoice.payload, payment_id:payment.payment_id || null, payment_status:latestStatus}},
        prefer:"return=minimal"
      });
      if (result.activated || (result.duplicate && latestStatus === "finished")) {
        return send(response, 200, {checked:true, activated:true, status:"finished"});
      }
    }

    return send(response, 200, {checked:true, activated:false, status:latestStatus});
  } catch (error) {
    return handlerError(response, error);
  }
};
