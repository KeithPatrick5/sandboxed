const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const stripeWebhook = require("../api/stripe-webhook");
const nowPaymentsWebhook = require("../api/nowpayments-ipn");
const {clientIp} = require("../lib/server");

const root = path.join(__dirname, "..");

test("the browser cannot fall back to an ungated player URL", () => {
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const membership = fs.readFileSync(path.join(root, "membership.js"), "utf8");
  assert.doesNotMatch(app, /function\s+playerUrl\s*\(/);
  assert.doesNotMatch(app, /access\.url\s*\|\|/);
  assert.match(app, /if\s*\(!access\?\.url\)\s*return/);
  assert.match(membership, /if\s*\(!configLoaded\s*\|\|\s*!config\.membershipEnabled\)/);
});

test("the UI and catalog API do not claim a fake indexed-title count", () => {
  const sources = ["app.js", "api/catalog.js"].map((file) => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
  assert.doesNotMatch(sources, /CATALOG_SIZE|catalogSize|100000/);
});

test("reactivating a removed device preserves its replacement history", () => {
  const server = fs.readFileSync(path.join(root, "lib/server.js"), "utf8");
  assert.match(server, /retired-device:/);
  assert.doesNotMatch(server, /revoked_at\s*:\s*null/);
});

test("signup supports password managers and rejects mismatched confirmation", () => {
  const membership = fs.readFileSync(path.join(root, "membership.js"), "utf8");
  assert.match(membership, /autocomplete="username"/);
  assert.match(membership, /autocomplete="\$\{signup \? "new-password" : "current-password"\}"/);
  assert.match(membership, /name="confirmPassword"/);
  assert.match(membership, /password !== confirmPassword/);
  assert.match(membership, /Passwords do not match\./);
});

test("trial claims survive account deletion and remain cross-account", () => {
  const schema = fs.readFileSync(path.join(root, "supabase-setup.sql"), "utf8");
  const server = fs.readFileSync(path.join(root, "lib/server.js"), "utf8");
  const membership = fs.readFileSync(path.join(root, "membership.js"), "utf8");
  assert.match(schema, /trial_claims[\s\S]*on delete set null/i);
  assert.match(schema, /user_id uuid unique references auth\.users\(id\) on delete set null/i);
  assert.match(server, /claim\.user_id !== profile\.id/);
  assert.match(server, /sameIp[\s\S]*length >= 3/);
  assert.match(schema, /trial_claims_fingerprint_v2_idx/i);
  assert.match(server, /sameFingerprintV2/);
  assert.match(membership, /fingerprintV2/);
});

test("public authentication actions have per-network abuse limits", () => {
  const auth = fs.readFileSync(path.join(root, "api/auth.js"), "utf8");
  assert.match(auth, /auth-signup.*5.*3600/);
  assert.match(auth, /auth-login.*20.*600/);
  assert.match(auth, /auth-recovery.*5.*3600/);
});

test("payment and billing requests include JSON so LiteSpeed routes their POSTs", () => {
  const membership = fs.readFileSync(path.join(root, "membership.js"), "utf8");
  assert.match(membership, /authorizedFetch\(endpoint, \{method:"POST", body:"\{\}"\}\)/);
  assert.match(membership, /authorizedFetch\("\/api\/stripe-portal", \{method:"POST", body:"\{\}"\}\)/);
});

test("client IP uses the proxy-appended address instead of a spoofed first value", () => {
  assert.equal(clientIp({headers:{"x-forwarded-for":"198.51.100.8, 203.0.113.27"}, socket:{remoteAddress:"127.0.0.1"}}), "203.0.113.27");
  assert.equal(clientIp({headers:{"x-forwarded-for":"203.0.113.27"}, socket:{remoteAddress:"127.0.0.1"}}), "203.0.113.27");
  assert.equal(clientIp({headers:{}, socket:{remoteAddress:"127.0.0.1"}}), "127.0.0.1");
});

test("Stripe access requires the expected paid USD amount", () => {
  assert.equal(stripeWebhook.isExpectedCheckoutPayment({payment_status:"paid", currency:"usd", amount_total:2000}), true);
  assert.equal(stripeWebhook.isExpectedCheckoutPayment({payment_status:"no_payment_required", currency:"usd", amount_total:0}), false);
  assert.equal(stripeWebhook.isExpectedCheckoutPayment({payment_status:"paid", currency:"usd", amount_total:100}), false);
  assert.equal(stripeWebhook.isExpectedCheckoutPayment({payment_status:"paid", currency:"eur", amount_total:2000}), false);
  assert.equal(stripeWebhook.isExpectedInvoicePayment({currency:"usd", amount_paid:2000}), true);
  assert.equal(stripeWebhook.isExpectedInvoicePayment({currency:"usd", amount_paid:1999}), false);
});

test("NOWPayments access requires a finished $20 USD order for a valid user", () => {
  const userId = "6a63a091-d96d-44dc-9823-bdd012345678";
  assert.equal(nowPaymentsWebhook.orderUserId(`sandboxed:${userId}:1788979000000`), userId);
  assert.equal(nowPaymentsWebhook.orderUserId("sandboxed:not-a-user:1788979000000"), "");
  assert.equal(nowPaymentsWebhook.isExpectedPayment({payment_status:"finished", price_currency:"usd", price_amount:20}), true);
  assert.equal(nowPaymentsWebhook.isExpectedPayment({payment_status:"finished", price_currency:"usd", price_amount:1}), false);
  assert.equal(nowPaymentsWebhook.isExpectedPayment({payment_status:"confirming", price_currency:"usd", price_amount:20}), false);
});
