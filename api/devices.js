const {send, readBody, requireUser, listDevices, revokeDevice, handlerError} = require("../lib/server");

module.exports = async function handler(request, response) {
  try {
    const {user} = await requireUser(request);
    if (request.method === "GET") return send(response, 200, {devices:await listDevices(user.id)});
    if (request.method === "DELETE") {
      const body = await readBody(request);
      if (!body.deviceId) return send(response, 400, {error:"Device required"});
      await revokeDevice(user.id, String(body.deviceId));
      return send(response, 200, {ok:true, devices:await listDevices(user.id)});
    }
    return send(response, 405, {error:"Method not allowed"});
  } catch (error) {
    return handlerError(response, error);
  }
};
