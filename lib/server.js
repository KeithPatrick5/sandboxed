const crypto = require("crypto");

const TRIAL_HOURS = 72;
const MAX_DEVICES = 4;
const MAX_STREAMS = 2;
const MAX_REPLACEMENTS_30_DAYS = 2;
const STREAM_TTL_SECONDS = 150;

function env(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

function membershipConfigured() {
  return Boolean(
    env("SUPABASE_URL") &&
    env("SUPABASE_PUBLISHABLE_KEY") &&
    env("SUPABASE_SECRET_KEY") &&
    env("DEVICE_HASH_SECRET") &&
    env("MEMBERSHIP_ENABLED", "true") !== "false"
  );
}

function send(response, status, payload) {
  response.status(status);
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  return response.end(JSON.stringify(payload));
}

async function readBody(request) {
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.body === "string") {
    try { return JSON.parse(request.body); } catch { return {}; }
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}

async function readRawBody(request) {
  if (Buffer.isBuffer(request.body)) return request.body.toString("utf8");
  if (typeof request.body === "string") return request.body;
  if (request.body && typeof request.body === "object") return JSON.stringify(request.body);
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function bearerToken(request) {
  const value = String(request.headers.authorization || "");
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

function clientIp(request) {
  return String(request.headers["x-forwarded-for"] || request.socket?.remoteAddress || "unknown")
    .split(",")[0]
    .trim();
}

function secureHash(value) {
  return crypto.createHmac("sha256", env("DEVICE_HASH_SECRET", "sandboxed-development-only"))
    .update(String(value || ""))
    .digest("hex");
}

function safeEqual(left, right) {
  const first = Buffer.from(String(left || ""));
  const second = Buffer.from(String(right || ""));
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

function baseUrl() {
  return env("SITE_URL", "https://sandboxed-tv.vercel.app").replace(/\/$/, "");
}

async function supabaseAuth(path, {method = "GET", token = "", body} = {}) {
  if (!membershipConfigured()) throw Object.assign(new Error("Membership is not configured"), {status:503, code:"NOT_CONFIGURED"});
  const response = await fetch(`${env("SUPABASE_URL").replace(/\/$/, "")}/auth/v1${path}`, {
    method,
    headers:{
      apikey:env("SUPABASE_PUBLISHABLE_KEY"),
      ...(token ? {Authorization:`Bearer ${token}`} : {}),
      ...(body ? {"Content-Type":"application/json"} : {})
    },
    ...(body ? {body:JSON.stringify(body)} : {}),
    signal:AbortSignal.timeout(10000)
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = {message:text}; }
  if (!response.ok) {
    const error = new Error(payload?.msg || payload?.message || payload?.error_description || "Authentication failed");
    error.status = response.status;
    error.code = payload?.error_code || payload?.code || "AUTH_ERROR";
    throw error;
  }
  return payload;
}

async function requireUser(request) {
  const token = bearerToken(request);
  if (!token) throw Object.assign(new Error("Sign in required"), {status:401, code:"AUTH_REQUIRED"});
  const user = await supabaseAuth("/user", {token});
  if (!user?.id) throw Object.assign(new Error("Invalid session"), {status:401, code:"INVALID_SESSION"});
  if (!user.email_confirmed_at) throw Object.assign(new Error("Verify your email before continuing"), {status:403, code:"EMAIL_NOT_VERIFIED"});
  return {user, token};
}

async function db(path, {method = "GET", body, prefer = "return=representation"} = {}) {
  if (!membershipConfigured()) throw Object.assign(new Error("Membership is not configured"), {status:503, code:"NOT_CONFIGURED"});
  const secret = env("SUPABASE_SECRET_KEY");
  const legacyServiceRole = !secret.startsWith("sb_secret_");
  const response = await fetch(`${env("SUPABASE_URL").replace(/\/$/, "")}/rest/v1/${path}`, {
    method,
    headers:{
      apikey:secret,
      ...(legacyServiceRole ? {Authorization:`Bearer ${secret}`} : {}),
      ...(body !== undefined ? {"Content-Type":"application/json"} : {}),
      ...(prefer ? {Prefer:prefer} : {})
    },
    ...(body !== undefined ? {body:JSON.stringify(body)} : {}),
    signal:AbortSignal.timeout(10000)
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) {
    const error = new Error(payload?.message || payload?.hint || `Database request failed (${response.status})`);
    error.status = 500;
    error.code = payload?.code || "DATABASE_ERROR";
    error.details = payload;
    throw error;
  }
  return payload;
}

async function ensureProfile(user) {
  const encoded = encodeURIComponent(user.id);
  let rows = await db(`profiles?id=eq.${encoded}&select=*`, {prefer:""});
  if (rows?.[0]) return rows[0];
  try {
    rows = await db("profiles", {
      method:"POST",
      body:{id:user.id, email:String(user.email || "").toLowerCase()},
      prefer:"return=representation"
    });
    return rows?.[0];
  } catch (error) {
    rows = await db(`profiles?id=eq.${encoded}&select=*`, {prefer:""});
    if (rows?.[0]) return rows[0];
    throw error;
  }
}

function accessState(profile) {
  const now = Date.now();
  const paidUntil = profile?.access_until ? Date.parse(profile.access_until) : 0;
  const trialEnd = profile?.trial_ends_at ? Date.parse(profile.trial_ends_at) : 0;
  if (paidUntil > now) return {state:"active", accessUntil:profile.access_until, trialEndsAt:profile.trial_ends_at};
  if (trialEnd > now) return {state:"trial", accessUntil:null, trialEndsAt:profile.trial_ends_at};
  if (profile?.trial_started_at) return {state:"expired", accessUntil:profile.access_until, trialEndsAt:profile.trial_ends_at};
  return {state:"eligible", accessUntil:profile?.access_until || null, trialEndsAt:null};
}

async function updateProfile(userId, fields) {
  const rows = await db(`profiles?id=eq.${encodeURIComponent(userId)}`, {
    method:"PATCH",
    body:{...fields, updated_at:new Date().toISOString()},
    prefer:"return=representation"
  });
  return rows?.[0];
}

function deviceInputs(body) {
  const deviceId = String(body?.deviceId || "").slice(0, 160);
  const fingerprint = String(body?.fingerprint || "").slice(0, 500);
  const deviceName = String(body?.deviceName || "Device").slice(0, 80);
  if (deviceId.length < 12 || fingerprint.length < 12) {
    throw Object.assign(new Error("This device could not be identified"), {status:400, code:"DEVICE_ID_REQUIRED"});
  }
  return {deviceId, fingerprint, deviceName};
}

async function registerDevice(userId, body, request) {
  const {deviceId, fingerprint, deviceName} = deviceInputs(body);
  const deviceKeyHash = secureHash(`device:${deviceId}`);
  const fingerprintHash = secureHash(`fingerprint:${fingerprint}`);
  const ipHash = secureHash(`ip:${clientIp(request)}`);
  const query = `devices?user_id=eq.${encodeURIComponent(userId)}&device_key_hash=eq.${deviceKeyHash}&select=*`;
  let rows = await db(query, {prefer:""});
  let device = rows?.[0];
  if (device) {
    if (device.revoked_at) {
      const active = await db(`devices?user_id=eq.${encodeURIComponent(userId)}&revoked_at=is.null&select=id`, {prefer:""});
      if ((active || []).length >= MAX_DEVICES) {
        throw Object.assign(new Error(`Your account already has ${MAX_DEVICES} active devices`), {status:409, code:"DEVICE_LIMIT"});
      }
    }
    rows = await db(`devices?id=eq.${device.id}`, {
      method:"PATCH",
      body:{name:deviceName, fingerprint_hash:fingerprintHash, last_ip_hash:ipHash, last_seen_at:new Date().toISOString(), revoked_at:null},
      prefer:"return=representation"
    });
    return {...rows[0], fingerprintHash, ipHash};
  }

  const active = await db(`devices?user_id=eq.${encodeURIComponent(userId)}&revoked_at=is.null&select=id`, {prefer:""});
  if ((active || []).length >= MAX_DEVICES) {
    throw Object.assign(new Error(`Your account already has ${MAX_DEVICES} active devices`), {status:409, code:"DEVICE_LIMIT"});
  }
  rows = await db("devices", {
    method:"POST",
    body:{user_id:userId, device_key_hash:deviceKeyHash, fingerprint_hash:fingerprintHash, name:deviceName, last_ip_hash:ipHash, last_seen_at:new Date().toISOString()},
    prefer:"return=representation"
  });
  return {...rows[0], fingerprintHash, ipHash};
}

async function listDevices(userId) {
  return db(`devices?user_id=eq.${encodeURIComponent(userId)}&revoked_at=is.null&select=id,name,created_at,last_seen_at&order=last_seen_at.desc`, {prefer:""});
}

async function revokeDevice(userId, deviceId) {
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  const recent = await db(`devices?user_id=eq.${encodeURIComponent(userId)}&revoked_at=gt.${encodeURIComponent(cutoff)}&select=id`, {prefer:""});
  if ((recent || []).length >= MAX_REPLACEMENTS_30_DAYS) {
    throw Object.assign(new Error("Two device replacements have already been used in the last 30 days"), {status:429, code:"REPLACEMENT_LIMIT"});
  }
  const rows = await db(`devices?id=eq.${encodeURIComponent(deviceId)}&user_id=eq.${encodeURIComponent(userId)}&revoked_at=is.null`, {
    method:"PATCH",
    body:{revoked_at:new Date().toISOString()},
    prefer:"return=representation"
  });
  if (!rows?.length) throw Object.assign(new Error("Device not found"), {status:404, code:"DEVICE_NOT_FOUND"});
  await db(`watch_sessions?user_id=eq.${encodeURIComponent(userId)}&device_id=eq.${encodeURIComponent(deviceId)}&ended_at=is.null`, {
    method:"PATCH",
    body:{ended_at:new Date().toISOString()},
    prefer:"return=minimal"
  });
}

async function startTrial(profile, device) {
  if (profile.trial_started_at) return profile;
  const sameFingerprint = await db(`trial_claims?fingerprint_hash=eq.${device.fingerprintHash}&select=user_id`, {prefer:""});
  if ((sameFingerprint || []).some((claim) => claim.user_id !== profile.id)) {
    throw Object.assign(new Error("The free trial has already been used on this device"), {status:402, code:"TRIAL_USED"});
  }
  const sameIp = await db(`trial_claims?ip_hash=eq.${device.ipHash}&select=id`, {prefer:""});
  if ((sameIp || []).length >= 3) {
    throw Object.assign(new Error("The free-trial limit has been reached on this network"), {status:402, code:"TRIAL_USED"});
  }
  const started = new Date();
  const ends = new Date(started.getTime() + TRIAL_HOURS * 3600000);
  try {
    await db("trial_claims", {
      method:"POST",
      body:{user_id:profile.id, fingerprint_hash:device.fingerprintHash, ip_hash:device.ipHash},
      prefer:"return=minimal"
    });
  } catch (error) {
    if (error.code === "23505") throw Object.assign(new Error("The free trial has already been used on this device"), {status:402, code:"TRIAL_USED"});
    throw error;
  }
  return updateProfile(profile.id, {trial_started_at:started.toISOString(), trial_ends_at:ends.toISOString()});
}

async function beginWatchSession(userId, deviceId, contentKey) {
  const cutoff = new Date(Date.now() - STREAM_TTL_SECONDS * 1000).toISOString();
  await db(`watch_sessions?user_id=eq.${encodeURIComponent(userId)}&ended_at=is.null&last_seen_at=lt.${encodeURIComponent(cutoff)}`, {
    method:"PATCH",
    body:{ended_at:new Date().toISOString()},
    prefer:"return=minimal"
  });
  await db(`watch_sessions?user_id=eq.${encodeURIComponent(userId)}&device_id=eq.${encodeURIComponent(deviceId)}&ended_at=is.null`, {
    method:"PATCH",
    body:{ended_at:new Date().toISOString()},
    prefer:"return=minimal"
  });
  const active = await db(`watch_sessions?user_id=eq.${encodeURIComponent(userId)}&ended_at=is.null&last_seen_at=gt.${encodeURIComponent(cutoff)}&select=id`, {prefer:""});
  if ((active || []).length >= MAX_STREAMS) {
    throw Object.assign(new Error(`This account already has ${MAX_STREAMS} active streams`), {status:409, code:"STREAM_LIMIT"});
  }
  const rows = await db("watch_sessions", {
    method:"POST",
    body:{user_id:userId, device_id:deviceId, content_key:String(contentKey).slice(0,120), last_seen_at:new Date().toISOString()},
    prefer:"return=representation"
  });
  return rows?.[0];
}

async function touchWatchSession(userId, sessionId, end = false) {
  const rows = await db(`watch_sessions?id=eq.${encodeURIComponent(sessionId)}&user_id=eq.${encodeURIComponent(userId)}&ended_at=is.null`, {
    method:"PATCH",
    body:end ? {ended_at:new Date().toISOString()} : {last_seen_at:new Date().toISOString()},
    prefer:"return=representation"
  });
  if (!rows?.length) throw Object.assign(new Error("Playback session expired"), {status:404, code:"SESSION_EXPIRED"});
  return rows[0];
}

async function extendAccess(userId, until, fields = {}) {
  const profileRows = await db(`profiles?id=eq.${encodeURIComponent(userId)}&select=*`, {prefer:""});
  if (!profileRows?.[0]) throw Object.assign(new Error("Membership profile not found"), {status:404, code:"PROFILE_NOT_FOUND"});
  const current = profileRows[0].access_until ? Date.parse(profileRows[0].access_until) : 0;
  const requested = until instanceof Date ? until.getTime() : Date.parse(until);
  const accessUntil = new Date(Math.max(current, requested || 0)).toISOString();
  return updateProfile(userId, {...fields, access_until:accessUntil});
}

function handlerError(response, error) {
  console.error("[sandboxed]", {code:error?.code, message:error?.message, details:error?.details});
  return send(response, Number(error?.status) || 500, {
    error:error?.message || "Unexpected server error",
    code:error?.code || "SERVER_ERROR"
  });
}

module.exports = {
  TRIAL_HOURS,
  MAX_DEVICES,
  MAX_STREAMS,
  MAX_REPLACEMENTS_30_DAYS,
  env,
  baseUrl,
  membershipConfigured,
  send,
  readBody,
  readRawBody,
  bearerToken,
  clientIp,
  secureHash,
  safeEqual,
  supabaseAuth,
  requireUser,
  db,
  ensureProfile,
  accessState,
  updateProfile,
  registerDevice,
  listDevices,
  revokeDevice,
  startTrial,
  beginWatchSession,
  touchWatchSession,
  extendAccess,
  handlerError
};
