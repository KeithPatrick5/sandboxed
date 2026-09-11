const {
  send,
  readBody,
  bearerToken,
  supabaseAuth,
  rateLimit,
  handlerError
} = require("../lib/server");
const {BROWSER_EVENTS, validVisitorId, recordAnalyticsEvent} = require("../lib/analytics");

async function optionalUserId(request) {
  const token = bearerToken(request);
  if (!token) return "";
  try {
    const user = await supabaseAuth("/user", {token});
    return user?.id && user?.email_confirmed_at ? user.id : "";
  } catch {
    return "";
  }
}

module.exports = async function handler(request, response) {
  if (request.method !== "POST") return send(response, 405, {error:"Method not allowed"});
  try {
    rateLimit(request, "analytics", 30, 60);
    const body = await readBody(request);
    const event = String(body.event || "");
    if (!BROWSER_EVENTS.has(event)) return send(response, 400, {error:"Unknown analytics event", code:"INVALID_ANALYTICS_EVENT"});
    if (!validVisitorId(body.visitorId)) return send(response, 400, {error:"Invalid analytics visitor", code:"INVALID_ANALYTICS_VISITOR"});
    if (!validVisitorId(body.eventId)) return send(response, 400, {error:"Invalid analytics event ID", code:"INVALID_ANALYTICS_EVENT_ID"});
    const result = await recordAnalyticsEvent({
      event,
      visitorId:body.visitorId,
      userId:await optionalUserId(request),
      attribution:body.attribution,
      properties:body.properties,
      eventKey:`browser:${body.eventId}`
    });
    return send(response, 202, {accepted:Boolean(result.recorded || result.duplicate)});
  } catch (error) {
    return handlerError(response, error);
  }
};
