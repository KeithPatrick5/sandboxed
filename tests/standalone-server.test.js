const test = require("node:test");
const assert = require("node:assert/strict");
const {once} = require("node:events");
const http = require("node:http");
const {createServer} = require("../server");

async function withServer(run) {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("standalone server serves the site, clean legal URLs, and security headers", async () => {
  await withServer(async (origin) => {
    for (const pathname of ["/", "/terms", "/privacy", "/app.js", "/membership.js", "/styles.css"]) {
      const response = await fetch(`${origin}${pathname}`);
      assert.equal(response.status, 200, pathname);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("x-frame-options"), "DENY");
      assert.match(response.headers.get("content-security-policy"), /frame-src https:\/\/player\.videasy\.to/);
    }

    const health = await fetch(`${origin}/healthz`).then((response) => response.json());
    assert.deepEqual(health, {ok:true});
    assert.equal((await fetch(`${origin}/.env`)).status, 404);
    assert.equal((await fetch(`${origin}/server.js`)).status, 404);
  });
});

test("standalone server adapts query strings and Vercel response helpers", async () => {
  await withServer(async (origin) => {
    const config = await fetch(`${origin}/api/config`);
    assert.equal(config.status, 200);
    assert.equal(typeof (await config.json()).membershipEnabled, "boolean");

    const shortSearch = await fetch(`${origin}/api/catalog?mode=search&q=x`);
    assert.equal(shortSearch.status, 400);
    assert.deepEqual(await shortSearch.json(), {error:"Enter at least two characters."});
  });
});

test("standalone server preserves JSON and raw webhook request bodies", async () => {
  await withServer(async (origin) => {
    const auth = await fetch(`${origin}/api/auth`, {
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({action:"unknown"})
    });
    assert.equal(auth.status, 400);
    assert.equal((await auth.json()).code, "INVALID_ACTION");

    const previousSecret = process.env.STRIPE_WEBHOOK_SECRET;
    process.env.STRIPE_WEBHOOK_SECRET = "test-webhook-secret";
    try {
      const webhook = await fetch(`${origin}/api/stripe-webhook`, {
        method:"POST",
        headers:{"content-type":"application/json", "stripe-signature":"invalid"},
        body:JSON.stringify({id:"evt_test"})
      });
      assert.equal(webhook.status, 400);
    } finally {
      if (previousSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
      else process.env.STRIPE_WEBHOOK_SECRET = previousSecret;
    }
  });
});

test("standalone server rejects oversized declared request bodies", async () => {
  await withServer(async (origin) => {
    const status = await new Promise((resolve, reject) => {
      const request = http.request(`${origin}/api/auth`, {
        method:"POST",
        headers:{"content-type":"application/json", "content-length":String(1024 * 1024 + 1)}
      }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal(status, 413);
  });
});
