const {
  TRIAL_HOURS,
  MAX_DEVICES,
  MAX_STREAMS,
  MAX_REPLACEMENTS_30_DAYS,
  env,
  membershipConfigured,
  send
} = require("../lib/server");

module.exports = async function handler(request, response) {
  if (request.method !== "GET") return send(response, 405, {error:"Method not allowed"});
  return send(response, 200, {
    membershipEnabled:membershipConfigured(),
    trialHours:TRIAL_HOURS,
    annualPrice:20,
    currency:"USD",
    maxDevices:MAX_DEVICES,
    maxStreams:MAX_STREAMS,
    maxReplacementsPer30Days:MAX_REPLACEMENTS_30_DAYS,
    supportEmail:env("SUPPORT_EMAIL"),
    stripeEnabled:Boolean(env("STRIPE_SECRET_KEY")),
    nowPaymentsEnabled:Boolean(env("NOWPAYMENTS_API_KEY") && env("NOWPAYMENTS_IPN_SECRET"))
  });
};
