const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TRIAL_HOURS,
  ANNUAL_PRICE_USD,
  ANNUAL_PRICE_CENTS,
  MAX_DEVICES,
  MAX_STREAMS,
  MAX_REPLACEMENTS_30_DAYS,
  accessState,
  activeStreamDeviceIds,
  hasAvailableStreamSlot,
  secureHash,
  safeEqual
} = require("../lib/server");

test("membership policy constants match the approved rules", () => {
  assert.equal(TRIAL_HOURS, 72);
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
});

test("device signals are hashed and compared without plain-text storage", () => {
  const first = secureHash("device-one");
  const second = secureHash("device-two");
  assert.equal(first.length, 64);
  assert.notEqual(first, second);
  assert.equal(safeEqual(first, first), true);
  assert.equal(safeEqual(first, second), false);
});
