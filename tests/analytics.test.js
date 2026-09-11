const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  BROWSER_EVENTS,
  cleanAttribution,
  cleanProperties,
  validVisitorId,
  visitorHash,
  attributionFromRows,
  posthogHost,
  recordAnalyticsEvent
} = require("../lib/analytics");

const root = path.join(__dirname, "..");

test("the public analytics endpoint cannot submit financial or access events", () => {
  assert.deepEqual([...BROWSER_EVENTS].sort(), ["auth_started", "landing_view"]);
  assert.equal(BROWSER_EVENTS.has("membership_activated"), false);
  assert.equal(BROWSER_EVENTS.has("trial_started"), false);
  const endpoint = fs.readFileSync(path.join(root, "api/analytics.js"), "utf8");
  assert.match(endpoint, /BROWSER_EVENTS\.has\(event\)/);
  assert.match(endpoint, /eventKey:`browser:\$\{body\.eventId\}`/);
  assert.match(endpoint, /rateLimit\(request, "analytics", 30, 60\)/);
});

test("analytics inputs retain only bounded campaign and event properties", () => {
  const attribution = cleanAttribution({
    firstTouch:{source:" Newsletter ", campaign:"fall", landingPath:"/welcome", email:"private@example.com"},
    lastTouch:{source:"SEARCH", landingPath:"/?secret=yes", referrer:"EXAMPLE.COM"}
  });
  assert.equal(attribution.first.source, "newsletter");
  assert.equal(attribution.first.landing_path, "/welcome");
  assert.equal(attribution.first.email, undefined);
  assert.equal(attribution.last.source, "search");
  assert.equal(attribution.last.landing_path, "/");
  assert.equal(attribution.last.referrer, "example.com");

  const properties = cleanProperties({plan:"MONTHLY", provider:"STRIPE", amount:6.999, email:"private@example.com", title:"Private title"});
  assert.deepEqual(properties, {plan:"monthly", provider:"stripe", amount:7});
});

test("visitor IDs are validated and irreversibly replaced before storage", () => {
  const id = "54d293b8-dd24-4e41-91f8-540d99f16266";
  assert.equal(validVisitorId(id), true);
  assert.equal(validVisitorId("attacker-chosen"), false);
  const hashed = visitorHash(id);
  assert.equal(hashed.length, 64);
  assert.notEqual(hashed, id);
  assert.equal(visitorHash(id), hashed);
});

test("user attribution combines the earliest first touch with the latest last touch", () => {
  const result = attributionFromRows([
    {visitor_hash:"b", first_seen_at:"2026-09-10T00:00:00Z", last_seen_at:"2026-09-11T00:00:00Z", first_source:"direct", last_source:"newsletter", last_campaign:"launch"},
    {visitor_hash:"a", first_seen_at:"2026-09-01T00:00:00Z", last_seen_at:"2026-09-02T00:00:00Z", first_source:"reddit", first_campaign:"teaser", last_source:"reddit"}
  ]);
  assert.equal(result.visitorHash, "b");
  assert.equal(result.attribution.first.source, "reddit");
  assert.equal(result.attribution.first.campaign, "teaser");
  assert.equal(result.attribution.last.source, "newsletter");
  assert.equal(result.attribution.last.campaign, "launch");
});

test("PostHog forwarding accepts only official US and EU ingest hosts", () => {
  const original = process.env.POSTHOG_HOST;
  try {
    process.env.POSTHOG_HOST = "https://eu.i.posthog.com/";
    assert.equal(posthogHost(), "https://eu.i.posthog.com");
    process.env.POSTHOG_HOST = "https://attacker.example";
    assert.equal(posthogHost(), "");
  } finally {
    if (original === undefined) delete process.env.POSTHOG_HOST;
    else process.env.POSTHOG_HOST = original;
  }
});

