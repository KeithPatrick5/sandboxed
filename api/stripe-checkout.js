const {
  env,
  baseUrl,
  send,
  readBody,
  requireUser,
  ensureProfile,
  accessState,
  rateLimit,
  secureHash,
  membershipPlan,
  stripePriceIdForPlan,
  handlerError
} = require("../lib/server");
const {recordAnalyticsEventSafe} = require("../lib/analytics");

module.exports = async function handler(request, response) {
  if (request.method !== "POST") return send(response, 405, {error:"Method not allowed"});
  try {
    if (!env("STRIPE_SECRET_KEY")) throw Object.assign(new Error("Stripe is not configured yet"), {status:503, code:"STRIPE_NOT_CONFIGURED"});
    const {user} = await requireUser(request);
    const body = await readBody(request);
    const plan = membershipPlan(body.plan || "annual");
    if (!plan) throw Object.assign(new Error("Choose a valid membership plan"), {status:400, code:"INVALID_PLAN"});
    const priceId = stripePriceIdForPlan(plan.code);
    if (!priceId) throw Object.assign(new Error(`${plan.label} card checkout is not configured yet`), {status:503, code:"STRIPE_PLAN_NOT_CONFIGURED"});
    rateLimit(request, `stripe-checkout:${plan.code}:${user.id}`, 5, 600);
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
    params.set("metadata[plan]", plan.code);
    params.set("metadata[price_id]", priceId);
    params.set("subscription_data[metadata][user_id]", user.id);
    params.set("subscription_data[metadata][plan]", plan.code);
    params.set("subscription_data[metadata][price_id]", priceId);
    if (profile.stripe_customer_id) params.set("customer", profile.stripe_customer_id);
    else params.set("customer_email", user.email);
    params.set("line_items[0][price]", priceId);
    params.set("line_items[0][quantity]", "1");
    const stripe = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method:"POST",
      headers:{
        Authorization:`Bearer ${env("STRIPE_SECRET_KEY")}`,
        "Content-Type":"application/x-www-form-urlencoded",
        "Idempotency-Key":secureHash(`stripe-checkout:${plan.code}:${user.id}:${Math.floor(Date.now() / 600000)}`)
      },
      body:params,
      signal:AbortSignal.timeout(12000)
    });
    const payload = await stripe.json();
    if (!stripe.ok || !payload.url) throw Object.assign(new Error(payload?.error?.message || "Stripe checkout could not be created"), {status:502, code:"STRIPE_ERROR"});
    await recordAnalyticsEventSafe({
      event:"checkout_started",
      visitorId:body.visitorId,
      userId:user.id,
      attribution:body.attribution,
      properties:{plan:plan.code, provider:"stripe", amount:plan.priceUsd, currency:"usd"},
      eventKey:`stripe-checkout:${payload.id || secureHash(payload.url)}`
    });
    return send(response, 200, {url:payload.url});
  } catch (error) {
    return handlerError(response, error);
  }
};
