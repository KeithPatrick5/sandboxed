"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = __dirname;
const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
const MAX_CONTENT_LENGTH = 1024 * 1024;

const API_ROUTES = new Map([
  ["/api/auth", require("./api/auth")],
  ["/api/catalog", require("./api/catalog")],
  ["/api/config", require("./api/config")],
  ["/api/devices", require("./api/devices")],
  ["/api/heartbeat", require("./api/heartbeat")],
  ["/api/me", require("./api/me")],
  ["/api/nowpayments-invoice", require("./api/nowpayments-invoice")],
  ["/api/nowpayments-ipn", require("./api/nowpayments-ipn")],
  ["/api/nowpayments-reconcile", require("./api/nowpayments-reconcile")],
  ["/api/play", require("./api/play")],
  ["/api/stripe-checkout", require("./api/stripe-checkout")],
  ["/api/stripe-portal", require("./api/stripe-portal")],
  ["/api/stripe-webhook", require("./api/stripe-webhook")]
]);

const STATIC_ROUTES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/membership.js", ["membership.js", "text/javascript; charset=utf-8"]],
  ["/privacy", ["privacy.html", "text/html; charset=utf-8"]],
  ["/privacy.html", ["privacy.html", "text/html; charset=utf-8"]],
  ["/terms", ["terms.html", "text/html; charset=utf-8"]],
  ["/terms.html", ["terms.html", "text/html; charset=utf-8"]]
]);

function setSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (process.env.NODE_ENV === "production") {
    response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://image.tmdb.org; connect-src 'self'; frame-src https://player.videasy.to; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
  );
}

function addResponseHelpers(response) {
  response.status = function status(code) {
    response.statusCode = code;
    return response;
  };
  response.json = function json(payload) {
    if (!response.hasHeader("Content-Type")) {
      response.setHeader("Content-Type", "application/json; charset=utf-8");
    }
    response.end(JSON.stringify(payload));
    return response;
  };
}

function sendPlain(response, status, message) {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(message);
}

function serveStatic(request, response, pathname) {
  const entry = STATIC_ROUTES.get(pathname);
  if (!entry) return false;
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendPlain(response, 405, "Method not allowed");
    return true;
  }

  const [filename, contentType] = entry;
  try {
    const body = fs.readFileSync(path.join(ROOT, filename));
    response.statusCode = 200;
    response.setHeader("Content-Type", contentType);
    response.setHeader("Cache-Control", filename.endsWith(".html") ? "no-cache" : "public, max-age=300");
    response.setHeader("Content-Length", body.length);
    response.end(request.method === "HEAD" ? undefined : body);
  } catch (error) {
    console.error("[static]", {pathname, message:error.message});
    sendPlain(response, 500, "The site is temporarily unavailable.");
  }
  return true;
}

async function app(request, response) {
  setSecurityHeaders(response);
  addResponseHelpers(response);

  let url;
  try {
    url = new URL(request.url, "http://localhost");
  } catch {
    return sendPlain(response, 400, "Bad request");
  }

  const hostname = String(request.headers.host || "").split(":")[0].toLowerCase();
  if (hostname === "www.sandboxed.lol") {
    response.statusCode = 308;
    response.setHeader("Location", `https://sandboxed.lol${url.pathname}${url.search}`);
    response.setHeader("Cache-Control", "public, max-age=3600");
    return response.end();
  }

  if (url.pathname === "/healthz") {
    if (request.method !== "GET" && request.method !== "HEAD") return sendPlain(response, 405, "Method not allowed");
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    return response.end(request.method === "HEAD" ? undefined : JSON.stringify({ok:true}));
  }

  const contentLength = Number.parseInt(request.headers["content-length"], 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_CONTENT_LENGTH) {
    return sendPlain(response, 413, "Request body is too large");
  }

  const handler = API_ROUTES.get(url.pathname);
  if (handler) {
    request.query = Object.fromEntries(url.searchParams.entries());
    try {
      return await handler(request, response);
    } catch (error) {
      console.error("[api]", {pathname:url.pathname, message:error.message, stack:error.stack});
      if (!response.headersSent) return response.status(500).json({error:"The service is temporarily unavailable."});
      return response.end();
    }
  }

  if (serveStatic(request, response, url.pathname)) return;
  return sendPlain(response, 404, "Not found");
}

function createServer() {
  return http.createServer((request, response) => {
    app(request, response).catch((error) => {
      console.error("[server]", {message:error.message, stack:error.stack});
      if (!response.headersSent) sendPlain(response, 500, "The service is temporarily unavailable.");
      else response.end();
    });
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, () => console.log(`Sandboxed listening on port ${PORT}`));
}

module.exports = {app, createServer, setSecurityHeaders};
