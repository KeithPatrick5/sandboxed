const crypto = require("crypto");

const TRIAL_HOURS = 72;
const MAX_DEVICES = 4;
const MAX_STREAMS = 2;
const MAX_REPLACEMENTS_30_DAYS = 2;
const STREAM_TTL_SECONDS = 150;
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const rateBuckets = new Map();

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

async function readStream(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BODY_BYTES) {
      throw Object.assign(new Error("Request body is too large"), {status:413, code:"BODY_TOO_LARGE"});
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readBody(request) {
  if (Buffer.isBuffer(request.body)) {
    try { return JSON.parse(request.body.toString("utf8")); } catch { return {}; }
  }
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.body === "string") {
    try { return JSON.parse(request.body); } catch { return {}; }
  }
  const body = await readStream(request);
  if (!body.length) return {};
  try { return JSON.parse(body.toString("utf8")); } catch { return {}; }
}

async function readRawBody(request) {
  if (Buffer.isBuffer(request.body)) return request.body.toString("utf8");
  if (typeof request.body === "string") return request.body;
  if (request.body && typeof request.body === "object") return JSON.stringify(request.body);
  return (await readStream(request)).toString("utf8");
}

function bearerToken(request) {
  const value = String(request.headers.authorization || "");
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

function clientIp(request) {
  const forwarded = String(request.headers["x-forwarded-for"] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  // Namecheap's front proxy appends the address it received. Use the final hop
  // so a visitor cannot choose the value by sending their own X-Forwarded-For.
  return String(forwarded.at(-1) || request.socket?.remoteAddress || "unknown").slice(0, 80);
}

function rateLimit(request, name, limit, windowSeconds) {
  const now = Date.now();
  const windowMs = Math.max(1, Number(windowSeconds)) * 1000;
  const key = `${name}:${secureHash(`rate:${clientIp(request)}`)}`;
  const current = rateBuckets.get(key);
  if (!current || current.resetAt <= now) {
    rateBuckets.set(key, {count:1, resetAt:now + windowMs});
  } else {
    current.count += 1;
    if (current.count > limit) {
      const error = new Error("Too many attempts. Please wait and try again.");
      error.status = 429;
      error.code = "RATE_LIMITED";
      error.retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      throw error;
    }
  }
  if (rateBuckets.size > 5000) {
    for (const [bucketKey, bucket] of rateBuckets) {
      if (bucket.resetAt <= now) rateBuckets.delete(bucketKey);
    }
  }
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
  const fingerprintV2 = String(body?.fingerprintV2 || "").slice(0, 500);
  const deviceName = String(body?.deviceName || "Device").slice(0, 80);
  if (deviceId.length < 12 || fingerprint.length < 12) {
    throw Object.assign(new Error("This device could not be identified"), {status:400, code:"DEVICE_ID_REQUIRED"});
  }
  return {deviceId, fingerprint, fingerprintV2, deviceName};
}

async function registerDevice(userId, body, request) {
  const {deviceId, fingerprint, fingerprintV2, deviceName} = deviceInputs(body);
  const deviceKeyHash = secureHash(`device:${deviceId}`);
  const fingerprintHash = secureHash(`fingerprint:${fingerprint}`);
  const fingerprintV2Hash = fingerprintV2.length >= 12 ? secureHash(`fingerprint-v2:${fingerprintV2}`) : "";
  const ipHash = secureHash(`ip:${clientIp(request)}`);
  const deviceFields = {
    fingerprint_hash:fingerprintHash,
    ...(fingerprintV2Hash ? {fingerprint_v2_hash:fingerprintV2Hash} : {}),
    name:deviceName,
    last_ip_hash:ipHash,
    last_seen_at:new Date().toISOString()
  };
  const query = `devices?user_id=eq.${encodeURIComponent(userId)}&device_key_hash=eq.${deviceKeyHash}&select=*`;
  let rows = await db(query, {prefer:""});
  let device = rows?.[0];
  if (device) {
    if (device.revoked_at) {
      const active = await db(`devices?user_id=eq.${encodeURIComponent(userId)}&revoked_at=is.null&select=id`, {prefer:""});
      if ((active || []).length >= MAX_DEVICES) {
        throw Object.assign(new Error(`Your account already has ${MAX_DEVICES} active devices`), {status:409, code:"DEVICE_LIMIT"});
      }
      await db(`devices?id=eq.${encodeURIComponent(device.id)}&user_id=eq.${encodeURIComponent(userId)}`, {
        method:"PATCH",
        body:{device_key_hash:secureHash(`retired-device:${device.id}:${device.revoked_at}`)},
        prefer:"return=minimal"
      });
      rows = await db("devices", {
        method:"POST",
        body:{user_id:userId, device_key_hash:deviceKeyHash, ...deviceFields},
        prefer:"return=representation"
      });
      return {...rows[0], fingerprintHash, fingerprintV2Hash, ipHash};
    }
    rows = await db(`devices?id=eq.${device.id}`, {
      method:"PATCH",
      body:deviceFields,
      prefer:"return=representation"
    });
    return {...rows[0], fingerprintHash, fingerprintV2Hash, ipHash};
  }

  const active = await db(`devices?user_id=eq.${encodeURIComponent(userId)}&revoked_at=is.null&select=id`, {prefer:""});
  if ((active || []).length >= MAX_DEVICES) {
    throw Object.assign(new Error(`Your account already has ${MAX_DEVICES} active devices`), {status:409, code:"DEVICE_LIMIT"});
  }
  rows = await db("devices", {
    method:"POST",
    body:{user_id:userId, device_key_hash:deviceKeyHash, ...deviceFields},
    prefer:"return=representation"
  });
  return {...rows[0], fingerprintHash, fingerprintV2Hash, ipHash};
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
  if (device.fingerprintV2Hash) {
    const sameFingerprintV2 = await db(`trial_claims?fingerprint_v2_hash=eq.${device.fingerprintV2Hash}&select=user_id`, {prefer:""});
    if ((sameFingerprintV2 || []).some((claim) => claim.user_id !== profile.id)) {
      throw Object.assign(new Error("The free trial has already been used on this device"), {status:402, code:"TRIAL_USED"});
    }
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
      body:{
        user_id:profile.id,
        fingerprint_hash:device.fingerprintHash,
        ...(device.fingerprintV2Hash ? {fingerprint_v2_hash:device.fingerprintV2Hash} : {}),
        ip_hash:device.ipHash
      },
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
  console.error("[sandboxed]", {code:error?.code, message:error?.message, details:gn¼öÚ$z{-®éÜj×¹Ñ½UÁÁ•É…Í” ¤€è€‰Lˆì(€€€…½Õ¹Ñ	ÕÑÑ½¸¹Í•ÑÑÑÉ¥‰ÕÑ” ‰…É¥„µ±…‰•°ˆ°…½Õ¹Ð€ü€‰=Á•¸…½Õ¹Ðˆ€è€‰M¥¸¥¸ˆ¤ì(€ô((€™Õ¹Ñ¥½¸½Á•¹5½‘…°¡Ù¥•Ü€ô€‰…½Õ¹Ðˆ°µ•ÍÍ…”€ô€ˆˆ¤ì(€€€É•ÑÕÉ¹½ÕÌ€ô‘½Õµ•¹Ð¹…Ñ¥Ù•±•µ•¹Ðì(€€€µ½‘…°¹¡¥‘‘•¸€ô™…±Í”ì(€€€‘½Õµ•¹Ð¹‰½‘ä¹ÍÑå±”¹½Ù•É™±½Ü€ô€‰¡¥‘‘•¸ˆì(€€€¥˜€¡Ù¥•Ü€ôôô€‰Í¥¹ÕÀˆñðÙ¥•Ü€ôôô€‰±½¥¸ˆ¤É•¹‘•ÉÕÑ ¡Ù¥•Ü°µ•ÍÍ…”¤ì(€€€•±Í”¥˜€¡Ù¥•Ü€ôôô€‰Ù•É¥™äˆ¤É•¹‘•ÉY•É¥™ä¡µ•ÍÍ…”¤ì(€€€•±Í”¥˜€¡Ù¥•Ü€ôôô€‰™½É½Ðˆ¤É•¹‘•É½É½Ð¡µ•ÍÍ…”¤ì(€€€•±Í”¥˜€¡Ù¥•Ü€ôôô€‰É•½Ù•Éäˆ¤É•¹‘•ÉI•½Ù•Éä¡µ•ÍÍ…”¤ì(€€€•±Í”¥˜€¡Ù¥•Ü€ôôô€‰Á…åÝ…±°ˆ¤É•¹‘•ÉA…åÝ…±°¡µ•ÍÍ…”¤ì(€€€•±Í”¥˜€¡Ù¥•Ü€ôôô€‰‘•Ù¥”µ±¥µ¥Ðˆ¤É•¹‘•É•Ù¥•1¥µ¥Ð¡µ•ÍÍ…”¤ì(€€€•±Í”¥˜€¡Ù¥•Ü€ôôô€‰Í•ÑÕÀˆ¤É•¹‘•ÉM•ÑÕÀ ¤ì(€€€•±Í”¥˜€¡…½Õ¹Ð¤É•¹‘•É½Õ¹Ð¡µ•ÍÍ…”¤ì(€€€•±Í”¥˜€¡½¹™¥œ¹µ•µ‰•ÉÍ¡¥Á¹…‰±•¤É•¹‘•ÉÕÑ  ‰±½¥¸ˆ°µ•ÍÍ…”¤ì(€€€•±Í”É•¹‘•ÉM•ÑÕÀ ¤ì(€€€Í•ÑQ¥µ•½ÕÐ  ¤€ôø½¹Ñ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È ‰¥¹ÁÕÐ°‰ÕÑÑ½¸°„ˆ¤ü¹™½ÕÌ ¤°€À¤ì(€ô((€™Õ¹Ñ¥½¸±½Í•5½‘…° ¤ì(€€€µ½‘…°¹¡¥‘‘•¸€ôÑÉÕ”ì(€€€‘½Õµ•¹Ð¹‰½‘ä¹ÍÑå±”¹½Ù•É™±½Ü€ô‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È ˆÁ±…å•Èµµ½‘…°ˆ¤ü¹¡¥‘‘•¸€ôôô™…±Í”€ü€‰¡¥‘‘•¸ˆ€è€ˆˆì(€€€É•ÑÕÉ¹½ÕÌü¹™½ÕÌü¸ ¤ì(€ô((€™Õ¹Ñ¥½¸Á…¹•±!•…‘•È¡•å•‰É½Ü°Ñ¥Ñ±”°½Áä€ô€ˆˆ¤ì(€€€É•ÑÕÉ¸€ñÀ±…ÍÌô‰µ•µ‰•ÉÍ¡¥Àµ•å•‰É½Üˆø‘í•Í…Á•!Ñµ°¡•å•‰É½Ü¥ôð½Àøñ Èø‘í•Í…Á•!Ñµ°¡Ñ¥Ñ±”¥ôð½ Èø‘í½Áä€ü€ñÀ±…ÍÌô‰µ•µ‰•ÉÍ¡¥Àµ½Áäˆø‘í•Í…Á•!Ñµ°¡½Áä¥ôð½Àù€€è€ˆ‰õ€ì(€ô((€™Õ¹Ñ¥½¸Í•Ñ5•ÍÍ…”¡µ•ÍÍ…”°•ÉÉ½È€ô™…±Í”¤ì(€€€½¹ÍÐÑ…É•Ð€ô½¹Ñ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È ˆµ•µ‰•ÉÍ¡¥Àµµ•ÍÍ…”ˆ¤ì(€€€¥˜€ …Ñ…É•Ð¤É•ÑÕÉ¸ì(€€€Ñ…É•Ð¹Ñ•áÑ½¹Ñ•¹Ð€ôµ•ÍÍ…”ñð€ˆˆì(€€€Ñ…É•Ð¹±…ÍÍ1¥ÍÐ¹Ñ½±” ‰¥Ìµ•ÉÉ½Èˆ°•ÉÉ½È¤ì(€ô((€™Õ¹Ñ¥½¸É•¹‘•ÉM•ÑÕÀ ¤ì(€€€½¹Ñ•¹Ð¹¥¹¹•É!Q50€ô€‘íÁ…¹•±!•…‘•È ‰MIY%U9Y%1	1ˆ°€‰A±…å‰…¬¥ÌÑ•µÁ½É…É¥±äÕ¹…Ù…¥±…‰±”ˆ°€‰Q¡”…½Õ¹ÐÍ•ÉÙ¥”½Õ±¹½Ð‰”É•…¡•¸A±•…Í”É•±½……¹ÑÉä……¥¸¸ˆ¥ôñÀ±…ÍÌô‰µ•µ‰•ÉÍ¡¥Àµµ•ÍÍ…”ˆù•ÍÌÉ•µ…¥¹Ì±½­•Õ¹Ñ¥°å½ÕÈ…½Õ¹Ð…¸‰”Ù•É¥™¥•¸ð½Àù€ì(€ô((€™Õ¹Ñ¥½¸É•¹‘•ÉÕÑ ¡µ½‘”°µ•ÍÍ…”€ô€ˆˆ¤ì(€€€½¹ÍÐÍ¥¹ÕÀ€ôµ½‘”€ôôô€‰Í¥¹ÕÀˆì(€€€½¹Ñ•¹Ð¹¥¹¹•É!Q50€ô€‘íÁ…¹•±!•…‘•È¡Í¥¹ÕÀ€ü€‰MQIPIˆ€è€‰]1=5	,ˆ°Í¥¹ÕÀ€ü€‰QÉäM…¹‘‰½á•™½ÈÑ¡É•”‘…åÌˆ€è€‰M¥¸¥¸Ñ¼M…¹‘‰½á•ˆ°Í¥¹ÕÀ€ü€‰9¼…ÉÉ•ÅÕ¥É•¸e½ÕÈÑÉ¥…°‰•¥¹ÌÝ¡•¸å½ÕÈ™¥ÉÍÐÙ¥‘•¼ÍÑ…ÉÑÌ¸ˆ€è€‰½¹Ñ¥¹Õ”å½ÕÈÑÉ¥…°½Èµ•µ‰•ÉÍ¡¥À½¸Ñ¡¥Ì‘•Ù¥”¸ˆ¥ô(€€€€€€ñ‘¥Ø±…ÍÌô‰…ÕÑ µÍÝ¥Ñ ˆøñ‰ÕÑÑ½¸ÑåÁ”ô‰‰ÕÑÑ½¸ˆ‘…Ñ„µ…ÕÑ µÙ¥•Üô‰±½¥¸ˆ±…ÍÌôˆ‘íÍ¥¹ÕÀ€ü€ˆˆ€è€‰…Ñ¥Ù”‰ôˆùM¥¸¥¸ð½‰ÕÑÑ½¸øñ‰ÕÑÑ½¸ÑåÁ”ô‰‰ÕÑÑ½¸ˆ‘…Ñ„µ…ÕÑ µÙ¥•Üô‰Í¥¹ÕÀˆ±…ÍÌôˆ‘íÍ¥¹ÕÀ€ü€‰…Ñ¥Ù”ˆ€è€ˆ‰ôˆùÉ•…Ñ”…½Õ¹Ðð½‰ÕÑÑ½¸øð½‘¥Øø(€€€€€€ñ™½É´±…ÍÌô‰µ•µ‰•ÉÍ¡¥Àµ™½É´ˆ¥ô‰µ•µ‰•ÉÍ¡¥Àµ…ÕÑ µ™½É´ˆ…ÕÑ½½µÁ±•Ñ”ô‰½¸ˆø(€€€€€€€€ñ±…‰•°™½Èô‰µ•µ‰•ÉÍ¡¥Àµ•µ…¥°ˆùµ…¥°ñ¥¹ÁÕÐ¥ô‰µ•µ‰•ÉÍ¡¥Àµ•µ…¥°ˆÑåÁ”ô‰•µ…¥°ˆ¹…µ”ô‰•µ…¥°ˆ…ÕÑ½½µÁ±•Ñ”ô‰ÕÍ•É¹…µ”ˆ¥¹ÁÕÑµ½‘”ô‰•µ…¥°ˆ…ÕÑ½…Á¥Ñ…±¥é”ô‰¹½¹”ˆÍÁ•±±¡•¬ô‰™…±Í”ˆÉ•ÅÕ¥É•øð½±…‰•°ø(€€€€€€€€ñ±…‰•°™½Èô‰µ•µ‰•ÉÍ¡¥ÀµÁ…ÍÍÝ½ÉˆùA…ÍÍÝ½Éñ¥¹ÁÕÐ¥ô‰µ•µ‰•ÉÍ¡¥ÀµÁ…ÍÍÝ½ÉˆÑåÁ”ô‰Á…ÍÍÝ½Éˆ¹…µ”ô‰Á…ÍÍÝ½Éˆ…ÕÑ½½µÁ±•Ñ”ôˆ‘íÍ¥¹ÕÀ€ü€‰¹•ÜµÁ…ÍÍÝ½Éˆ€è€‰ÕÉÉ•¹ÐµÁ…ÍÍÝ½É‰ôˆµ¥¹±•¹Ñ ôˆàˆµ…á±•¹Ñ ôˆÄÈàˆÉ•ÅÕ¥É•øð½±…‰•°ø(€€€€€€€€‘íÍ¥¹ÕÀ€ü€œñ±…‰•°™½Èô‰µ•µ‰•ÉÍ¡¥ÀµÁ…ÍÍÝ½Éµ½¹™¥É´ˆù½¹™¥É´Á…ÍÍÝ½Éñ¥¹ÁÕÐ¥ô‰µ•µ‰•ÉÍ¡¥ÀµÁ…ÍÍÝ½Éµ½¹™¥É´ˆÑåÁ”ô‰Á…ÍÍÝ½Éˆ¹…µ”ô‰½¹™¥ÉµA…ÍÍÝ½Éˆ…ÕÑ½½µÁ±•Ñ”ô‰¹•ÜµÁ…ÍÍÝ½Éˆµ¥¹±•¹Ñ ôˆàˆµ…á±•¹Ñ ôˆÄÈàˆÉ•ÅÕ¥É•øð½±…‰•°øñÀ±…ÍÌô‰µ•µ‰•ÉÍ¡¥Àµ™¥•±µ¡¥¹ÐˆùUÍ”…Ð±•…ÍÐ€à¡…É…Ñ•ÉÌ¸e½ÕÈ‰É½ÝÍ•È…¸Í…Ù”Ñ¡¥Ì±½¥¸¸ð½Àøœ€è€ˆ‰ô(€€€€€€€€ñ‰ÕÑÑ½¸±…ÍÌô‰µ•µ‰•ÉÍ¡¥ÀµÁÉ¥µ…ÉäˆÑåÁ”ô‰ÍÕ‰µ¥Ðˆø‘íÍ¥¹ÕÀ€ü€‰É•…Ñ”…½Õ¹Ðˆ€è€‰M¥¸¥¸‰ôð½‰ÕÑÑ½¸ø(€€€€€€ð½™½É´ø(€€€€€€‘íÍ¥¹ÕÀ€ü€ˆˆ€è€œñ‰ÕÑÑ½¸±…ÍÌô‰µ•µ‰•ÉÍ¡¥ÀµÑ•áÐµ‰ÕÑÑ½¸ˆÑåÁ”ô‰‰ÕÑÑ½¸ˆ¥ô‰™½É½ÐµÁ…ÍÍÝ½Éˆù½É½ÐÁ…ÍÍÝ½Éüð½‰ÕÑÑ½¸øô(€€€€€€ñÀ±…ÍÌô‰µ•µ‰•ÉÍ¡¥Àµ±•…°ˆù	ä½¹Ñ¥¹Õ¥¹œ°å½Ô…É•”Ñ¼Ñ¡”€ñ„¡É•˜ôˆ½Ñ•ÉµÌˆÑ…É•Ðô‰}‰±…¹¬ˆÉ•°ô‰¹½½Á•¹•ÈˆùM…¹‘‰½á•Ñ•ÉµÌð½„ø…¹€ñ„¡É•˜ôˆ½ÁÉ¥Ù…äˆÑ…É•Ðô‰}‰±…¹¬ˆÉ•°ô‰¹½½Á•¹•ÈˆùÁÉ¥Ù…ä¹½Ñ¥”ð½„ø¸ð½Àø(€€€€€€ñÀ±…ÍÌô‰µ•µ‰•ÉÍ¡¥Àµµ•ÍÍ…”ˆ¥ô‰µ•µ‰•ÉÍ¡¥Àµµ•ÍÍ…”ˆøð½Àù€ì(€€€½¹Ñ•¹Ð¹ÅÕ•ÉåM•±•Ñ½É±° ‰m‘…Ñ„µ…ÕÑ µÙ¥•Ýtˆ¤¹™½É…  ¡‰ÕÑÑ½¸¤€ôø‰ÕÑÑ½¸¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôøÉ•¹‘•ÉÕÑ ¡‰ÕÑÑ½¸¹‘…Ñ…Í•Ð¹…ÕÑ¡Y¥•Ü¤¤¤ì(€€€½¹Ñ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È ˆ™½É½ÐµÁ…ÍÍÝ½Éˆ¤ü¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôøÉ•¹‘•É½É½Ð ¤¤ì(€€€½¹Ñ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È ˆµ•µ‰•ÉÍ¡¥Àµ…ÕÑ µ™½É´ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰ÍÕ‰µ¥Ðˆ°…Íå¹Œ€¡•Ù•¹Ð¤€ôøì(€€€€€•Ù•¹Ð¹ÁÉ•Ù•¹Ñ•™…Õ±Ð ¤ì(€€€€€½¹ÍÐ™½É´€ô¹•Ü½Éµ…Ñ„¡•Ù•¹Ð¹ÕÉÉ•¹ÑQ…É•Ð¤ì(€€€€€½¹ÍÐÍÕ‰µ¥Ð€ô•Ù•¹Ð¹ÕÉÉ•¹ÑQ…É•Ð¹ÅÕ•ÉåM•±•Ñ½È ‰‰ÕÑÑ½¹mÑåÁ”õÍÕ‰µ¥Ñtˆ¤ì(€€€€€½¹ÍÐÁ…ÍÍÝ½É€ôMÑÉ¥¹œ¡™½É´¹•Ð ‰Á…ÍÍÝ½Éˆ¤ñð€ˆˆ¤ì(€€€€€½¹ÍÐ½¹™¥ÉµA…ÍÍÝ½É€ôMÑÉ¥¹œ¡™½É´¹•Ð ‰½¹™¥ÉµA…ÍÍÝ½Éˆ¤ñð€ˆˆ¤ì(€€€€€¥˜€¡Í¥¹ÕÀ€˜˜Á…ÍÍÝ½É€„ôô½¹™¥ÉµA…ÍÍÝ½É¤ì(€€€€€€€½¹ÍÐ½¹™¥Éµ%¹ÁÕÐ€ô•Ù•¹Ð¹ÕÉÉ•¹ÑQ…É•Ð¹•±•µ•¹ÑÌ¹½¹™¥ÉµA…ÍÍÝ½Éì(€€€€€€€½¹™¥Éµ%¹ÁÕÐ¹Í•ÑÕÍÑ½µY…±¥‘¥Ñä ‰A…ÍÍÝ½É‘Ì‘¼¹½Ðµ…Ñ ˆ¤ì(€€€€€€€½¹™¥Éµ%¹ÁÕÐ¹É•Á½ÉÑY…±¥‘¥Ñä ¤ì(€€€€€€€½¹™¥Éµ%¹ÁÕÐ¹™½ÕÌ ¤ì(€€€€€€€Í•Ñ5•ÍÍ…” ‰A…ÍÍÝ½É‘Ì‘¼¹½Ðµ…Ñ ¸ˆ°ÑÉÕ”¤ì(€€€€€€€É•ÑÕÉ¸ì(€€€€€ô(€€€€€ÍÕ‰µ¥Ð¹‘¥Í…‰±•€ôÑÉÕ”ì(€€€€€Í•Ñ5•ÍÍ…”¡Í¥¹ÕÀ€ü€‰É•…Ñ¥¹œå½ÕÈ…½Õ¹ÓŠ˜ˆ€è€‰M¥¹¥¹œ¥»Š˜ˆ¤ì(€€€€€ÑÉäì(€€€€€€€½¹ÍÐÁ…å±½…€ô…Ý…¥Ð…ÕÑ¡I•ÅÕ•ÍÐ¡í…Ñ¥½¸éÍ¥¹ÕÀ€ü€‰Í¥¹ÕÀˆ€è€‰±½¥¸ˆ°•µ…¥°é™½É´¹•Ð ‰•µ…¥°ˆ¤°Á…ÍÍÝ½É‘ô¤ì(€€€€€€€¥˜€¡Á…å±½…¹½¹™¥Éµ…Ñ¥½¹I•ÅÕ¥É•¤É•ÑÕÉ¸É•¹‘•ÉY•É¥™ä ‰¡•¬å½ÕÈ•µ…¥°…¹Ñ…ÀÑ¡”Ù•É¥™¥…Ñ¥½¸±¥¹¬°Ñ¡•¸É•ÑÕÉ¸¡•É”Ñ¼Í¥¸¥¸¸ˆ¤ì(€€€€€€€½¹ÍÐ¹•áÐ€ô¹½Éµ…±¥é•M•ÍÍ¥½¸¡Á…å±½…¹Í•ÍÍ¥½¸¤ì(€€€€€€€Í…Ù•M•ÍÍ¥½¸¡¹•áÐ¤ì(€€€€€€€…Ý…¥ÐÉ•™É•Í¡½Õ¹Ð ¤ì(€€€€€€€±½Í•5½‘…° ¤ì(€€€€€€€¥˜€¡Á•¹‘¥¹A±…ä¤ì(€€€€€€€€€½¹ÍÐ¥Ñ•´€ôÁ•¹‘¥¹A±…äì(€€€€€€€€€Á•¹‘¥¹A±…ä€ô¹Õ±°ì(€€€€€€€€€Ý¥¹‘½Ü¹‘¥ÍÁ…Ñ¡Ù•¹Ð¡¹•ÜÕÍÑ½µÙ•¹Ð ‰Í…¹‘‰½á•éÉ•ÍÕµ”µÁ±…äˆ°í‘•Ñ…¥°é¥Ñ•µô¤¤ì(€€€€€€€ô(€€€€€ô…Ñ €¡•ÉÉ½È¤ì(€€€€€€€Í•Ñ5•ÍÍ…”¡•ÉÉ½È¹µ•ÍÍ…”°ÑÉÕ”¤ì(€€€€€€€ÍÕ‰µ¥Ð¹‘¥Í…‰±•€ô™…±Í”ì(€€€€€ô(€€€ô¤ì(€€€½¹Ñ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È m¹…µ”ô‰½¹™¥ÉµA…ÍÍÝ½É‰tœ¤ü¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰¥¹ÁÕÐˆ°€¡•Ù•¹Ð¤€ôø•Ù•¹Ð¹ÕÉÉ•¹ÑQ…É•Ð¹Í•ÑÕÍÑ½µY…±¥‘¥Ñä ˆˆ¤¤ì(€€€¥˜€¡µ•ÍÍ…”¤Í•Ñ5•ÍÍ…”¡µ•ÍÍ…”°ÑÉÕ”¤ì(€ô((€™Õ¹Ñ¥½¸É•¹‘•ÉY•É¥™ä¡µ•ÍÍ…”¤ì(€€€½¹Ñ•¹Ð¹¥¹¹•É!Q50€ô€‘íÁ…¹•±!•…‘•È ‰!,e=UH5%0ˆ°€‰Y•É¥™äå½ÕÈ…½Õ¹Ðˆ°µ•ÍÍ…”ñð€‰Q…ÀÑ¡”Ù•É¥™¥…Ñ¥½¸±¥¹¬Ý”Í•¹Ð°Ñ¡•¸½µ”‰…¬…¹Í¥¸¥¸¸ˆ¥ôñ‰ÕÑÑ½¸±…ÍÌô‰µ•µ‰•ÉÍ¡¥ÀµÁÉ¥µ…ÉäˆÑåÁ”ô‰‰ÕÑÑ½¸ˆ¥ô‰‰…¬µÑ¼µ±½¥¸ˆù	…¬Ñ¼Í¥¸¥¸ð½‰ÕÑÑ½¸øñÀ±…ÍÌô‰µ•µ‰•ÉÍ¡¥Àµµ•ÍÍ…”ˆ¥ô‰µ•µ‰•ÉÍ¡¥Àµµ•ÍÍ…”ˆøð½Àù€ì(€€€½¹Ñ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È ˆ‰…¬µÑ¼µ±½¥¸ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôøÉ•¹‘•ÉÕÑ  ‰±½¥¸ˆ¤¤ì(€ô((€™Õ¹Ñ¥½¸É•¹‘•É½É½Ð¡µ•ÍÍ…”€ô€ˆˆ¤ì(€€€½¹Ñ•¹Ð¹¥¹¹•É!Q50€ô€‘íÁ…¹•±!•…‘•È ‰AMM]=IIMPˆ°€‰I•Í•Ðå½ÕÈÁ…ÍÍÝ½Éˆ°€‰]”Ý¥±°•µ…¥°å½Ô„Í•ÕÉ”É•½Ù•Éä±¥¹¬¸ˆ¥ô(€€€€€€ñ™½É´±…ÍÌô‰µ•µ‰•ÉÍ¡¥Àµ™½É´ˆ¥ô‰É•½Ù•Éäµ•µ…¥°µ™½É´ˆøñ±…‰•°ùµ…¥°ñ¥¹ÁÕÐÑåÁ”ô‰•µ…¥°ˆ¹…µ”ô‰•µ…¥°ˆ…ÕÑ½½µÁ±•Ñ”ô‰•µ…¥°ˆÉ•ÅÕ¥É•øð½±…‰•°øñ‰ÕÑÑ½¸±…ÍÌô‰µ•µ‰•ÉÍ¡¥ÀµÁÉ¥µ…ÉäˆÑåÁ”ô‰ÍÕ‰µ¥ÐˆùM•¹É•½Ù•Éä±¥¹¬ð½‰ÕÑÑ½¸øð½™½É´ø(€€€€€€ñ‰ÕÑÑ½¸±…ÍÌô‰µ•µ‰•ÉÍ¡¥ÀµÑ•áÐµ‰ÕÑÑ½¸ˆÑåÁ”ô‰‰ÕÑÑ½¸ˆ¥ô‰‰…¬µÑ¼µ±½¥¸ˆù	…¬Ñ¼Í¥¸¥¸ð½‰ÕÑÑ½¸øñÀ±…ÍÌô‰µ•µ‰•ÉÍ¡¥Àµµ•ÍÍ…”ˆ¥ô‰µ•µ‰•ÉÍ¡¥Àµµ•ÍÍ…”ˆøð½Àù€ì(€€€½¹Ñ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È ˆ‰…¬µÑ¼µ±½¥¸ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôøÉ•¹‘•ÉÕÑ  ‰±½¥¸ˆ¤¤ì(€€€½¹Ñ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È ˆÉ•½Ù•Éäµ•µ…¥°µ™½É´ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰ÍÕ‰µ¥Ðˆ°…Íå¹Œ€¡•Ù•¹Ð¤€ôøì(€€€€€•Ù•¹Ð¹ÁÉ•Ù•¹Ñ•™…Õ±Ð ¤ì(€€€€€½¹ÍÐÍÕ‰µ¥Ð€ô•Ù•¹Ð¹ÕÉÉ•¹ÑQ…É•Ð¹ÅÕ•ÉåM•±•Ñ½È ‰‰ÕÑÑ½¹mÑåÁ”õÍÕ‰µ¥Ñtˆ¤ì(€€€€€ÍÕ‰µ¥Ð¹‘¥Í…‰±•€ôÑÉÕ”ì(€€€€€ÑÉäì(€€€€€€€…Ý…¥Ð…ÕÑ¡I•ÅÕ•ÍÐ¡í…Ñ¥½¸è‰É•½Ù•Èˆ°•µ…¥°é¹•Ü½Éµ…Ñ„¡•Ù•¹Ð¹ÕÉÉ•¹ÑQ…É•Ð¤¹•Ð ‰•µ…¥°ˆ¥ô¤ì(€€€€€€€Í•Ñ5•ÍÍ…” ‰I•½Ù•Éä±¥¹¬Í•¹Ð¸¡•¬å½ÕÈ•µ…¥°¸ˆ¤ì(€€€€€ô…Ñ €¡•ÉÉ½È¤ì(€€€€€€€Í•Ñ5•ÍÍ…”¡•ÉÉ½È¹µ•ÍÍ…”°ÑÉÕ”¤ì(€€€€€€€ÍÕ‰µ¥Ð¹‘¥Í…‰±•€ô™…±Í”ì(€€€€€ô(€€€ô¤ì(€€€¥˜€¡µ•ÍÍ…”¤Í•Ñ5•ÍÍ…”¡µ•ÍÍ…”°ÑÉÕ”¤ì(€ô((€™Õ¹Ñ¥½¸É•¹‘•ÉI•½Ù•Éä¡µ•ÍÍ…”€ô€ˆˆ¤ì(€€€½¹Ñ•¹Ð¹¥¹¹•É!Q50€ô€‘íÁ…¹•±!•…‘•È ‰9\AMM]=Iˆ°€‰¡½½Í”„¹•ÜÁ…ÍÍÝ½Éˆ°€‰UÍ”…Ð±•…ÍÐ•¥¡Ð¡…É…Ñ•ÉÌ¸ˆ¥ô(€€€€€€ñ™½É´±…ÍÌô‰µ•µ‰•ÉÍ¡¥Àµ™½É´ˆ¥ô‰¹•ÜµÁ…ÍÍÝ½Éµ™½É´ˆ…ÕÑ½½µÁ±•Ñ”ô‰½¸ˆø(€€€€€€€€ñ±…‰•°™½Èô‰É•½Ù•ÉäµÁ…ÍÍÝ½Éˆù9•ÜÁ…ÍÍÝ½Éñ¥¹ÁÕÐ¥ô‰É•½Ù•ÉäµÁ…ÍÍÝ½ÉˆÑåÁ”ô‰Á…ÍÍÝ½Éˆ¹…µ”ô‰Á…ÍÍÝ½Éˆ…ÕÑ½½µÁ±•Ñ”ô‰¹•ÜµÁ…ÍÍÝ½Éˆµ¥¹±•¹Ñ ôˆàˆµ…á±•¹Ñ ôˆÄÈàˆÉ•ÅÕ¥É•øð½±…‰•°ø(€€€€€€€€ñ±…‰•°™½Èô‰É•½Ù•ÉäµÁ…ÍÍÝ½Éµ½¹™¥É´ˆù½¹™¥É´¹•ÜÁ…ÍÍÝ½Éñ¥¹ÁÕÐ¥ô‰É•½Ù•ÉäµÁ…ÍÍÝ½Éµ½¹™¥É´ˆÑåÁ”ô‰Á…ÍÍÝ½Éˆ¹…µ”ô‰½¹™¥ÉµA…ÍÍÝ½Éˆ…ÕÑ½½µÁ±•Ñ”ô‰¹•ÜµÁ…ÍÍÝ½Éˆµ¥¹±•¹Ñ ôˆàˆµ…á±•¹Ñ ôˆÄÈàˆÉ•ÅÕ¥É•øð½±…‰•°ø(€€€€€€€€ñ‰ÕÑÑ½¸±…ÍÌô‰µ•µ‰•ÉÍ¡¥ÀµÁÉ¥µ…ÉäˆÑåÁ”ô‰ÍÕ‰µ¥ÐˆùUÁ‘…Ñ”Á…ÍÍÝ½Éð½‰ÕÑÑ½¸ø(€€€€€€ð½™½É´ø(€€€€€€ñÀ±…ÍÌô‰µ•µ‰•ÉÍ¡¥Àµµ•ÍÍ…”ˆ¥ô‰µ•µ‰•ÉÍ¡¥Àµµ•ÍÍ…”ˆøð½Àù€ì(€€€½¹Ñ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È ˆ¹•ÜµÁ…ÍÍÝ½Éµ™½É´ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰ÍÕ‰µ¥Ðˆ°…Íå¹Œ€¡•Ù•¹Ð¤€ôøì(€€€€€•Ù•¹Ð¹ÁÉ•Ù•¹Ñ•™…Õ±Ð ¤ì(€€€€€½¹ÍÐ™½É´€ô¹•Ü½Éµ…Ñ„¡•Ù•¹Ð¹ÕÉÉ•¹ÑQ…É•Ð¤ì(€€€€€½¹ÍÐÍÕ‰µ¥Ð€ô•Ù•¹Ð¹ÕÉÉ•¹ÑQ…É•Ð¹ÅÕ•ÉåM•±•Ñ½È ‰‰ÕÑÑ½¹mÑåÁ”õÍÕ‰µ¥Ñtˆ¤ì(€€€€€½¹ÍÐÁ…ÍÍÝ½É€ôMÑÉ¥¹œ¡™½É´¹•Ð ‰Á…ÍÍÝ½Éˆ¤ñð€ˆˆ¤ì(€€€€€½¹ÍÐ½¹™¥ÉµA…ÍÍÝ½É€ôMÑÉ¥¹œ¡™½É´¹•Ð ‰½¹™¥ÉµA…ÍÍÝ½Éˆ¤ñð€ˆˆ¤ì(€€€€€¥˜€¡Á…ÍÍÝ½É€„ôô½¹™¥ÉµA…ÍÍÝ½É¤ì(€€€€€€€½¹ÍÐ½¹™¥Éµ%¹ÁÕÐ€ô•Ù•¹Ð¹ÕÉÉ•¹ÑQ…É•Ð¹•±•µ•¹ÑÌ¹½¹™¥ÉµA…ÍÍÝ½Éì(€€€€€€€½¹™¥Éµ%¹ÁÕÐ¹Í•ÑÕÍÑ½µY…±¥‘¥Ñä ‰A…ÍÍÝ½É‘Ì‘¼¹½Ðµ…Ñ ˆ¤ì(€€€€€€€½¹™¥Éµ%¹ÁÕÐ¹É•Á½ÉÑY…±¥‘¥Ñä ¤ì(€€€€€€€½¹™¥Éµ%¹ÁÕÐ¹™½ÕÌ ¤ì(€€€€€€€Í•Ñ5•ÍÍ…” ‰A…ÍÍÝ½É‘Ì‘¼¹½Ðµ…Ñ ¸ˆ°ÑÉÕ”¤ì(€€€€€€€É•ÑÕÉ¸ì(€€€€€ô(€€€€€ÍÕ‰µ¥Ð¹‘¥Í…‰±•€ôÑÉÕ”ì(€€€€€ÑÉäì(€€€€€€€…Ý…¥Ð…ÕÑ¡I•ÅÕ•ÍÐ¡í…Ñ¥½¸è‰ÕÁ‘…Ñ”µÁ…ÍÍÝ½Éˆ°…•ÍÍQ½­•¸éÍ•ÍÍ¥½¸ü¹…•ÍÍ}Ñ½­•¸°Á…ÍÍÝ½É‘ô¤ì(€€€€€€€É•½Ù•Éå5½‘”€ô™…±Í”ì(€€€€€€€Í•Ñ5•ÍÍ…” ‰A…ÍÍÝ½ÉÕÁ‘…Ñ•¸e½Ô…É”Í¥¹•¥¸¸ˆ¤ì(€€€€€€€Í•ÑQ¥µ•½ÕÐ¡…Íå¹Œ€ ¤€ôøì…Ý…¥ÐÉ•™É•Í¡½Õ¹Ð ¤ìÉ•¹‘•É½Õ¹Ð ¤ìô°€ÜÀÀ¤ì(€€€€€ô…Ñ €¡•ÉÉ½È¤ì(€€€€€€€Í•Ñ5•ÍÍ…”¡•ÉÉ½È¹µ•ÍÍ…”°ÑÉÕ”¤ì(€€€€€€€ÍÕ‰µ¥Ð¹‘¥Í…‰±•€ô™…±Í”ì(€€€€€ô(€€€ô¤ì(€€€½¹Ñ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È m¹…µ”ô‰½¹™¥ÉµA…ÍÍÝ½É‰tœ¤ü¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰¥¹ÁÕÐˆ°€¡•Ù•¹Ð¤€ôø•Ù•¹Ð¹ÕÉÉ•¹ÑQ…É•Ð¹Í•ÑÕÍÑ½µY…±¥‘¥Ñä ˆˆ¤¤ì(€€€¥˜€¡µ•ÍÍ…”¤Í•Ñ5•ÍÍ…”¡µ•ÍÍ…”°ÑÉÕ”¤ì(€ô((€™Õ¹Ñ¥½¸Á…åµ•¹Ñ	ÕÑÑ½¹Ì ¤ì(€€€É•ÑÕÉ¸€ñ‘¥Ø±…ÍÌô‰Á…åµ•¹Ðµ…Ñ¥½¹Ìˆø(€€€€€€ñ‰ÕÑÑ½¸±…ÍÌô‰µ•µ‰•ÉÍ¡¥ÀµÁÉ¥µ…ÉäˆÑåÁ”ô‰‰ÕÑÑ½¸ˆ‘…Ñ„µ¡•­½ÕÐô‰ÍÑÉ¥Á”ˆ€‘í½¹™¥œ¹ÍÑÉ¥Á•¹…‰±•€ü€ˆˆ€è€‰‘¥Í…‰±•‰ôùA…ä€ÈÀÝ¥Ñ …Éð½‰ÕÑÑ½¸ø(€€€€€€ñ‰ÕÑÑ½¸±…ÍÌô‰µ•µ‰•ÉÍ¡¥ÀµÍ•½¹‘…ÉäˆÑåÁ”ô‰‰ÕÑÑ½¸ˆ‘…Ñ„µ¡•­½ÕÐô‰¹½ÝÁ…åµ•¹ÑÌˆ€‘í½¹™¥œ¹¹½ÝA…åµ•¹ÑÍ¹…‰±•€ü€ˆˆ€è€‰‘¥Í…‰±•‰ôùA…äÝ¥Ñ 	¥Ñ½¥¸½ÈÉåÁÑ¼ð½‰ÕÑÑ½¸ø(€€€€ð½‘¥Øø‘ì…½¹™¥œ¹ÍÑÉ¥Á•¹…‰±•ñð€…½¹™¥œ¹¹½ÝA…åµ•¹ÑÍ¹…‰±•€ü€œñÀ±…ÍÌô‰µ•µ‰•ÉÍ¡¥ÀµÍµ…±°ˆùA…åµ•¹Ð‰ÕÑÑ½¹Ì…Ñ¥Ù…Ñ”Ý¡•¸Ñ¡”ÁÉ¥Ù…Ñ”ÁÉ½•ÍÍ½È­•åÌ…É”½¹¹•Ñ•¸ð½Àøœ€è€ˆ‰õ€ì(€ô((€™Õ¹Ñ¥½¸ÍÕÁÁ½ÉÑ1¥¹” ¤ì(€€€½¹ÍÐ•µ…¥°€ôMÑÉ¥¹œ¡½¹™¥œ¹ÍÕÁÁ½ÉÑµ…¥°ñð€ˆˆ¤¹ÑÉ¥´ ¤ì(€€€É•ÑÕÉ¸•µ…¥°€ü€ñÀ±…ÍÌô‰µ•µ‰•ÉÍ¡¥ÀµÍµ…±°ˆù9••¡•±Àü€ñ„¡É•˜ô‰µ…¥±Ñ¼è‘í•Í…Á•!Ñµ°¡•µ…¥°¥ôˆø‘í•Í…Á•!Ñµ°¡•µ…¥°¥ôð½„øð½Àù€€è€ˆˆì(€ô((€™Õ¹Ñ¥½¸‰¥¹‘A…åµ•¹Ñ	ÕÑÑ½¹Ì ¤ì(€€€½¹Ñ•¹Ð¹ÅÕ•ÉåM•±•Ñ½É±° ‰m‘…Ñ„µ¡•­½ÕÑtˆ¤¹™½É…  ¡‰ÕÑÑ½¸¤€ôø‰ÕÑÑ½¸¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°…Íå¹Œ€ ¤€ôøì(€€€€€‰ÕÑÑ½¸¹‘¥Í…‰±•€ôÑÉÕ”ì(€€€€€Í•Ñ5•ÍÍ…” ‰=Á•¹¥¹œÍ•ÕÉ”¡•­½ÕÓŠ˜ˆ¤ì(€€€€€ÑÉäì(€€€€€€€½¹ÍÐ•¹‘Á½¥¹Ð€ô‰ÕÑÑ½¸¹‘…Ñ…Í•Ð¹¡•­½ÕÐ€ôôô€‰ÍÑÉ¥Á”ˆ€ü€ˆ½…Á¤½ÍÑÉ¥Á”µ¡•­½ÕÐˆ€è€ˆ½…Á¤½¹½ÝÁ…åµ•¹ÑÌµ¥¹Ù½¥”ˆì(€€€€€€€€¼¼9…µ•¡•…À½1¥Ñ•MÁ••É•©•ÑÌ‰½‘å±•ÍÌA=MPÉ•ÅÕ•ÍÑÌ‰•™½É”Ñ¡•äÉ•… (€€€€€€€€¼¼Ñ¡”9½‘”…ÁÀ¸¸•µÁÑä)M=8½‰©•Ð­••ÁÌ¡•­½ÕÐÉ•ÅÕ•ÍÑÌÉ½ÕÑ…‰±”¸(€€€€€€€½¹ÍÐÁ…å±½…€ô…Ý…¥Ð…ÕÑ¡½É¥é•‘•Ñ ¡•¹‘Á½¥¹Ð°íµ•Ñ¡½è‰A=MPˆ°‰½‘äè‰íô‰ô¤ì(€€€€€€€±½…Ñ¥½¸¹¡É•˜€ôÁ…å±½…¹ÕÉ°ì(€€€€€ô…Ñ €¡•ÉÉ½È¤ì(€€€€€€€Í•Ñ5•ÍÍ…”¡•ÉÉ½È¹µ•ÍÍ…”°ÑÉÕ”¤ì(€€€€€€€‰ÕÑÑ½¸¹‘¥Í…‰±•€ô™…±Í”ì(€€€€€ô(€€€ô¤¤ì(€ô((€™Õ¹Ñ¥½¸É•¹‘•ÉA…åÝ…±°¡µ•ÍÍ…”€ô€ˆˆ¤ì(€€€½¹Ñ•¹Ð¹¥¹¹•É!Q50€ô€‘íÁ…¹•±!•…‘•È ‰QI%0=5A1Qˆ°€‰-••ÀM…¹‘‰½á•™½È€ÈÀ„å•…Èˆ°€‰e½ÕÈ…½Õ¹Ð°Í…Ù•±¥ÍÐ°…¹™½ÕÈÉ•¥ÍÑ•É•‘•Ù¥•ÌÍÑ…ä…Ù…¥±…‰±”…™Ñ•ÈÁ…åµ•¹Ð¸ˆ¥ô(€€€€€€ñ‘¥Ø±…ÍÌô‰µ•µ‰•ÉÍ¡¥ÀµÁÉ¥”ˆøñÍÑÉ½¹œøÈÀð½ÍÑÉ½¹œøñÍÁ…¸ùÁ•Èå•…Èð½ÍÁ…¸øð½‘¥Øø‘íÁ…åµ•¹Ñ	ÕÑÑ½¹Ì ¥ô(€€€€€€ñÕ°±…ÍÌô‰µ•µ‰•ÉÍ¡¥Àµ™•…ÑÕÉ•Ìˆøñ±¤ù½ÕÈÉ•¥ÍÑ•É•‘•Ù¥•Ìð½±¤øñ±¤ùQÝ¼Í¥µÕ±Ñ…¹•½ÕÌÍÑÉ•…µÌð½±¤øñ±¤ù…É°	¥Ñ½¥¸°½È½Ñ¡•ÈÍÕÁÁ½ÉÑ•ÉåÁÑ¼ð½±¤øð½Õ°ø(€€€€€€‘íÍÕÁÁ½ÉÑ1¥¹” ¥ô(€€€€€€ñ‰ÕÑÑ½¸±…ÍÌô‰µ•µ‰•ÉÍ¡¥ÀµÑ•áÐµ‰ÕÑÑ½¸ˆÑåÁ”ô‰‰ÕÑÑ½¸ˆ¥ô‰Á…åÝ…±°µÍ¥¹½ÕÐˆùM¥¸½ÕÐð½‰ÕÑÑ½¸øñÀ±…ÍÌô‰µ•µ‰•ÉÍ¡¥Àµµ•ÍÍ…”ˆ¥ô‰µ•µ‰•ÉÍ¡¥Àµµ•ÍÍ…”ˆøð½Àù€ì(€€€‰¥¹‘A…åµ•¹Ñ	ÕÑÑ½¹Ì ¤ì(€€€½¹Ñ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È ˆÁ…åÝ…±°µÍ¥¹½ÕÐˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°Í¥¹=ÕÐ¤ì(€€€¥˜€¡µ•ÍÍ…”¤Í•Ñ5•ÍÍ…”¡µ•ÍÍ…”°ÑÉÕ”¤ì(€ô((€™Õ¹Ñ¥½¸É•¹‘•É½Õ¹Ð¡µ•ÍÍ…”€ô€ˆˆ¤ì(€€€¥˜€ ……½Õ¹Ð¤É•ÑÕÉ¸É•¹‘•ÉÕÑ  ‰±½¥¸ˆ¤ì(€€€½¹ÍÐÁÉ½™¥±”€ô…½Õ¹Ð¹ÁÉ½™¥±”ì(€€€½¹ÍÐÍÑ…ÑÕÍ½Áä€ôÁÉ½™¥±”¹ÍÑ…Ñ”€ôôô€‰…Ñ¥Ù”ˆ(€€€€€€üA…¥Ñ¡É½Õ €‘í™½Éµ…Ñ…Ñ”¡ÁÉ½™¥±”¹…•ÍÍU¹Ñ¥°¥õ€(€€€€€€èÁÉ½™¥±”¹ÍÑ…Ñ”€ôôô€‰ÑÉ¥…°ˆ(€€€€€€€€üÉ•”…•ÍÌ•¹‘Ì€‘í™½Éµ…Ñ…Ñ”¡ÁÉ½™¥±”¹ÑÉ¥…±¹‘ÍÐ¥õ€(€€€€€€€€èÁÉ½™¥±”¹ÍÑ…Ñ”€ôôô€‰•±¥¥‰±”ˆ(€€€€€€€€€€ü€‰e½ÕÈÑ¡É•”‘…åÌ‰•¥¸Ý¡•¸å½ÕÈ™¥ÉÍÐÙ¥‘•¼ÍÑ…ÉÑÌ¸ˆ(€€€€€€€€€€è€‰e½ÕÈ™É•”ÑÉ¥…°¡…Ì•¹‘•¸ˆì(€€€½¹ÍÐ‘•Ù¥•Ì€ô€¡…½Õ¹Ð¹‘•Ù¥•Ìñðmt¤¹µ…À ¡‘•Ù¥”¤€ôø€ñ±¤øñÍÁ…¸øñÍÑÉ½¹œø‘í•Í…Á•!Ñµ°¡‘•Ù¥”¹¹…µ”¥ôð½ÍÑÉ½¹œøñÍµ…±°ø‘í‘•Ù¥”¹¥€ôôô…½Õ¹Ð¹‘•Ù¥•%€ü€‰Q¡¥Ì‘•Ù¥”ˆ€è1…ÍÐÕÍ•€‘í™½Éµ…Ñ…Ñ”¡‘•Ù¥”¹±…ÍÑ}Í••¹}…Ð¥õôð½Íµ…±°øð½ÍÁ…¸ø‘í‘•Ù¥”¹¥€ôôô…½Õ¹Ð¹‘•Ù¥•%€ü€œñˆùÕÉÉ•¹Ðð½ˆøœ€è€ñ‰ÕÑÑ½¸ÑåÁ”ô‰‰ÕÑÑ½¸ˆ‘…Ñ„µÉ•µ½Ù”µ‘•Ù¥”ôˆ‘í•Í…Á•!Ñµ°¡‘•Ù¥”¹¥¥ôˆùI•µ½Ù”ð½‰ÕÑÑ½¸ùôð½±¤ù€¤¹©½¥¸ ˆˆ¤ì(€€€½¹Ñ•¹Ð¹¥¹¹•É!Q50€ô€‘íÁ…¹•±!•…‘•È ‰=U9Pˆ°•Í…Á•!Ñµ°¡…½Õ¹Ð¹ÕÍ•È¹•µ…¥°¤°ÍÑ…ÑÕÍ½Áä¥ô(€€€€€€ñ‘¥Ø±…ÍÌô‰…½Õ¹ÐµÍÑ…ÑÕÌˆøñÍÁ…¸ø‘í•Í…Á•!Ñµ°¡ÍÑ…ÑÕÍ1…‰•°¡ÁÉ½™¥±”¤¥ôð½ÍÁ…¸øñÍµ…±°ø‘í½¹™¥œ¹µ…á•Ù¥•Íô‘•Ù¥•Ìƒ
Ü€‘í½¹™¥œ¹µ…áMÑÉ•…µÍôÍÑÉ•…µÌ…Ð½¹”ð½Íµ…±°øð½‘¥Øø(€€€€€€ñ‘¥Ø±…ÍÌô‰‘•Ù¥”µ¡•…‘¥¹œˆøñÍÑÉ½¹œù•Ù¥•Ìð½ÍÑÉ½¹œøñÍÁ…¸ø‘í…½Õ¹Ð¹‘•Ù¥•Ì¹±•¹Ñ¡ô¼‘í½¹™¥œ¹µ…á•Ù¥•Íôð½ÍÁ…¸øð½‘¥ØøñÕ°±…ÍÌô‰‘•Ù¥”µ±¥ÍÐˆø‘í‘•Ù¥•Ìñð€ˆñ±¤ù9¼É•¥ÍÑ•É•‘•Ù¥•Ìð½±¤ø‰ôð½Õ°ø(€€€€€€‘íÁÉ½™¥±”¹ÍÑ…Ñ”€ôôô€‰…Ñ¥Ù”ˆ€˜˜…½Õ¹Ð¹‰¥±±¥¹œü¹¡…ÍMÑÉ¥Á•ÕÍÑ½µ•È€ü€œñ‰ÕÑÑ½¸±…ÍÌô‰µ•µ‰•ÉÍ¡¥ÀµÍ•½¹‘…ÉäˆÑåÁ”ô‰‰ÕÑÑ½¸ˆ¥ô‰‰¥±±¥¹œµÁ½ÉÑ…°ˆù5…¹…”…ÉÍÕ‰ÍÉ¥ÁÑ¥½¸ð½‰ÕÑÑ½¸øœ€èÁÉ½™¥±”¹ÍÑ…Ñ”€ôôô€‰…Ñ¥Ù”ˆ€ü€œñÀ±…ÍÌô‰µ•µ‰•ÉÍ¡¥ÀµÍµ…±°ˆùÉåÁÑ¼µ•µ‰•ÉÍ¡¥À…Ñ¥Ù”¸I•¹•Ü™É½´Ñ¡¥Ì…½Õ¹Ð‰•™½É”¥Ð•áÁ¥É•Ì¸ð½Àøœ€èÁ…åµ•¹Ñ	ÕÑÑ½¹Ì ¥ô(€€€€€€‘íÍÕÁÁ½ÉÑ1¥¹” ¥ô(€€€€€€ñ‰ÕÑÑ½¸±…ÍÌô‰µ•µ‰•ÉÍ¡¥ÀµÑ•áÐµ‰ÕÑÑ½¸ˆÑåÁ”ô‰‰ÕÑÑ½¸ˆ¥ô‰…½Õ¹ÐµÍ¥¹½ÕÐˆùM¥¸½ÕÐð½‰ÕÑÑ½¸øñÀ±…ÍÌô‰µ•µ‰•ÉÍ¡¥Àµµ•ÍÍ…”ˆ¥ô‰µ•µ‰•ÉÍ¡¥Àµµ•ÍÍ…”ˆøð½Àù€ì(€€€‰¥¹‘A…åµ•¹Ñ	ÕÑÑ½¹Ì ¤ì(€€€½¹Ñ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È ˆ…½Õ¹ÐµÍ¥¹½ÕÐˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°Í¥¹=ÕÐ¤ì(€€€½¹Ñ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È ˆ‰¥±±¥¹œµÁ½ÉÑ…°ˆ¤ü¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°…Íå¹Œ€¡•Ù•¹Ð¤€ôøì(€€€€€•Ù•¹Ð¹ÕÉÉ•¹ÑQ…É•Ð¹‘¥Í…‰±•€ôÑÉÕ”ì(€€€€€ÑÉäì(€€€€€€€½¹ÍÐÁ…å±½…€ô…Ý…¥Ð…ÕÑ¡½É¥é•‘•Ñ  ˆ½…Á¤½ÍÑÉ¥Á”µÁ½ÉÑ…°ˆ°íµ•Ñ¡½è‰A=MPˆ°‰½‘äè‰íô‰ô¤ì(€€€€€€€±½…Ñ¥½¸¹¡É•˜€ôÁ…å±½…¹ÕÉ°ì(€€€€€ô…Ñ €¡•ÉÉ½È¤ì(€€€€€€€Í•Ñ5•ÍÍ…”¡•ÉÉ½È¹µ•ÍÍ…”°ÑÉÕ”¤ì(€€€€€€€•Ù•¹Ð¹ÕÉÉ•¹ÑQ…É•Ð¹‘¥Í…‰±•€ô™…±Í”ì(€€€€€ô(€€€ô¤ì(€€€½¹Ñ•¹Ð¹ÅÕ•ÉåM•±•Ñ½É±° ‰m‘…Ñ„µÉ•µ½Ù”µ‘•Ù¥•tˆ¤¹™½É…  ¡‰ÕÑÑ½¸¤€ôø‰ÕÑÑ½¸¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°…Íå¹Œ€ ¤€ôøì(€€€€€‰ÕÑÑ½¸¹‘¥Í…‰±•€ôÑÉÕ”ì(€€€€€ÑÉäì(€€€€€€€½¹ÍÐÁ…å±½…€ô…Ý…¥Ð…ÕÑ¡½É¥é•‘•Ñ  ˆ½…Á¤½‘•Ù¥•Ìˆ°íµ•Ñ¡½è‰1Qˆ°‰½‘äé)M=8¹ÍÑÉ¥¹¥™ä¡í‘•Ù¥•%é‰ÕÑÑ½¸¹‘…Ñ…Í•Ð¹É•µ½Ù••Ù¥•ô¥ô¤ì(€€€€€€€…½Õ¹Ð¹‘•Ù¥•Ì€ôÁ…å±½…¹‘•Ù¥•Ìì(€€€€€€€É•¹‘•É½Õ¹Ð ‰•Ù¥”É•µ½Ù•¸ˆ¤ì(€€€€€€€Í•Ñ5•ÍÍ…” ‰•Ù¥”É•µ½Ù•¸ˆ¤ì(€€€€€ô…Ñ €¡•ÉÉ½È¤ì(€€€€€€€Í•Ñ5•ÍÍ…”¡•ÉÉ½È¹µ•ÍÍ…”°ÑÉÕ”¤ì(€€€€€€€‰ÕÑÑ½¸¹‘¥Í…‰±•€ô™…±Í”ì(€€€€€ô(€€€ô¤¤ì(€€€¥˜€¡µ•ÍÍ…”¤Í•Ñ5•ÍÍ…”¡µ•ÍÍ…”¤ì(€ô((€…Íå¹Œ™Õ¹Ñ¥½¸É•¹‘•É•Ù¥•1¥µ¥Ð¡µ•ÍÍ…”¤ì(€€€½¹Ñ•¹Ð¹¥¹¹•É!Q50€ô€‘íÁ…¹•±!•…‘•È ‰Y%1%5%Pˆ°€‰¡½½Í”„‘•Ù¥”Ñ¼É•µ½Ù”ˆ°µ•ÍÍ…”ñðe½ÕÈ…½Õ¹Ð…±É•…‘ä¡…Ì€‘í½¹™¥œ¹µ…á•Ù¥•Íô…Ñ¥Ù”‘•Ù¥•Ì¹€¥ôñÀ±…ÍÌô‰µ•µ‰•ÉÍ¡¥Àµµ•ÍÍ…”ˆ¥ô‰µ•µ‰•ÉÍ¡¥Àµµ•ÍÍ…”ˆù1½…‘¥¹œ‘•Ù¥•ÏŠ˜ð½Àù€ì(€€€ÑÉäì(€€€€€½¹ÍÐÁ…å±½…€ô…Ý…¥Ð…ÕÑ¡½É¥é•‘•Ñ  ˆ½…Á¤½‘•Ù¥•Ìˆ¤ì(€€€€€…½Õ¹Ð€ô…½Õ¹ÐñðíÕÍ•ÈéÍ•ÍÍ¥½¸ü¹ÕÍ•Èñðí•µ…¥°è‰½Õ¹Ð‰ô°ÁÉ½™¥±”éíÍÑ…Ñ”è‰•±¥¥‰±”‰ô°‘•Ù¥•%èˆˆ°‘•Ù¥•ÌéÁ…å±½…¹‘•Ù¥•Íôì(€€€€€…½Õ¹Ð¹‘•Ù¥•Ì€ôÁ…å±½…¹‘•Ù¥•Ìì(€€€€€É•¹‘•É½Õ¹Ð¡µ•ÍÍ…”ñð€‰I•µ½Ù”½¹”‘•Ù¥”°Ñ¡•¸ÑÉäÁ±…å‰…¬……¥¸¸ˆ¤ì(€€€ô…Ñ €¡•ÉÉ½È¤ì(€€€€€Í•Ñ5•ÍÍ…”¡•ÉÉ½È¹µ•ÍÍ…”°ÑÉÕ”¤ì(€€€ô(€ô((€…Íå¹Œ™Õ¹Ñ¥½¸É•™É•Í¡½Õ¹Ð ¤ì(€€€¥˜€ …Í•ÍÍ¥½¸¤É•ÑÕÉ¸¹Õ±°ì(€€€½¹ÍÐÁ…å±½…€ô…Ý…¥Ð…ÕÑ¡½É¥é•‘•Ñ  ˆ½…Á¤½µ”ˆ°íµ•Ñ¡½è‰A=MPˆ°‰½‘äé)M=8¹ÍÑÉ¥¹¥™ä¡…Ý…¥Ð‘•Ù¥•A…å±½… ¤¥ô¤ì(€€€…½Õ¹Ð€ôÁ…å±½…ì(€€€ÕÁ‘…Ñ•!•…‘•È ¤ì(€€€É•ÑÕÉ¸Á…å±½…ì(€ô((€…Íå¹Œ™Õ¹Ñ¥½¸Í¥¹=ÕÐ ¤ì(€€€ÍÑ½ÁA±…å‰…¬ ¤ì(€€€½¹ÍÐ½±€ôÍ•ÍÍ¥½¸ì(€€€Í…Ù•M•ÍÍ¥½¸¡¹Õ±°¤ì(€€€…½Õ¹Ð€ô¹Õ±°ì(€€€ÕÁ‘…Ñ•!•…‘•È ¤ì(€€€±½Í•5½‘…° ¤ì(€€€¥˜€¡½±ü¹…•ÍÍ}Ñ½­•¸¤…ÕÑ¡I•ÅÕ•ÍÐ¡í…Ñ¥½¸è‰±½½ÕÐˆ°…•ÍÍQ½­•¸é½±¹…•ÍÍ}Ñ½­•¹ô¤¹…Ñ   ¤€ôøíô¤ì(€ô((€…Íå¹Œ™Õ¹Ñ¥½¸…ÕÑ¡½É¥é•A±…ä¡¥Ñ•´¤ì(€€€¥˜€ …½¹™¥1½…‘•ñð€…½¹™¥œ¹µ•µ‰•ÉÍ¡¥Á¹…‰±•¤ì(€€€€€½Á•¹5½‘…° ‰Í•ÑÕÀˆ¤ì(€€€€€É•ÑÕÉ¸¹Õ±°ì(€€€ô(€€€¥˜€ …Í•ÍÍ¥½¸¤ì(€€€€€Á•¹‘¥¹A±…ä€ô¥Ñ•´ì(€€€€€½Á•¹5½‘…° ‰Í¥¹ÕÀˆ¤ì(€€€€€É•ÑÕÉ¸¹Õ±°ì(€€€ô(€€€ÑÉäì(€€€€€½¹ÍÐÁ…å±½…€ô…Ý…¥Ð…ÕÑ¡½É¥é•‘•Ñ  ˆ½…Á¤½Á±…äˆ°ì(€€€€€€€µ•Ñ¡½è‰A=MPˆ°(€€€€€€€‰½‘äé)M=8¹ÍÑÉ¥¹¥™ä¡ì¸¸¹…Ý…¥Ð‘•Ù¥•A…å±½… ¤°¥Ñ•´éí¥é¥Ñ•´¹¥°ÑåÁ”é¥Ñ•´¹ÑåÁ•õô¤(€€€€€ô¤ì(€€€€€¥˜€¡…½Õ¹Ð¤…½Õ¹Ð¹ÁÉ½™¥±”€ôÁ…å±½…¹…•ÍÌì(€€€€€ÕÁ‘…Ñ•!•…‘•È ¤ì(€€€€€É•ÑÕÉ¸Á…å±½…ì(€€€ô…Ñ €¡•ÉÉ½È¤ì(€€€€€¥˜€¡•ÉÉ½È¹ÍÑ…ÑÕÌ€ôôô€ÐÀÄñð•ÉÉ½È¹½‘”€ôôô€‰5%1}9=Q}YI%%ˆ¤ì(€€€€€€€Á•¹‘¥¹A±…ä€ô¥Ñ•´ì(€€€€€€€½Á•¹5½‘…°¡•ÉÉ½È¹½‘”€ôôô€‰5%1}9=Q}YI%%ˆ€ü€‰Ù•É¥™äˆ€è€‰±½¥¸ˆ°•ÉÉ½È¹µ•ÍÍ…”¤ì(€€€€€ô•±Í”¥˜€¡•ÉÉ½È¹ÍÑ…ÑÕÌ€ôôô€ÐÀÈ¤ì(€€€€€€€½Á•¹5½‘…° ‰Á…åÝ…±°ˆ°•ÉÉ½È¹µ•ÍÍ…”¤ì(€€€€€ô•±Í”¥˜€¡•ÉÉ½È¹½‘”€ôôô€‰Y%}1%5%Pˆ¤ì(€€€€€€€½Á•¹5½‘…° ‰‘•Ù¥”µ±¥µ¥Ðˆ°•ÉÉ½È¹µ•ÍÍ…”¤ì(€€€€€ô•±Í”ì(€€€€€€€½Á•¹5½‘…° ‰…½Õ¹Ðˆ°•ÉÉ½È¹µ•ÍÍ…”¤ì(€€€€€ô(€€€€€É•ÑÕÉ¸¹Õ±°ì(€€€ô(€ô((€™Õ¹Ñ¥½¸ÍÑ…ÉÑ!•…ÉÑ‰•…Ð¡Í•ÍÍ¥½¹%¤ì(€€€ÍÑ½ÁA±…å‰…¬ ¤ì(€€€¥˜€ …Í•ÍÍ¥½¹%¤É•ÑÕÉ¸ì(€€€Á±…å‰…­M•ÍÍ¥½¹%€ôÍ•ÍÍ¥½¹%ì(€€€¡•…ÉÑ‰•…ÑQ¥µ•È€ôÍ•Ñ%¹Ñ•ÉÙ…°  ¤€ôøì(€€€€€…ÕÑ¡½É¥é•‘•Ñ  ˆ½…Á¤½¡•…ÉÑ‰•…Ðˆ°íµ•Ñ¡½è‰A=MPˆ°‰½‘äé)M=8¹ÍÑÉ¥¹¥™ä¡íÍ•ÍÍ¥½¹%‘ô¥ô¤¹…Ñ   ¤€ôøÍÑ½ÁA±…å‰…¬¡™…±Í”¤¤ì(€€€ô°€ÐÔÀÀÀ¤ì(€ô((€™Õ¹Ñ¥½¸ÍÑ½ÁA±…å‰…¬¡¹½Ñ¥™ä€ôÑÉÕ”¤ì(€€€±•…É%¹Ñ•ÉÙ…°¡¡•…ÉÑ‰•…ÑQ¥µ•È¤ì(€€€¡•…ÉÑ‰•…ÑQ¥µ•È€ô¹Õ±°ì(€€€½¹ÍÐÍ•ÍÍ¥½¹%€ôÁ±…å‰…­M•ÍÍ¥½¹%ì(€€€Á±…å‰…­M•ÍÍ¥½¹%€ô¹Õ±°ì(€€€¥˜€¡¹½Ñ¥™ä€˜˜Í•ÍÍ¥½¹%€˜˜Í•ÍÍ¥½¸¤ì(€€€€€…ÕÑ¡½É¥é•‘•Ñ  ˆ½…Á¤½¡•…ÉÑ‰•…Ðˆ°íµ•Ñ¡½è‰A=MPˆ°‰½‘äé)M=8¹ÍÑÉ¥¹¥™ä¡íÍ•ÍÍ¥½¹%°•¹éÑÉÕ•ô¤°­••Á…±¥Ù”éÑÉÕ•ô¤¹…Ñ   ¤€ôøíô¤ì(€€€ô(€ô((€…Íå¹Œ™Õ¹Ñ¥½¸¡•­A…åµ•¹ÑI•ÑÕÉ¸ ¤ì(€€€½¹ÍÐÁ…É…µÌ€ô¹•ÜUI1M•…É¡A…É…µÌ¡±½…Ñ¥½¸¹Í•…É ¤ì(€€€¥˜€¡Á…É…µÌ¹•Ð ‰Á…åµ•¹Ðˆ¤€„ôô€‰ÍÕ•ÍÌˆñð€…Í•ÍÍ¥½¸¤É•ÑÕÉ¸ì(€€€½Á•¹5½‘…° ‰…½Õ¹Ðˆ°€‰A…åµ•¹ÐÉ••¥Ù•¸½¹™¥Éµ¥¹œå½ÕÈµ•µ‰•ÉÍ¡¥ÃŠ˜ˆ¤ì(€€€™½È€¡±•Ð…ÑÑ•µÁÐ€ô€Àì…ÑÑ•µÁÐ€ð€Ôì…ÑÑ•µÁÐ€¬ô€Ä¤ì(€€€€€…Ý…¥Ð¹•ÜAÉ½µ¥Í” ¡É•Í½±Ù”¤€ôøÍ•ÑQ¥µ•½ÕÐ¡É•Í½±Ù”°€ÄàÀÀ¤¤ì(€€€€€ÑÉäì(€€€€€€€…Ý…¥ÐÉ•™É•Í¡½Õ¹Ð ¤ì(€€€€€€€¥˜€¡…½Õ¹Ðü¹ÁÉ½™¥±”ü¹ÍÑ…Ñ”€ôôô€‰…Ñ¥Ù”ˆ¤ì(€€€€€€€€€É•¹‘•É½Õ¹Ð ‰A…åµ•¹Ð½¹™¥Éµ•¸e½ÕÈµ•µ‰•ÉÍ¡¥À¥Ì…Ñ¥Ù”¸ˆ¤ì(€€€€€€€€€¡¥ÍÑ½Éä¹É•Á±…•MÑ…Ñ”¡íô°€ˆˆ°±½…Ñ¥½¸¹Á…Ñ¡¹…µ”¤ì(€€€€€€€€€É•ÑÕÉ¸ì(€€€€€€€ô(€€€€€ô…Ñ íô(€€€ô(€€€É•¹‘•É½Õ¹Ð ‰A…åµ•¹Ð¥ÌÍÑ¥±°½¹™¥Éµ¥¹œ¸I•½Á•¸å½ÕÈ…½Õ¹Ð¥¸„µ¥¹ÕÑ”¸ˆ¤ì(€ô((€™Õ¹Ñ¥½¸Á…ÉÍ•ÕÑ¡I•‘¥É•Ð ¤ì(€€€½¹ÍÐ¡…Í €ô¹•ÜUI1M•…É¡A…É…µÌ¡±½…Ñ¥½¸¹¡…Í ¹É•Á±…” ½xŒ¼°€ˆˆ¤¤ì(€€€¥˜€ …¡…Í ¹•Ð ‰…•ÍÍ}Ñ½­•¸ˆ¤¤É•ÑÕÉ¸ì(€€€½¹ÍÐ¹•áÐ€ô¹½Éµ…±¥é•M•ÍÍ¥½¸¡ì(€€€€€…•ÍÍ}Ñ½­•¸é¡…Í ¹•Ð ‰…•ÍÍ}Ñ½­•¸ˆ¤°(€€€€€É•™É•Í¡}Ñ½­•¸é¡…Í ¹•Ð ‰É•™É•Í¡}Ñ½­•¸ˆ¤°(€€€€€•áÁ¥É•Í}¥¸é¡…Í ¹•Ð ‰•áÁ¥É•Í}¥¸ˆ¤°(€€€€€Ñ½­•¹}ÑåÁ”é¡…Í ¹•Ð ‰Ñ½­•¹}ÑåÁ”ˆ¤(€€€ô¤ì(€€€Í…Ù•M•ÍÍ¥½¸¡¹•áÐ¤ì(€€€É•½Ù•Éå5½‘”€ô¡…Í ¹•Ð ‰ÑåÁ”ˆ¤€ôôô€‰É•½Ù•Éäˆñð¹•ÜUI1M•…É¡A…É…µÌ¡±½…Ñ¥½¸¹Í•…É ¤¹•Ð ‰…ÕÑ ˆ¤€ôôô€‰É•½Ù•Éäˆì(€€€¡¥ÍÑ½Éä¹É•Á±…•MÑ…Ñ”¡íô°€ˆˆ°±½…Ñ¥½¸¹Á…Ñ¡¹…µ”¤ì(€ô((€…Íå¹Œ™Õ¹Ñ¥½¸¥¹¥Ð ¤ì(€€€Á…ÉÍ•ÕÑ¡I•‘¥É•Ð ¤ì(€€€ÑÉäì(€€€€€½¹ÍÐÉ•ÍÁ½¹Í”€ô…Ý…¥Ð™•Ñ  ˆ½…Á¤½½¹™¥œˆ°í¡•…‘•ÉÌéí…•ÁÐè‰…ÁÁ±¥…Ñ¥½¸½©Í½¸‰õô¤ì(€€€€€¥˜€ …É•ÍÁ½¹Í”¹½¬¤Ñ¡É½Ü¹•ÜÉÉ½È¡½¹™¥ÕÉ…Ñ¥½¸É•ÅÕ•ÍÐ™…¥±•€ ‘íÉ•ÍÁ½¹Í”¹ÍÑ…ÑÕÍô¥€¤ì(€€€€€½¹™¥œ€ô…Ý…¥ÐÉ•ÍÁ½¹Í”¹©Í½¸ ¤ì(€€€€€½¹™¥1½…‘•€ôÑÉÕ”ì(€€€ô…Ñ íô(€€€ÕÁ‘…Ñ•!•…‘•È ¤ì(€€€¥˜€¡Í•ÍÍ¥½¸€˜˜½¹™¥1½…‘•€˜˜½¹™¥œ¹µ•µ‰•ÉÍ¡¥Á¹…‰±•¤ì(€€€€€ÑÉäì…Ý…¥ÐÉ•™É•Í¡½Õ¹Ð ¤ìô(€€€€€…Ñ €¡•ÉÉ½È¤ì(€€€€€€€¥˜€¡•ÉÉ½È¹½‘”€ôôô€‰Y%}1%5%Pˆ¤½Á•¹5½‘…° ‰‘•Ù¥”µ±¥µ¥Ðˆ°•ÉÉ½È¹µ•ÍÍ…”¤ì(€€€€€€€•±Í”¥˜€¡•ÉÉ½È¹ÍÑ…ÑÕÌ€ôôô€ÐÀÄ¤Í…Ù•M•ÍÍ¥½¸¡¹Õ±°¤ì(€€€€€ô(€€€ô(€€€¥˜€¡É•½Ù•Éå5½‘”€˜˜Í•ÍÍ¥½¸¤½Á•¹5½‘…° ‰É•½Ù•Éäˆ¤ì(€€€•±Í”¡•­A…åµ•¹ÑI•ÑÕÉ¸ ¤ì(€ô((€…½Õ¹Ñ	ÕÑÑ½¸¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôø½Á•¹5½‘…° ‰…½Õ¹Ðˆ¤¤ì(€ÍÑ…ÑÕÍ	ÕÑÑ½¸¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôø½Á•¹5½‘…°¡…½Õ¹Ðü¹ÁÉ½™¥±”ü¹ÍÑ…Ñ”€ôôô€‰•áÁ¥É•ˆ€ü€‰Á…åÝ…±°ˆ€è€‰…½Õ¹Ðˆ¤¤ì(€±½Í•	ÕÑÑ½¸¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°±½Í•5½‘…°¤ì(€µ½‘…°¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€¡•Ù•¹Ð¤€ôøì¥˜€¡•Ù•¹Ð¹Ñ…É•Ð€ôôôµ½‘…°¤±½Í•5½‘…° ¤ìô¤ì(€‘½Õµ•¹Ð¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰­•å‘½Ý¸ˆ°€¡•Ù•¹Ð¤€ôøì¥˜€¡•Ù•¹Ð¹­•ä€ôôô€‰Í…Á”ˆ€˜˜€…µ½‘…°¹¡¥‘‘•¸¤±½Í•5½‘…° ¤ìô¤ì(€Ý¥¹‘½Ü¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰‰•™½É•Õ¹±½…ˆ°€ ¤€ôøÍÑ½ÁA±…å‰…¬¡ÑÉÕ”¤¤ì((€Ý¥¹‘½Ü¹M…¹‘‰½á•‘5•µ‰•ÉÍ¡¥À€ôí…ÕÑ¡½É¥é•A±…ä°ÍÑ…ÉÑ!•…ÉÑ‰•…Ð°ÍÑ½ÁA±…å‰…¬°½Á•¹½Õ¹Ðè ¤€ôø½Á•¹5½‘…° ‰…½Õ¹Ðˆ¥ôì(€¥¹¥Ð ¤ì)ô¤ ¤ì(