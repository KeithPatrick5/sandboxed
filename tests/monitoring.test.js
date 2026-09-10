const test = require("node:test");
const assert = require("node:assert/strict");
const {redact, sentryEnvelope} = require("../lib/monitoring");
const {handlerError} = require("../lib/server");

test("Sentry envelopes redact user identifiers and secret-like values", () => {
  const previousDsn = process.env.SENTRY_DSN;
  process.env.SENTRY_DSN = "https://publickey@example.ingest.sentry.io/123";
  try {
    const error = Object.assign(new Error("user@example.com 6a63a091-d96d-44dc-9823-bdd012345678 sk_live_abcdefghijklmnop"), {
      status:500,
      code:"DATABASE_ERROR"
    });
    const envelope = sentryEnvelope(error, {route:"/api/me"}, new Date("2026-09-10T00:00:00.000Z"));
    assert.match(envelope.url, /^https:\/\/example\.ingest\.sentry\.io\/api\/123\/envelope\//);
    assert.match(envelope.body, /\[email\]/);
    assert.match(envelope.body, /\[uuid\]/);
    assert.match(envelope.body, /\[secret\]/);
    assert.doesNotMatch(envelope.body, /user@example\.com|6a63a091|sk_live_/);
  } finally {
    if (previousDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = previousDsn;
  }
  assert.equal(redact("plain failure"), "plain failure");
});

test("unexpected server failures do not expose internal messages or error codes", () => {
  let status;
  let body;
  const response = {
    req:{url:"/api/me?private=query"},
    status(value) { status = value; return this; },
    setHeader() {},
    end(value) { body = JSON.parse(value); }
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    handlerError(response, Object.assign(new Error("database host and internal details"), {status:500, code:"DATABASE_ERROR"}));
  } finally {
    console.error = originalError;
  }
  assert.equal(status, 500);
  assert.deepEqual(body, {error:"The service is temporarily unavailable.", code:"SERVER_ERROR"});
});
