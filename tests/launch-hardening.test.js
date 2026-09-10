const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const stripeWebhook = require("../api/stripe-webhook");
const nowPaymentsWebhook = require("../api/nowpayments-ipn");
const {clientIp} = require("../lib/server");

const root = path.join(__dirname, "..");
process.env.STRIPE_PRICE_ID = "price_sandboxed_annual";

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
  const schema = fs.readFileSync(path.join(root, "supabase-setup.sql"), "utf8");
  assert.match(server, /rpc\/register_device_atomic/);
  assert.match(server, /rpc\/revoke_device_atomic/);
  assert.match(schema, /device_key_hash = 'retired:'/);
  assert.match(schema, /pg_advisory_xact_lock[\s\S]*register_device_atomic|register_device_atomic[\s\S]*pg_advisory_xact_lock/i);
  assert.match(schema, /revoke all on function public\.register_device_atomic[\s\S]*from public, anon, authenticated/i);
  assert.match(schema, /revoke all on function public\.revoke_device_atomic[\s\S]*from public, anon, authenticated/i);
});

test("signup supports password managers and rejects mismatched confirmation", () => {
  const membership = fs.readFileSync(path.join(root, "membership.js"), "utf8");
  assert.match(membership, /autocomplete="username"/);
  assert.match(membership, /autocomplete="\$\{signup \? "new-password" : "current-password"\}"/);
  assert.match(membership, /name="confirmPassword"/);
  assert.match(membership, /password !== confirmPassword/);
  assert.match(membership, /Passwords do not match\./);
});

test("repeat-trial denial is shown before playback and does not masquerade as a new trial", () => {
  const membership = fs.readFileSync(path.join(root, "membership.js"), "utf8");
  const me = fs.readFileSync(path.join(root, "api/me.js"), "utf8");
  assert.match(me, /trialEligibility/);
  assert.match(membership, /TRIAL UNAVAILABLE/);
  assert.match(membership, /PAYMENT REQUIRED/);
});