test("captured events store and forward only hashed, allowlisted data", async () => {
  const originalFetch = global.fetch;
  const variableNames = ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY", "DEVICE_HASH_SECRET", "POSTHOG_PROJECT_TOKEN", "POSTHOG_HOST"];
  const originals = Object.fromEntries(variableNames.map((name) => [name, process.env[name]]));
  const requests = [];
  Object.assign(process.env, {
    SUPABASE_URL:"https://project.supabase.co",
    SUPABASE_PUBLISHABLE_KEY:"publishable",
    SUPABASE_SECRET_KEY:"sb_secret_test",
    DEVICE_HASH_SECRET:"test-device-secret",
    POSTHOG_PROJECT_TOKEN:"phc_test",
    POSTHOG_HOST:"https://us.i.posthog.com"
  });
  global.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({url:String(url), body});
    if (String(url).includes("/marketing_events?")) {
      return new Response(JSON.stringify([{id:"event-row"}]), {status:201, headers:{"Content-Type":"application/json"}});
    }
    if (String(url).includes("/rest/v1/")) {
      return new Response(null, {status:204});
    }
    return new Response(JSON.stringify({status:"ok"}), {status:200, headers:{"Content-Type":"application/json"}});
  };
  try {
    const rawVisitor = "54d293b8-dd24-4e41-91f8-540d99f16266";
    const result = await recordAnalyticsEvent({
      event:"landing_view",
      visitorId:rawVisitor,
      attribution:{firstTouch:{source:"reddit", landingPath:"/"}, lastTouch:{source:"reddit", landingPath:"/"}},
      properties:{campaign:"ignored-property", email:"private@example.com"},
      eventKey:"browser:2cf0845d-170d-42ef-8a7e-7c018eb13687"
    });
    assert.equal(result.recorded, true);
    const databaseEvent = requests.find((request) => request.url.includes("/marketing_events?"));
    const posthog = requests.find((request) => request.url.includes("posthog.com/i/v0/e/"));
    assert.equal(databaseEvent.body.visitor_hash, visitorHash(rawVisitor));
    assert.equal(databaseEvent.body.properties.email, undefined);
    assert.equal(posthog.body.distinct_id.includes(rawVisitor), false);
    assert.equal(posthog.body.properties.first_source, "reddit");
    assert.equal(posthog.body.properties.$process_person_profile, false);
    assert.equal(JSON.stringify(requests).includes("private@example.com"), false);
  } finally {
    global.fetch = originalFetch;
    for (const [name, value] of Object.entries(originals)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("the analytics schema is private to service_role and the browser loads no tracker", () => {
  const schema = fs.readFileSync(path.join(root, "supabase-analytics.sql"), "utf8");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  assert.match(schema, /alter table public\.marketing_attribution enable row level security/i);
  assert.match(schema, /alter table public\.marketing_events enable row level security/i);
  assert.match(schema, /revoke all on table public\.marketing_events from public, anon, authenticated/i);
  assert.match(schema, /grant all on table public\.marketing_events to service_role/i);
  assert.match(schema, /revoke all on function public\.record_marketing_attribution[\s\S]*from public, anon, authenticated/i);
  assert.match(server, /"\/api\/analytics"/);
  assert.doesNotMatch(html, /posthog|analytics\.js/i);
});

test("server-confirmed lifecycle events are emitted by their authoritative workflows", () => {
  const auth = fs.readFileSync(path.join(root, "api/auth.js"), "utf8");
  const play = fs.readFileSync(path.join(root, "api/play.js"), "utf8");
  const checkout = fs.readFileSync(path.join(root, "api/stripe-checkout.js"), "utf8");
  const stripe = fs.readFileSync(path.join(root, "api/stripe-webhook.js"), "utf8");
  const crypto = fs.readFileSync(path.join(root, "api/nowpayments-ipn.js"), "utf8");
  assert.match(auth, /event:"account_created"/);
  assert.match(auth, /event:"login_completed"/);
  assert.match(play, /event:"trial_started"/);
  assert.match(checkout, /event:"checkout_started"/);
  assert.match(stripe, /event:"membership_activated"/);
  assert.match(stripe, /"renewal_paid"/);
  assert.match(stripe, /event:"payment_failed"/);
  assert.match(stripe, /event:"membership_cancelled"/);
  assert.match(stripe, /event:"membership_reversed"/);
  assert.match(crypto, /event:renewing \? "renewal_paid" : "membership_activated"/);
});
