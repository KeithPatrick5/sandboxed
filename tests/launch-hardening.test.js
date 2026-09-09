const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const stripeWebhook = require("../api/stripe-webhook");
const nowPaymentsWebhook = require("../api/nowpayments-ipn");

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
