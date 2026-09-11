const {
  TRIAL_HOURS,
  MONTHLY_PRICE_USD,
  ANNUAL_PRICE_USD,
  MAX_DEVICES,
  MAX_STREAMS,
  MAX_REPLACEMENTS_30_DAYS,
  env,
  stripePriceIdForPlan,
  membershipConfigured,
  send
} = require("../lib/server");

module.exports = async function handler(request, response) {
  if (request.method !== "GET") return send(response, 405, {error:"Method not allowed"});
  return send(response, 200, {
    membershipEnabled:membershipConfigured(),
    trialHours:TRIAL_HOURS,
    annualPrice:ANNUAL_PRICE_USD,
    plans:{
      monthly:{
        price:MONTHLY_PRICE_USD,
        interval:"month",
        cardEnabled:Boolean(env("STRIPE_SECRET_KEY") && stripePriceIdForPlan("monthly")),
        cryptoEnabled:false
      },
      annual:{
        price:ANNUAL_PRICE_USD,
        interval:"year",
        cardEnabled:Boolean(env("STRIPE_SECRET_KEY") && stripePriceIdForPlan("annual")),
        cryptoEnabled:Boolean(env("NOWPAYMENTS_API_KEY") && env("NOWPAYMENTS_IPN_SECRET"))
      }
    },
    currency:"USD",
    maxDevices:MAX_DEVICES,
    maxStreams:MAX_STREAMS,
    maxReplacementsPer30Days:MAX_REPLACEMENTS_30_DAYS,
    supportEmail:env("SUPPORT_EMAIL"),
    stripeEnabled:Boolean(env("STRIPE_SECRET_KEY") && stripePriceIdForPlan("annual")),
    nowPaymentsEnabled:Boolean(env("NOWPAYMENTS_API_KEY") && env("NOWPAYMENTS_IPN_SECRET"))
  });
};
