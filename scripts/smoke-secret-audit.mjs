#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3003";
const requestOrigin = browserOriginFor(baseUrl);
const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const email = `secret-audit-${timestamp}@ownminutes.local`;
const password = `OwnMinutes-${timestamp}`;
const testIp = `198.51.${Math.floor(Math.random() * 200) + 1}.${Math.floor(Math.random() * 200) + 1}`;
const auditPath = process.env.OWNMINUTES_SECRET_AUDIT_LOG
  ? path.resolve(process.env.OWNMINUTES_SECRET_AUDIT_LOG)
  : path.join(process.cwd(), ".data", "auth", "secret-audit.jsonl");

async function main() {
  const beforeCount = readEvents().length;
  const register = await postJson(
    "/api/auth/register",
    {
      name: "Secret Audit Smoke",
      email,
      password,
    },
    null,
    { "x-forwarded-for": testIp },
  );
  const cookie = extractCookie(register.response);

  const save = await postJson(
    "/api/account/provider-credentials",
    {
      providerId: "volcano-asr",
      label: "Secret Audit ASR",
      fields: { VOLCANO_ASR_APP_ID: "secret-audit-app-id" },
      secrets: { VOLCANO_ASR_API_KEY: "smoke-secret-key-first" },
    },
    cookie,
  );
  const rotate = await postJson(
    "/api/account/provider-credentials",
    {
      providerId: "volcano-asr",
      label: "Secret Audit ASR Rotated",
      fields: { VOLCANO_ASR_APP_ID: "secret-audit-app-id" },
      secrets: { VOLCANO_ASR_API_KEY: "smoke-secret-key-rotated" },
    },
    cookie,
  );
  const switchAuth = await postJson(
    "/api/account/provider-credentials",
    {
      providerId: "volcano-asr",
      label: "Secret Audit ASR Legacy Auth",
      fields: { VOLCANO_ASR_APP_ID: "secret-audit-app-id" },
      secrets: { VOLCANO_ASR_TOKEN: "smoke-secret-token" },
      removeSecrets: ["VOLCANO_ASR_API_KEY"],
    },
    cookie,
  );
  const deleteProvider = await fetch(`${baseUrl}/api/account/provider-credentials?providerId=volcano-asr`, {
    method: "DELETE",
    headers: { Cookie: cookie, Origin: requestOrigin },
  });
  const deleteProviderPayload = await readJson(deleteProvider, "/api/account/provider-credentials");
  const deleteAccount = await fetch(`${baseUrl}/api/auth/delete`, {
    method: "DELETE",
    headers: { Cookie: cookie, Origin: requestOrigin },
  });
  const deleteAccountPayload = await readJson(deleteAccount, "/api/auth/delete", { allowError: true });

  const events = readEvents();
  const createdEvents = events.slice(beforeCount);
  const eventTypes = new Set(createdEvents.map((event) => event.eventType));
  const text = JSON.stringify(createdEvents);
  const summary = {
    exists: fs.existsSync(auditPath),
    registerOk: register.payload.ok === true,
    saveOk: save.payload.ok === true,
    rotateOk: rotate.payload.ok === true,
    authSwitchOk:
      switchAuth.payload.ok === true &&
      switchAuth.payload.credential?.configuredSecrets?.includes("VOLCANO_ASR_TOKEN") === true &&
      switchAuth.payload.credential?.configuredSecrets?.includes("VOLCANO_ASR_API_KEY") === false,
    rotatedPreviewChanged:
      save.payload.credential?.secretPreviews?.VOLCANO_ASR_API_KEY !== rotate.payload.credential?.secretPreviews?.VOLCANO_ASR_API_KEY,
    deleteProviderOk: deleteProviderPayload.ok === true,
    deleteAccountOk: deleteAccountPayload.ok === true,
    createdEventCount: createdEvents.length,
    hasSaveEvent: eventTypes.has("provider_secret_save"),
    hasRotateEvent: eventTypes.has("provider_secret_rotate"),
    hasDeleteEvent: eventTypes.has("provider_secret_delete"),
    schemaValid: createdEvents.every(
      (event) =>
        typeof event.id === "string" &&
        typeof event.eventType === "string" &&
        /^user_[a-f0-9]{24}$/.test(String(event.userRef || "")) &&
        /^provider_[a-f0-9]{24}$/.test(String(event.providerRef || "")) &&
        Array.isArray(event.secretRefs) &&
        event.secretRefs.every((reference) => /^secret_[a-f0-9]{24}$/.test(reference)) &&
        !("userId" in event) &&
        !("providerId" in event) &&
        !("secretNames" in event) &&
        Object.keys(event.metadata || {}).join(",") === "reason" &&
        typeof event.createdAt === "string",
    ),
    accountDeletionAuditIsPseudonymized:
      createdEvents
        .filter((event) => event.eventType === "provider_secret_delete" && event.metadata?.reason === "account_delete")
        .every((event) => /^user_[a-f0-9]{24}$/.test(String(event.userRef || "")) && !("userId" in event)),
    rotateHasReason: createdEvents.some(
      (event) => event.eventType === "provider_secret_rotate" && event.metadata?.reason === "provider_update",
    ),
    deleteHasReason: createdEvents.some(
      (event) => event.eventType === "provider_secret_delete" && event.metadata?.reason === "provider_delete",
    ),
    authSwitchHasReason: createdEvents.some(
      (event) =>
        event.eventType === "provider_secret_delete" &&
        event.metadata?.reason === "provider_auth_switch" &&
        event.secretRefs.length === 1,
    ),
    leaksSecrets:
      text.includes("smoke-secret-key") ||
      text.includes("volcano-asr") ||
      text.includes("VOLCANO_ASR_API_KEY") ||
      text.includes("VOLCANO_ASR_TOKEN") ||
      text.includes("encryptedSecrets") ||
      text.includes("passwordHash") ||
      text.includes("AKL") ||
      text.includes("sk-proj") ||
      text.includes("Secret Access Key") ||
      /[A-Za-z0-9+/=_-]{48,}/.test(text),
  };

  console.log(JSON.stringify(summary, null, 2));

  if (
    !summary.exists ||
    !summary.registerOk ||
    !summary.saveOk ||
    !summary.rotateOk ||
    !summary.authSwitchOk ||
    !summary.rotatedPreviewChanged ||
    !summary.deleteProviderOk ||
    !summary.deleteAccountOk ||
    summary.createdEventCount < 5 ||
    !summary.hasSaveEvent ||
    !summary.hasRotateEvent ||
    !summary.hasDeleteEvent ||
    !summary.schemaValid ||
    !summary.accountDeletionAuditIsPseudonymized ||
    !summary.rotateHasReason ||
    !summary.deleteHasReason ||
    !summary.authSwitchHasReason ||
    summary.leaksSecrets
  ) {
    process.exitCode = 1;
  }
}

function readEvents() {
  const raw = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, "utf8").trim() : "";
  return raw
    ? raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

async function postJson(pathname, body, cookie, extraHeaders = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: requestOrigin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const payload = await readJson(response, pathname);
  return { response, payload };
}

async function readJson(response, pathname, options = {}) {
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON from ${pathname}: ${error.message}\n${text.slice(0, 500)}`);
  }

  if (!response.ok && !options.allowError) {
    throw new Error(`HTTP ${response.status} from ${pathname}: ${JSON.stringify(payload)}`);
  }

  return payload;
}

function extractCookie(response) {
  const cookie = response.headers.get("set-cookie");
  if (!cookie) throw new Error("Missing set-cookie header");
  return cookie.split(";")[0];
}

function browserOriginFor(url) {
  const origin = new URL(process.env.SMOKE_ORIGIN || url);
  if (!process.env.SMOKE_ORIGIN && origin.hostname === "127.0.0.1") {
    origin.hostname = "localhost";
  }
  return origin.origin;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
