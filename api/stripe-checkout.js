const {env, baseUrl, send, requireUser, ensureProfile, handlerError} = require("../lib/server");

module.exports = async function handler(request, response) {
  if (request.method !== "POST") return send(response, 405, {error:"Method not allowed"});
  try {
    if (!env("STRIPE_SECRET_KEY")) throw Object.assign(new Error("Stripe is not configured yet"), {status:503, code:"STRIPE_NOT_CONFIGURED"});
    const {user} = await requireUser(request);
    const profile = await ensureProfile(user);
    const params = new URLSearchParams();
    params.set("mode", "subscription");
    params.set("success_url", `${baseUrl()}/?payment=success`);
    params.set("cancel_url", `${baseUrl()}/?payment=cancelled`);
    params.set("client_reference_id", user.id);
    params.set("metadata[user_id]", user.id);
    params.set("subscription_data[metadata][user_id]", user.id);
    if (profile.stripe_customer_id) params.set("customer", profile.stripe_customer_id);
    else params.set("customer_email", user.email);
    if (env("STRIPE_PRICE_ID")) {
      params.set("line_items[0][price]", env("STRIPE_PRICE_ID"));
    } else {
      params.set("line_items[0][price_data][currency]", "usd");
      params.set("line_items[0][price_data][unit_amount]", "2000");
      params.set("line_items[0][price_data][recurring][interval]", "year");
      params.set("line_items[0][price_data][product_data][name]", "Sandboxed annual membership");
      params.set("line_items[0][price_data][product_data][description]", "One year of access to the Sandboxed media interface");
    }
    params.set("line_items[0][quantity]", "1");
    const stripe = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method:"POST",
      headers:{Authorization:`Bearer ${env("STRIPE_SECRET_KEY")}`, "Content-Type":"application/x-www-form-urlencoded"},
      body:params,
      signal:AbortSignal.timeout(12000)
    });
    const payload = await stripe.json();
    if (!stripe.ok || !payload.url) throw Object.assign(new Error(payload?.error?.message || "Stripe checkout could not be created"), {status:502, code:"STRIPE_ERROR"});
    return send(response, 200, {url:payload.url});
  } catch (error) {
    return handlerError(response, error);
  }
};