test("stream-limit errors use a dedicated message instead of the account screen", () => {
  const membership = fs.readFileSync(path.join(root, "membership.js"), "utf8");
  const server = fs.readFileSync(path.join(root, "lib/server.js"), "utf8");
  const schema = fs.readFileSync(path.join(root, "supabase-setup.sql"), "utf8");
  assert.match(membership, /view === "stream-limit"/);
  assert.match(membership, /error\.code === "STREAM_LIMIT"/);
  assert.match(membership, /openModal\("stream-limit"/);
  assert.match(server, /rpc\/begin_watch_session_atomic/);
  assert.match(schema, /pg_advisory_xact_lock/);
  assert.match(schema, /revoke all on function public\.begin_watch_session_atomic[\s\S]*from public, anon, authenticated/i);
  assert.match(schema, /grant execute on function public\.begin_watch_session_atomic[\s\S]*to service_role/i);
});

test("a rejected heartbeat unloads the active player", () => {
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const membership = fs.readFileSync(path.join(root, "membership.js"), "utf8");
  assert.match(membership, /catch\(handleHeartbeatRejection\)/);
  assert.match(membership, /sandboxed:playback-rejected/);
  assert.match(app, /sandboxed:playback-rejected/);
  assert.match(app, /frame\.src = "about:blank"/);
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
  const checkout = {payment_status:"paid", currency:"usd", amount_total:3000, subscription:"sub_expected", metadata:{price_id:"price_sandboxed_annual"}};
  const invoice = {currency:"usd", amount_paid:3000, parent:{subscription_details:{subscription:"sub_expected"}}, lines:{data:[{pricing:{price_details:{price:"price_sandboxed_annual"}}}]}};
  assert.equal(stripeWebhook.isExpectedCheckoutPayment(checkout), true);
  assert.equal(stripeWebhook.isExpectedCheckoutPayment({...checkout, metadata:{price_id:"price_wrong"}}), false);
  assert.equal(stripeWebhook.isExpectedCheckoutPayment({...checkout, amount_total:100}), false);
  assert.equal(stripeWebhook.isExpectedCheckoutPayment({...checkout, currency:"eur"}), false);
  assert.equal(stripeWebhook.isExpectedInvoicePayment(invoice, "sub_expected"), true);
  assert.equal(stripeWebhook.isExpectedInvoicePayment({...invoice, amount_paid:2999}, "sub_expected"), false);
  assert.equal(stripeWebhook.isExpectedInvoicePayment(invoice, "sub_other"), false);
  assert.equal(stripeWebhook.isExpectedInvoicePayment({...invoice, lines:{data:[]}}, "sub_expected"), false);
});

test("Stripe refunds and disputes suspend access while won disputes restore it", () => {
  assert.equal(stripeWebhook.stripeAccessAction("charge.refunded", {amount_refunded:3000}), "refunded");
  assert.equal(stripeWebhook.stripeAccessAction("charge.refunded", {amount_refunded:100}), "refunded");
  assert.equal(stripeWebhook.stripeAccessAction("charge.refunded", {amount_refunded:0}), "");
  assert.equal(stripeWebhook.stripeAccessAction("charge.dispute.created", {status:"needs_response"}), "disputed");
  assert.equal(stripeWebhook.stripeAccessAction("charge.dispute.closed", {status:"lost"}), "disputed");
  assert.equal(stripeWebhook.stripeAccessAction("charge.dispute.closed", {status:"won"}), "active");
  const server = fs.readFileSync(path.join(root, "lib/server.js"), "utf8");
  assert.match(server, /suspendMembershipAccess[\s\S]*watch_sessions/);
});

test("checkout prices are generated from the same server-side $30 policy", () => {
  const stripeCheckout = fs.readFileSync(path.join(root, "api/stripe-checkout.js"), "utf8");
  const nowPaymentsInvoice = fs.readFileSync(path.join(root, "api/nowpayments-invoice.js"), "utf8");
  assert.match(stripeCheckout, /line_items\[0\]\[price\]/);
  assert.match(stripeCheckout, /STRIPE_PRICE_ID/);
  assert.match(stripeCheckout, /Idempotency-Key/);
  assert.match(stripeCheckout, /stripe-checkout:/);
  assert.match(nowPaymentsInvoice, /price_amount:ANNUAL_PRICE_USD/);
  assert.match(nowPaymentsInvoice, /invoice_created/);
  assert.match(nowPaymentsInvoice, /reused:true/);
});

test("NOWPayments access requires a finished $30 USD order for a valid user", () => {
  const userId = "6a63a091-d96d-44dc-9823-bdd012345678";
  assert.equal(nowPaymentsWebhook.orderUserId(`sandboxed:${userId}:1788979000000`), userId);
  assert.equal(nowPaymentsWebhook.orderUserId("sandboxed:not-a-user:1788979000000"), "");
  assert.equal(nowPaymentsWebhook.isExpectedPayment({payment_status:"finished", price_currency:"usd", price_amount:30}), true);
  assert.equal(nowPaymentsWebhook.isExpectedPayment({payment_status:"finished", price_currency:"usd", price_amount:1}), false);
  assert.equal(nowPaymentsWebhook.isExpectedPayment({payment_status:"confirming", price_currency:"usd", price_amount:30}), false);
});

test("NOWPayments callbacks retain status progression and a deterministic access date", () => {
  const fields = nowPaymentsWebhook.paymentEventFields("payment-1", "user-1", {
    payment_status:"finished",
    price_currency:"usd",
    price_amount:30
  }, "activating", "2027-09-10T00:00:00.000Z");
  assert.equal(fields.status, "activating");
  assert.equal(fields.payload.access_until, "2027-09-10T00:00:00.000Z");
  const source = fs.readFileSync(path.join(root, "api/nowpayments-ipn.js"), "utf8");
  assert.match(source, /select=id,status,payload/);
  assert.match(source, /method:"PATCH"/);
  assert.match(source, /activated:true/);
});

test("NOWPayments invoices can recover from a missed final callback", () => {
  const invoice = fs.readFileSync(path.join(root, "api/nowpayments-invoice.js"), "utf8");
  const reconcile = fs.readFileSync(path.join(root, "api/nowpayments-reconcile.js"), "utf8");
  const membership = fs.readFileSync(path.join(root, "membership.js"), "utf8");
  const standalone = fs.readFileSync(path.join(root, "server.js"), "utf8");
  assert.match(invoice, /provider:"nowpayments_invoice"/);
  assert.match(reconcile, /requireUser\(request\)/);
  assert.match(reconcile, /orderUserId\(orderId\) !== user\.id/);
  assert.match(reconcile, /api\.nowpayments\.io\/v1\/payment\//);
  assert.match(reconcile, /processPayment\(payment\)/);
  assert.match(membership, /\/api\/nowpayments-reconcile/);
  assert.match(standalone, /\/api\/nowpayments-reconcile/);
});
