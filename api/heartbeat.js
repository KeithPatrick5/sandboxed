const {send, readBody, requireUser, touchWatchSession, handlerError} = require("../lib/server");

module.exports = async function handler(request, response) {
  if (request.method !== "POST") return send(response, 405, {error:"Method not allowed"});
  try {
    const {user} = await requireUser(request);
    const body = await readBody(request);
    if (!body.sessionId) return send(response, 400, {error:"Playback session required"});
    await touchWatchSession(user.id, String(body.sessionId), Boolean(body.end));
    return send(response, 200, {ok:true});
  } catch (error) {
    return handlerError(response, error);
  }
};
