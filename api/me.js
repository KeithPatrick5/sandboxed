const {
  send,
  readBody,
  requireUser,
  ensureProfile,
  accessState,
  registerDevice,
  listDevices,
  handlerError
} = require("../lib/server");

module.exports = async function handler(request, response) {
  if (request.method !== "POST") return send(response, 405, {error:"Method not allowed"});
  try {
    const {user} = await requireUser(request);
    const body = await readBody(request);
    const profile = await ensureProfile(user);
    const device = await registerDevice(user.id, body, request);
    const devices = await listDevices(user.id);
    return send(response, 200, {
      user:{id:user.id, email:user.email},
      profile:accessState(profile),
      billing:{hasStripeCustomer:Boolean(profile.stripe_customer_id), status:profile.subscription_status},
      deviceId:device.id,
      devices
    });
  } catch (error) {
    return handlerError(response, error);
  }
};
