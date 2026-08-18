#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import WebSocket from "ws";

loadDotEnvLocal();

const apiKey = process.env.VOLCANO_ASR_API_KEY?.trim();
const appId = process.env.VOLCANO_ASR_APP_ID?.trim() || process.env.VOLCANO_APP_ID?.trim();
const accessToken = process.env.VOLCANO_ASR_TOKEN?.trim();
const resourceId = process.env.VOLCANO_REALTIME_ASR_RESOURCE_ID?.trim() || "volc.seedasr.sauc.duration";
const wsUrl = process.env.VOLCANO_ASR_WS_URL?.trim() || "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";

if (!apiKey && !(appId && accessToken)) fail("Missing Volcano realtime API Key or AppID+AccessToken credentials.");
if (!isSecureWebSocketUrl(wsUrl)) fail("VOLCANO_ASR_WS_URL must use wss://.");

const requestId = randomUUID();
const headers = {
  "X-Api-Connect-Id": requestId,
  "X-Api-Request-Id": requestId,
  "X-Api-Resource-Id": resourceId,
  "X-Api-Sequence": "-1",
  ...(apiKey
    ? { "X-Api-Key": apiKey }
    : { "X-Api-App-Key": appId, "X-Api-Access-Key": accessToken }),
};

const result = await probeHandshake(wsUrl, headers);
console.log(
  JSON.stringify(
    {
      ok: result.opened,
      endpointHost: new URL(wsUrl).hostname,
      endpointPath: new URL(wsUrl).pathname,
      resourceId,
      credentialMode: apiKey ? "api-key" : "app-token",
      opened: result.opened,
      httpStatus: result.httpStatus,
      diagnostic: result.diagnostic,
      secretsPrinted: false,
    },
    null,
    2,
  ),
);

if (!result.opened) process.exitCode = 1;

function probeHandshake(url, authHeaders) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = new WebSocket(url, { handshakeTimeout: 8_000, headers: authHeaders });
    const timer = setTimeout(() => finish({ opened: false, diagnostic: "WebSocket handshake timed out." }), 9_000);
    timer.unref?.();

    socket.once("open", () => finish({ opened: true, diagnostic: "Realtime WebSocket authentication succeeded." }));
    socket.once("unexpected-response", (_request, response) => {
      finish({
        opened: false,
        httpStatus: response.statusCode,
        diagnostic:
          response.statusCode === 403
            ? "Realtime WebSocket authentication or service entitlement was rejected."
            : `Realtime WebSocket handshake returned HTTP ${response.statusCode}.`,
      });
    });
    socket.once("error", (error) => finish({ opened: false, diagnostic: scrubError(error) }));

    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.terminate();
      } catch {
        // The socket may not have reached an open state.
      }
      resolve(value);
    }
  });
}

function isSecureWebSocketUrl(value) {
  try {
    return new URL(value).protocol === "wss:";
  } catch {
    return false;
  }
}

function loadDotEnvLocal() {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    const key = trimmed.slice(0, index);
    if (process.env[key] !== undefined) continue;
    process.env[key] = stripQuotes(trimmed.slice(index + 1));
  }
}

function stripQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function scrubError(error) {
  const secrets = [apiKey, appId, accessToken].filter(Boolean);
  return secrets.reduce(
    (output, secret) => output.split(secret).join("[redacted]"),
    error instanceof Error ? error.message : "Realtime WebSocket probe failed.",
  );
}

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message, secretsPrinted: false }, null, 2));
  process.exit(1);
}
