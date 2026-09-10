"use strict";

const crypto = require("crypto");

function redact(value) {
  return String(value || "")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[uuid]")
    .replace(/\b(?:sk_(?:live|test)|rk_(?:live|test)|whsec_|eyJ)[A-Za-z0-9._-]{12,}\b/g, "[secret]")
    .slice(0, 1000);
}

function sentryEnvelope(error, context = {}, now = new Date()) {
  const dsnValue = String(process.env.SENTRY_DSN || "").trim();
  if (!dsnValue) return null;

  let dsn;
  try { dsn = new URL(dsnValue); } catch { return null; }
  const path = dsn.pathname.replace(/\/+$/, "");
  const projectId = path.split("/").pop();
  if (dsn.protocol !== "https:" || !dsn.username || !/^\d+$/.test(projectId || "")) return null;

  const prefix = path.slice(0, -(projectId.length + 1));
  const endpoint = new URL(`${prefix}/api/${projectId}/envelope/`, dsn.origin);
  endpoint.searchParams.set("sentry_version", "7");
  endpoint.searchParams.set("sentry_key", dsn.username);
  endpoint.searchParams.set("sentry_client", "sandboxed-node/1.0");

  const eventId = crypto.randomBytes(16).toString("hex");
  const sentAt = now.toISOString();
  const status = Number(error?.status) || 500;
  const route = String(context.route || "server").replace(/[^a-zA-Z0-9_./:-]/g, "").slice(0, 120);
  const event = {
    event_id:eventId,
    timestamp:sentAt,
    platform:"node",
    level:"error",
    environment:String(process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "production").slice(0, 64),
    ...(process.env.SENTRY_RELEASE ? {release:String(process.env.SENTRY_RELEASE).slice(0, 200)} : {}),
    logger:"sandboxed.server",
    transaction:route,
    exception:{values:[{type:redact(error?.name || "Error"), value:redact(error?.message || "Unexpected server error")}]},
    tags:{code:redact(error?.code || "SERVER_ERROR"), status:String(status)}
  };
  const body = [
    JSON.stringify({event_id:eventId, sent_at:sentAt, dsn:dsnValue}),
    JSON.stringify({type:"event", content_type:"application/json"}),
    JSON.stringify(event)
  ].join("\n");
  return {url:endpoint.href, body};
}

async function reportServerError(error, context = {}) {
  const envelope = sentryEnvelope(error, context);
  if (!envelope) return false;
  try {
    const response = await fetch(envelope.url, {
      method:"POST",
      headers:{"Content-Type":"application/x-sentry-envelope"},
      body:envelope.body,
      signal:AbortSignal.timeout(2500)
    });
    return response.ok;
  } catch {
    return false;
  }
}

module.exports = {redact, sentryEnvelope, reportServerError};
