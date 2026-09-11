const {
  send,
  readBody,
  requireUser,
  ensureProfile,
  registerDevice,
  startTrial,
  accessState,
  beginWatchSession,
  handlerError
} = require("../lib/server");
const {recordAnalyticsEventSafe} = require("../lib/analytics");

function playerUrl(item) {
  const id = Number(item?.id);
  const type = item?.type === "tv" ? "tv" : "movie";
  if (!Number.isInteger(id) || id < 1) throw Object.assign(new Error("Invalid title"), {status:400, code:"INVALID_TITLE"});
  if (type === "movie") return `https://player.videasy.to/movie/${id}?overlay=true`;
  const season = Math.max(1, Number.parseInt(item?.season, 10) || 1);
  const episode = Math.max(1, Number.parseInt(item?.episode, 10) || 1);
  return `https://player.videasy.to/tv/${id}/${season}/${episode}?nextEpisode=true&autoplayNextEpisode=true&episodeSelector=true&overlay=true`;
}

async function handler(request, response) {
  if (request.method !== "POST") return send(response, 405, {error:"Method not allowed"});
  try {
    const {user} = await requireUser(request);
    const body = await readBody(request);
    let profile = await ensureProfile(user);
    const device = await registerDevice(user.id, body, request, response);
    let access = accessState(profile);
    const startingTrial = access.state === "eligible";
    if (access.state === "eligible") {
      profile = await startTrial(profile, device);
      access = accessState(profile);
      await recordAnalyticsEventSafe({
        event:"trial_started",
        visitorId:body.visitorId,
        userId:user.id,
        attribution:body.attribution,
        eventKey:`trial:${user.id}`
      });
    }
    if (access.state !== "trial" && access.state !== "active") {
      throw Object.assign(new Error("Your free trial has ended. Choose a payment method to continue."), {status:402, code:"PAYMENT_REQUIRED"});
    }
    const url = playerUrl(body.item);
    const contentKey = `${body.item?.type === "tv" ? "tv" : "movie"}:${Number(body.item?.id)}`;
    const watch = await beginWatchSession(user.id, device.id, contentKey);
    return send(response, 200, {url, sessionId:watch.id, access, trialStarted:startingTrial});
  } catch (error) {
    return handlerError(response, error);
  }
}

module.exports = handler;
module.exports.playerUrl = playerUrl;
