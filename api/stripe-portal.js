const {env, baseUrl, send, requireUser, ensureProfile, handlerError} = require("../lib/server");

module.exports = async function handler(request, response) {
  if (request.method !== "POST") return send(response, 405, {error:"Method not allowed"});
  try {
    if (!env("STRIPE_SECRET_KEY")) throw Object.assign(new Error("Stripe is not configured yet"), {status:503, code:"STRIPE_NOT_CONFIGURED"});
    const {user} = await requireUser(request);
    const profile = await ensureProfile(user);
    if (!profile.stripe_customer_id) throw Object.assign(new Error("No Stripe subscription is attached to this account"), {status:404, code:"NO_STRIPE_CUSTOMER"});
    const params = new URLSearchParams({customer:profile.stripe_customer_id, return_url:baseUrl()});
    const stripe = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
      method:"POST",
      headers:{Authorization:`Bearer ${env("STRIPE_SECRET_KEY")}`, "Content-Type":"application/x-www-form-urlencoded"},
      body:params,
      signal:AbortSignal.timeout(12000)
    });
    const payload = await stripe.json();
    if (!stripe.ok || !payload.url) throw Object.assign(new Error(payload?.error?.message || "Billing portal could not be opened"), {status:502, code:"STRIPE_ERROR"});
    return send(response, 200, {url:payload.url});
  } catch (error) {
    return handlerError(response, error);
  }
};
