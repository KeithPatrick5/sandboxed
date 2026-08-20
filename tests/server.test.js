const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TRIAL_HOURS,
  MAX_DEVICES,
  MAX_STREAMS,
  MAX_REPLACEMENTS_30_DAYS,
  accessState,
  secureHash,
  safeEqual
} = require("../lib/server");

test("membership policy constants match the approved rules", () => {
  assert.equal(TRIAL_HOURS, 72);
  assert.equal(MAX_DEVICES, 4);
  assert.equal(MAX_STREAMS, 2);
  assert.equal(MAX_REPLACEMENTS_30_DAYS, 2);
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
