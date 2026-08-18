#!/usr/bin/env node

import { extractPasswordResetToken } from "../apps/mobile/src/password-reset.ts";
import { extractEmailVerificationToken } from "../apps/mobile/src/email-verification.ts";

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3003";
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const email = `smoke-mobile-reset-${stamp}@ownminutes.local`;
const oldPassword = `OwnMinutes-${stamp}`;
const newPassword = `Reset-${stamp}-New`;
const testIp = `198.51.${Math.floor(Math.random() * 200) + 1}.${Math.floor(Math.random() * 200) + 1}`;

async function main() {
  const register = await postJson("/api/auth/register", { name: "Mobile Reset Smoke", email, password: oldPassword });
  const resetRequest = await postJson("/api/auth/password-reset/request", { email });
  const rawToken = resetRequest.payload.resetToken || "";
  const resetLink = `${baseUrl}/reset-password#token=${encodeURIComponent(rawToken)}`;
  const legacyQueryResetLink = `${baseUrl}/reset-password?token=${encodeURIComponent(rawToken)}`;
  const tokenFromLink = extractPasswordResetToken(resetLink);
  const tokenFromLegacyQueryLink = extractPasswordResetToken(legacyQueryResetLink);
  const tokenFromRaw = extractPasswordResetToken(rawToken);
  const verificationTokenFromFragment = extractEmailVerificationToken(`${baseUrl}/verify-email#token=${encodeURIComponent(rawToken)}`);
  const verificationTokenFromLegacyQuery = extractEmailVerificationToken(`${baseUrl}/verify-email?token=${encodeURIComponent(rawToken)}`);

  const confirm = await postJson("/api/auth/password-reset/confirm", { token: tokenFromLink, newPassword });
  const oldLogin = await postJson("/api/auth/login", { email, password: oldPassword }, { allowError: true });
  const newLogin = await postJson("/api/auth/login", { email, password: newPassword });
  const reuse = await postJson("/api/auth/password-reset/confirm", { token: tokenFromRaw, newPassword: `${newPassword}-again` }, { allowError: true });
  const cookie = extractCookie(newLogin.response);
  const sessionToken = extractSessionToken(cookie);
  const cookieOnlyDelete = await fetch(`${baseUrl}/api/auth/delete`, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  const cookieOnlyDeletePayload = await cookieOnlyDelete.json();
  const deleted = await fetch(`${baseUrl}/api/auth/delete`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  const deletePayload = await deleted.json();

  const checks = {
    registerOk: register.payload.ok === true,
    resetRequestOk: resetRequest.payload.ok === true,
    resetTokenExposedLocally: rawToken.length >= 24,
    parsesHttpsResetLink: tokenFromLink === rawToken,
    parsesLegacyQueryResetLink: tokenFromLegacyQueryLink === rawToken,
    parsesRawToken: tokenFromRaw === rawToken,
    parsesVerificationFragmentLink: verificationTokenFromFragment === rawToken,
    parsesLegacyVerificationQueryLink: verificationTokenFromLegacyQuery === rawToken,
    rejectsMissingToken: extractPasswordResetToken(`${baseUrl}/reset-password`) === null,
    rejectsShortToken: extractPasswordResetToken("short-token") === null,
    rejectsUnrelatedClipboardText: extractPasswordResetToken("meeting notes") === null,
    rejectsTokenOnUnrelatedUrl: extractPasswordResetToken(`https://example.com/other?token=${rawToken}`) === null,
    confirmOk: confirm.payload.ok === true,
    oldPasswordRejected: oldLogin.response.status === 401 && oldLogin.payload.ok === false,
    newPasswordAccepted: newLogin.payload.ok === true && Boolean(cookie) && Boolean(sessionToken),
    tokenReuseRejected: reuse.response.status === 400 && reuse.payload.ok === false,
    cookieOnlyDeleteWithoutBrowserOriginRejected:
      cookieOnlyDelete.status === 403 && cookieOnlyDeletePayload.code === "request_origin_forbidden",
    mobileBearerDeleteAccepted:
      deletePayload.ok === true &&
      ((deleted.status === 200 && deletePayload.status === "deleted") ||
        (deleted.status === 202 && deletePayload.status === "pending_cleanup")),
  };

  console.log(JSON.stringify(checks, null, 2));
  if (Object.values(checks).some((value) => !value)) process.exitCode = 1;
}

async function postJson(path, body, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": testIp },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!options.allowError && (!response.ok || !payload.ok)) {
    throw new Error(`${path} failed: HTTP ${response.status} ${payload.error || "unknown error"}`);
  }
  return { payload, response };
}

function extractCookie(response) {
  return response.headers.get("set-cookie")?.split(";")[0] || "";
}

function extractSessionToken(cookie) {
  return cookie.match(/(?:^|;\s*)ownminutes_session=([^;]+)/)?.[1] || "";
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
