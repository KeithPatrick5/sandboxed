const {env, baseUrl, send, requireUser, ensureProfile, accessState, rateLimit, secureHash, handlerError} = require("../lib/server");

module.exports = async function handler(request, response) {
  if (request.method !== "POST") return send(response, 405, {error:"Method not allowed"});
  try {
    if (!env("STRIPE_SECRET_KEY") || !env("STRIPE_PRICE_ID")) throw Object.assign(new Error("Stripe is not configured yet"), {status:503, code:"STRIPE_NOT_CONFIGURED"});
    const {user} = await requireUser(request);
    rateLimit(request, `stripe-checkout:${user.id}`, 5, 600);
    const profile = await ensureProfile(user);
    if (accessState(profile).state === "active") {
      throw Object.assign(new Error("Your membership is already active"), {status:409, code:"MEMBERSHIP_ACTIVE"});
    }
    const params = new URLSearchParams();
    params.set("mode", "subscription");
    params.set("success_url", `${baseUrl()}/?payment=success`);
    params.set("cancel_url", `${baseUrl()}/?payment=cancelled`);
    params.set("client_reference_id", user.id);
    params.set("metadata[user_id]", user.id);
    params.set("metadata[price_id]", env("STRIPE_PRICE_ID"));
    params.set("subscription_data[metadata][user_id]", user.id);
    params.set("subscription_data[metadata][price_id]", env("STRIPE_PRICE_ID"));
    if (profile.stripe_customer_id) params.set("customer", profile.stripe_customer_id);
    else params.set("customer_email", user.email);
    params.set("line_items[0][price]", env("STRIPE_PRICE_ID"));
    params.set("line_items[0][quantity]", "1");
    const stripe = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method:"POST",
      headers:{
        Authorization:`Bearer ${env("STRIPE_SECRET_KEY")}`,
        "Content-Type":"application/x-www-form-urlencoded",
        "Idempotency-Key":secureHash(`stripe-checkout:${user.id}:${Math.floor(Date.now() / 600000)}`)
      },
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
