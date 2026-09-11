const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TRIAL_HOURS,
  MONTHLY_PRICE_USD,
  MONTHLY_PRICE_CENTS,
  ANNUAL_PRICE_USD,
  ANNUAL_PRICE_CENTS,
  MAX_DEVICES,
  MAX_STREAMS,
  MAX_REPLACEMENTS_30_DAYS,
  accessState,
  activeStreamDeviceIds,
  hasAvailableStreamSlot,
  validatePlaybackAuthorization,
  secureHash,
  safeEqual,
  signedDeviceId,
  verifiedDeviceId,
  cleanupOldRecords
} = require("../lib/server");

test("membership policy constants match the approved rules", () => {
  assert.equal(TRIAL_HOURS, 72);
  assert.equal(MONTHLY_PRICE_USD, 6.99);
  assert.equal(MONTHLY_PRICE_CENTS, 699);
  assert.equal(ANNUAL_PRICE_USD, 30);
  assert.equal(ANNUAL_PRICE_CENTS, 3000);
  assert.equal(MAX_DEVICES, 4);
  assert.equal(MAX_STREAMS, 2);
  assert.equal(MAX_REPLACEMENTS_30_DAYS, 2);
});

test("stream counting uses distinct devices and ignores the device restarting playback", () => {
  const active = [
    {id:"session-1", device_id:"device-a"},
    {id:"session-2", device_id:"device-a"},
    {id:"session-3", device_id:"device-b"}
  ];
  assert.deepEqual([...activeStreamDeviceIds(active)].sort(), ["device-a", "device-b"]);
  assert.deepEqual([...activeStreamDeviceIds(active, "device-b")], ["device-a"]);
  assert.equal(hasAvailableStreamSlot(active, "device-b", 2), true);
  assert.equal(hasAvailableStreamSlot(active, "device-c", 2), false);
});

test("access states distinguish eligible, trial, paid, and expired accounts", () => {
  assert.equal(accessState({}).state, "eligible");
  assert.equal(accessState({trial_started_at:new Date().toISOString(), trial_ends_at:new Date(Date.now() + 60000).toISOString()}).state, "trial");
  assert.equal(accessState({access_until:new Date(Date.now() + 60000).toISOString()}).state, "active");
  assert.equal(accessState({trial_started_at:new Date(Date.now() - 900000).toISOString(), trial_ends_at:new Date(Date.now() - 60000).toISOString()}).state, "expired");
  assert.equal(accessState({subscription_status:"refunded", access_until:new Date(Date.now() + 60000).toISOString()}).state, "expired");
  assert.equal(accessState({subscription_status:"disputed", access_until:new Date(Date.now() + 60000).toISOString()}).state, "expired");
});

test("playback heartbeats require current access and an authorized device", () => {
  const device = {id:"device-1"};
  const trial = {trial_started_at:new Date().toISOString(), trial_ends_at:new Date(Date.now() + 60000).toISOString()};
  const paid = {access_until:new Date(Date.now() + 60000).toISOString()};
  const expired = {trial_started_at:new Date(Date.now() - 120000).toISOString(), trial_ends_at:new Date(Date.now() - 60000).toISOString()};

  assert.equal(validatePlaybackAuthorization(trial, device).state, "trial");
  assert.equal(validatePlaybackAuthorization(paid, device).state, "active");
  assert.throws(() => validatePlaybackAuthorization(expired, device), {code:"PLAYBACK_ACCESS_ENDED", status:402});
  assert.throws(() => validatePlaybackAuthorization(paid, null), {code:"DEVICE_REVOKED", status:403});
});

test("device signals are hashed and compared without plain-text storage", () => {
  const first = secureHash("device-one");
  const second = secureHash("device-two");
  assert.equal(first.length, 64);
  assert.notEqual(first, second);
  assert.equal(safeEqual(first, first), true);
  assert.equal(safeEqual(first, second), false);
});

test("registered device identity requires a valid server signature", () => {
  const id = "4df731dc-1e8c-4897-a2c2-6e436b1b985c";
  const signed = signedDeviceId(id);
  const request = {headers:{cookie:`theme=dark; __Host-sandboxed_device=${signed}`}};
  assert.equal(verifiedDeviceId(request), id);
  assert.equal(verifiedDeviceId({headers:{cookie:`__Host-sandboxed_device=${signed}tampered`}}), "");
  assert.equal(verifiedDeviceId({headers:{cookie:"__Host-sandboxed_device=attacker-chosen.invalid"}}), "");
});

test("retention cleanup sends only bounded service-role deletes", async () => {
  const previousFetch = global.fetch;
  const testEnvironment = {
    SUPABASE_URL:"https://project.supabase.co",
    SUPABASE_PUBLISHABLE_KEY:"test-publishable",
    SUPABASE_SECRET_KEY:"test-secret",
    DEVICE_HASH_SECRET:"test-device-secret"
  };
  const previousEnvironment = Object.fromEntries(Object.keys(testEnvironment).map((name) => [name, process.env[name]]));
  const calls = [];
  Object.assign(process.env, testEnvironment);
  global.fetch = async (url, options) => {
    calls.push({url:String(url), method:options.method});
    return new Response(null, {status:204});
  };
  try {
    const result = await cleanupOldRecords(Date.parse("2026-09-10T00:00:00.000Z"));
    assert.equal(result.watchCutoff, "2026-08-11T00:00:00.000Z");
    assert.equal(result.deviceCutoff, "2026-06-12T00:00:00.000Z");
    assert.equal(result.paymentCutoff, "2025-08-06T00:00:00.000Z");
    assert.deepEqual(calls.map((call) => call.method), ["DELETE", "DELETE", "DELETE", "DELETE", "DELETE"]);
    assert.match(calls[0].url, /watch_sessions\?ended_at=not\.is\.null/);
    assert.match(calls[1].url, /devices\?revoked_at=not\.is\.null/);
    assert.match(calls[2].url, /payment_events\?created_at=lt/);
    assert.match(calls[3].url, /marketing_events\?created_at=lt/);
    assert.match(calls[4].url, /marketing_attribution\?user_id=is.null/);
    assert.doesNotMatch(calls.map((call) => call.url).join("\n"), /trial_claims|profiles/);
  } finally {
    global.fetch = previousFetch;
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
