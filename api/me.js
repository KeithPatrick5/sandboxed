const {
  send,
  readBody,
  requireUser,
  ensureProfile,
  accessState,
  registerDevice,
  trialEligibility,
  listDevices,
  handlerError
} = require("../lib/server");

module.exports = async function handler(request, response) {
  if (request.method !== "POST") return send(response, 405, {error:"Method not allowed"});
  try {
    const {user} = await requireUser(request);
    const body = await readBody(request);
    const profile = await ensureProfile(user);
    const device = await registerDevice(user.id, body, request, response);
    const devices = await listDevices(user.id);
    const profileState = accessState(profile);
    const eligibility = profileState.state === "eligible"
      ? await trialEligibility(profile, device)
      : null;
    return send(response, 200, {
      user:{id:user.id, email:user.email},
      profile:profileState,
      trialEligibility:eligibility,
      billing:{
        hasStripeCustomer:Boolean(profile.stripe_customer_id),
        status:profile.subscription_status,
        plan:profile.membership_plan || (profile.access_until ? "annual" : null),
        provider:profile.membership_provider || (profile.stripe_customer_id ? "stripe" : profile.access_until ? "nowpayments" : null)
      },
      deviceId:device.id,
      devices
    });
  } catch (error) {
    return handlerError(response, error);
  }
};
