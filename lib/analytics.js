const crypto = require("crypto");
const {env, db, secureHash} = require("./server");

const ANALYTICS_EVENTS = new Set([
  "landing_view",
  "auth_started",
  "account_created",
  "login_completed",
  "trial_started",
  "checkout_started",
  "membership_activated",
  "renewal_paid",
  "payment_failed",
  "membership_cancelled",
  "membership_reversed"
]);

const BROWSER_EVENTS = new Set([
  "landing_view",
  "auth_started"
]);

const TEXT_PROPERTY_LIMITS = Object.freeze({
  plan:20,
  provider:24,
  auth_method:24,
  intent:24,
  currency:8,
  reason:40
});

function cleanText(value, maximum = 120) {
  return String(value || "").trim().slice(0, maximum);
}

function cleanPath(value) {
  const path = cleanText(value, 300);
  return path.startsWith("/") && !path.includes("?") && !path.includes("#") ? path : "/";
}

function cleanTouch(value) {
  const touch = value && typeof value === "object" ? value : {};
  return {
    source:cleanText(touch.source || "direct", 80).toLowerCase() || "direct",
    medium:cleanText(touch.medium, 80).toLowerCase(),
    campaign:cleanText(touch.campaign, 120),
    content:cleanText(touch.content, 120),
    term:cleanText(touch.term, 120),
    referrer:cleanText(touch.referrer, 160).toLowerCase(),
    landing_path:cleanPath(touch.landingPath || touch.landing_path)
  };
}

function cleanAttribution(value) {
  const attribution = value && typeof value === "object" ? value : {};
  return {
    first:cleanTouch(attribution.firstTouch || attribution.first),
    last:cleanTouch(attribution.lastTouch || attribution.last)
  };
}

function cleanProperties(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const result = {};
  for (const [key, maximum] of Object.entries(TEXT_PROPERTY_LIMITS)) {
    const cleaned = cleanText(source[key], maximum).toLowerCase();
    if (cleaned) result[key] = cleaned;
  }
  const amount = Number(source.amount);
  if (Number.isFinite(amount) && amount >= 0 && amount <= 1000000) result.amount = Math.round(amount * 100) / 100;
  return result;
}

function validVisitorId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function visitorHash(visitorId) {
  return validVisitorId(visitorId) ? secureHash(`analytics-visitor:${visitorId}`) : "";
}

function attributionProperties(attribution) {
  const result = {};
  for (const [prefix, touch] of [["first", attribution.first], ["last", attribution.last]]) {
    for (const [key, value] of Object.entries(touch || {})) {
      if (value) result[`${prefix}_${key}`] = value;
    }
  }
  return result;
}

function attributionFromRows(rows) {
  if (!rows?.length) return null;
  const chronological = [...rows].sort((left, right) => Date.parse(left.first_seen_at) - Date.parse(right.first_seen_at));
  const recent = [...rows].sort((left, right) => Date.parse(right.last_seen_at) - Date.parse(left.last_seen_at))[0];
  const first = chronological[0];
  return {
    visitorHash:recent.visitor_hash,
    attribution:{
      first:{
        source:first.first_source,
        medium:first.first_medium,
        campaign:first.first_campaign,
        content:first.first_content,
        term:first.first_term,
        referrer:first.first_referrer,
        landing_path:first.first_landing_path
      },
      last:{
        source:recent.last_source,
        medium:recent.last_medium,
        campaign:recent.last_campaign,
        content:recent.last_content,
        term:recent.last_term,
        referrer:recent.last_referrer,
        landing_path:recent.last_landing_path
      }
    }
  };
}

async function attributionForUser(userId) {
  if (!userId) return null;
  const rows = await db(`marketing_attribution?user_id=eq.${encodeURIComponent(userId)}&select=*&order=first_seen_at.asc&limit=20`, {prefer:""});
  return attributionFromRows(rows);
}

async function saveAttribution(hash, userId, attribution) {
  if (!hash) return;
  await db("rpc/record_marketing_attribution", {
    method:"POST",
    body:{p_visitor_hash:hash, p_user_id:userId || null, p_first:attribution.first, p_last:attribution.last},
    prefer:""
  });
}

function posthogHost() {
  const configured = env("POSTHOG_HOST", "https://us.i.posthog.com").replace(/\/$/, "");
  return ["https://us.i.posthog.com", "https://eu.i.posthog.com"].includes(configured) ? configured : "";
}

async function forwardToPostHog(event, distinctId, properties, timestamp) {
  const apiKey = env("POSTHOG_PROJECT_TOKEN");
  const host = posthogHost();
  if (!apiKey || !host) return false;
  const response = await fetch(`${host}/i/v0/e/`, {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      api_key:apiKey,
      event,
      distinct_id:distinctId,
      properties:{...properties, $process_person_profile:false},
      timestamp
    }),
    signal:AbortSignal.timeout(5000)
  });
  if (!response.ok) throw Object.assign(new Error(`PostHog capture failed (${response.status})`), {code:"POSTHOG_CAPTURE_FAILED"});
  return true;
}

async function recordAnalyticsEvent({event, visitorId = "", userId = "", attribution, properties, eventKey = ""}) {
  if (!ANALYTICS_EVENTS.has(event)) throw Object.assign(new Error("Unknown analytics event"), {status:400, code:"INVALID_ANALYTICS_EVENT"});
  let hash = visitorHash(visitorId);
  let cleanedAttribution = cleanAttribution(attribution);
  if (hash) {
    await saveAttribution(hash, userId, cleanedAttribution);
  } else if (userId) {
    const stored = await attributionForUser(userId);
    if (stored) {
      hash = stored.visitorHash;
      cleanedAttribution = stored.attribution;
    }
  }
  const key = cleanText(eventKey, 180) || crypto.randomUUID();
  const cleanedProperties = cleanProperties(properties);
  const timestamp = new Date().toISOString();
  const rows = await db("marketing_events?on_conflict=event_key", {
    method:"POST",
    body:{
      event_key:key,
      visitor_hash:hash || null,
      user_id:userId || null,
      name:event,
      properties:cleanedProperties,
      created_at:timestamp
    },
    prefer:"resolution=ignore-duplicates,return=representation"
  });
  if (!rows?.length) return {recorded:false, duplicate:true};
  const distinctId = hash ? `visitor:${hash}` : userId ? `user:${secureHash(`analytics-user:${userId}`)}` : `event:${secureHash(key)}`;
  await forwardToPostHog(event, distinctId, {...cleanedProperties, ...attributionProperties(cleanedAttribution)}, timestamp);
  return {recorded:true};
}

async function recordAnalyticsEventSafe(input) {
  try {
    return await recordAnalyticsEvent(input);
  } catch (error) {
    console.error("[sandboxed:analytics]", {event:input?.event, code:error?.code, message:error?.message});
    return {recorded:false, error:true};
  }
}

module.exports = {
  ANALYTICS_EVENTS,
  BROWSER_EVENTS,
  cleanTouch,
  cleanAttribution,
  cleanProperties,
  validVisitorId,
  visitorHash,
  attributionFromRows,
  posthogHost,
  recordAnalyticsEvent,
  recordAnalyticsEventSafe
};
