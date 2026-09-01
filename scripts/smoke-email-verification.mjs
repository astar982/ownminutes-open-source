#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
import { getNextSafeListenPort, isNextReservedPort } from "./lib/next-safe-listen-port.mjs";

if (!isNextReservedPort(3659) || isNextReservedPort(3410)) {
  throw new Error("Next reserved-port table must keep apple-sasl blocked and ordinary smoke ports free");
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ownminutes-email-verification-"));
const port = await getNextSafeListenPort();
const baseUrl = `http://127.0.0.1:${port}`;
const browserOrigin = `http://localhost:${port}`;
const timestamp = Date.now();
const email = `verify-${timestamp}@ownminutes.local`;
const password = `OwnMinutesVerify-${timestamp}`;
const testIp = "198.51.100.211";
let server;

try {
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OWNMINUTES_AUTH_DATA_DIR: tempDir,
      OWNMINUTES_AUTH_REPOSITORY:
        process.env.OWNMINUTES_AUTH_REPOSITORY === "postgres" ? "postgres" : "local-file",
      OWNMINUTES_REQUIRE_EMAIL_VERIFICATION: "1",
      OWNMINUTES_ALLOW_PASSWORD_RESET_TOKEN_RESPONSE: "0",
      OWNMINUTES_ALLOW_LOCAL_AUTH_TOKEN_RESPONSE: "1",
      OWNMINUTES_TRUST_LOOPBACK_PROXY_HEADERS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOutput = "";
  server.stdout.on("data", (chunk) => (serverOutput += String(chunk)));
  server.stderr.on("data", (chunk) => (serverOutput += String(chunk)));
  await waitForServer(server, () => serverOutput);

  const register = await post("/api/auth/register", { name: "Verify Smoke", email, password });
  const initialToken = register.payload.verificationToken;
  const initialCode = register.payload.verificationCode;
  const storeAfterRegister =
    process.env.OWNMINUTES_AUTH_REPOSITORY === "postgres"
      ? null
      : JSON.parse(fs.readFileSync(path.join(tempDir, "store.json"), "utf8"));
  const loginBefore = await post("/api/auth/login", { email, password }, { allowError: true });
  const publicRequest = await post("/api/auth/email-verification/code/request", { email }, { host: "app.ownminutes.test", ip: "198.51.100.213" });
  const unknownPublicRequest = await post(
    "/api/auth/email-verification/code/request",
    { email: `unknown-public-${timestamp}@ownminutes.local` },
    { host: "app.ownminutes.test", ip: "198.51.100.214" },
  );
  const publicPasswordResetKnown = await post(
    "/api/auth/password-reset/request",
    { email },
    { host: "app.ownminutes.test", ip: "198.51.100.240" },
  );
  const publicPasswordResetUnknown = await post(
    "/api/auth/password-reset/request",
    { email: `unknown-reset-${timestamp}@ownminutes.local` },
    { host: "app.ownminutes.test", ip: "198.51.100.241" },
  );
  const cooldown = await post("/api/auth/email-verification/code/request", { email }, { ip: "198.51.100.215" });
  const wrongCode = initialCode === "000000" ? "999999" : "000000";
  const wrongAttempt = await post(
    "/api/auth/email-verification/code/confirm",
    { email, code: wrongCode },
    { allowError: true, ip: "198.51.100.216" },
  );
  const confirm = await post("/api/auth/email-verification/code/confirm", { email, code: initialCode }, { ip: "198.51.100.216" });
  const cookie = extractCookie(confirm.response);
  const usageResponse = await fetch(`${baseUrl}/api/account/usage`, { headers: { Cookie: cookie } });
  const usagePayload = await usageResponse.json();
  const reuse = await post(
    "/api/auth/email-verification/code/confirm",
    { email, code: initialCode },
    { allowError: true, ip: "198.51.100.216" },
  );
  const loginAfter = await post("/api/auth/login", { email, password });

  const legacyEmail = `legacy-${timestamp}@ownminutes.local`;
  const legacyPassword = `OwnMinutesLegacy-${timestamp}`;
  const legacyRegister = await post("/api/auth/register", { name: "Legacy Verify", email: legacyEmail, password: legacyPassword }, { ip: "198.51.100.217" });
  const legacyConfirm = await post("/api/auth/email-verification/confirm", { token: legacyRegister.payload.verificationToken });
  const legacyCookie = extractCookie(legacyConfirm.response);

  const concurrentEmail = `concurrent-${timestamp}@ownminutes.local`;
  const concurrentPassword = `OwnMinutesConcurrent-${timestamp}`;
  const concurrentRegister = await post(
    "/api/auth/register",
    { name: "Concurrent Verify", email: concurrentEmail, password: concurrentPassword },
    { ip: "198.51.100.223" },
  );
  const concurrentConfirmations = await Promise.all([
    post(
      "/api/auth/email-verification/code/confirm",
      { email: concurrentEmail, code: concurrentRegister.payload.verificationCode },
      { allowError: true, ip: "198.51.100.224" },
    ),
    post(
      "/api/auth/email-verification/confirm",
      { token: concurrentRegister.payload.verificationToken },
      { allowError: true, ip: "198.51.100.225" },
    ),
  ]);
  const concurrentSuccess = concurrentConfirmations.find((attempt) => attempt.response.status === 200);
  const concurrentCookie = concurrentSuccess ? extractCookie(concurrentSuccess.response) : "";
  const concurrentUsageResponse = await fetch(`${baseUrl}/api/account/usage`, { headers: { Cookie: concurrentCookie } });
  const concurrentUsagePayload = await concurrentUsageResponse.json();

  const lockedEmail = `locked-${timestamp}@ownminutes.local`;
  const lockedPassword = `OwnMinutesLocked-${timestamp}`;
  const lockedRegister = await post("/api/auth/register", { name: "Locked Verify", email: lockedEmail, password: lockedPassword }, { ip: "198.51.100.218" });
  const lockedWrongCode = lockedRegister.payload.verificationCode === "111111" ? "222222" : "111111";
  const invalidAttempts = [];
  for (let index = 0; index < 5; index += 1) {
    invalidAttempts.push(
      await post(
        "/api/auth/email-verification/code/confirm",
        { email: lockedEmail, code: lockedWrongCode },
        { allowError: true, ip: "198.51.100.219" },
      ),
    );
  }
  const correctAfterLock = await post(
    "/api/auth/email-verification/code/confirm",
    { email: lockedEmail, code: lockedRegister.payload.verificationCode },
    { allowError: true, ip: "198.51.100.220" },
  );
  await ageLatestOtp(lockedEmail);
  const lockedResend = await post(
    "/api/auth/email-verification/code/request",
    { email: lockedEmail },
    { ip: "198.51.100.219" },
  );
  const confirmAfterResend = await post(
    "/api/auth/email-verification/code/confirm",
    { email: lockedEmail, code: lockedResend.payload.verificationCode },
    { ip: "198.51.100.219" },
  );
  const lockedCookie = extractCookie(confirmAfterResend.response);

  const expiredEmail = `expired-${timestamp}@ownminutes.local`;
  const expiredPassword = `OwnMinutesExpired-${timestamp}`;
  const expiredRegister = await post(
    "/api/auth/register",
    { name: "Expired Verify", email: expiredEmail, password: expiredPassword },
    { ip: "198.51.100.221" },
  );
  await expireLatestOtp(expiredEmail);
  const expiredConfirm = await post(
    "/api/auth/email-verification/code/confirm",
    { email: expiredEmail, code: expiredRegister.payload.verificationCode },
    { allowError: true, ip: "198.51.100.222" },
  );
  const expiredLegacyConfirm = await post(
    "/api/auth/email-verification/confirm",
    { token: expiredRegister.payload.verificationToken },
  );
  const expiredCookie = extractCookie(expiredLegacyConfirm.response);

  const rateAttempts = [];
  const rateEmail = `rate-${timestamp}@ownminutes.local`;
  for (let index = 0; index < 5; index += 1) {
    rateAttempts.push(
      await post(
        "/api/auth/email-verification/code/request",
        { email: rateEmail },
        { allowError: true, ip: `198.51.100.${230 + index}` },
      ),
    );
  }
  const ipRateAttempts = [];
  for (let index = 0; index < 30; index += 1) {
    ipRateAttempts.push(
      await post(
        "/api/auth/email-verification/code/request",
        { email: `ip-rate-${index}-${timestamp}@ownminutes.local` },
        { allowError: true, ip: "198.51.100.229" },
      ),
    );
  }
  const deleted = await deleteAccount(cookie);
  const legacyDeleted = await deleteAccount(legacyCookie);
  const concurrentDeleted = await deleteAccount(concurrentCookie);
  const lockedDeleted = await deleteAccount(lockedCookie);
  const expiredDeleted = await deleteAccount(expiredCookie);
  const storeAfterDelete =
    process.env.OWNMINUTES_AUTH_REPOSITORY === "postgres"
      ? null
      : JSON.parse(fs.readFileSync(path.join(tempDir, "store.json"), "utf8"));

  const serialized = JSON.stringify({
    register: register.payload,
    loginBefore: loginBefore.payload,
    publicRequest: publicRequest.payload,
    cooldown: cooldown.payload,
    wrongAttempt: wrongAttempt.payload,
    confirm: confirm.payload,
    usage: usagePayload,
    reuse: reuse.payload,
    loginAfter: loginAfter.payload,
    legacyRegister: legacyRegister.payload,
    legacyConfirm: legacyConfirm.payload,
    concurrentConfirmations: concurrentConfirmations.map((attempt) => attempt.payload),
    invalidAttempts: invalidAttempts.map((attempt) => attempt.payload),
    lockedResend: lockedResend.payload,
    confirmAfterResend: confirmAfterResend.payload,
    expiredConfirm: expiredConfirm.payload,
  });
  const concurrentSingleUsePassed =
    concurrentConfirmations.filter((attempt) => attempt.response.status === 200).length === 1 &&
    concurrentConfirmations.filter((attempt) => attempt.response.status === 400).length === 1 &&
    Boolean(concurrentCookie) &&
    concurrentUsageResponse.status === 200 &&
    concurrentUsagePayload.usage?.events?.filter((event) => event.type === "register_bonus").length === 1;
  if (!concurrentSingleUsePassed) {
    console.error(
      JSON.stringify({
        concurrentConfirmations: concurrentConfirmations.map((attempt) => ({
          payload: attempt.payload,
          status: attempt.response.status,
        })),
        concurrentUsagePayload,
        concurrentUsageStatus: concurrentUsageResponse.status,
        serverOutput: serverOutput.slice(-4_000),
      }),
    );
  }
  const summary = {
    registerRequiresVerification: register.response.status === 200 && register.payload.verificationRequired === true,
    registerHasNoSession: !extractCookie(register.response),
    unverifiedHasNoTrial: register.payload.user?.officialMinutesTotal === 0,
    localTokenExposed: typeof initialToken === "string" && initialToken.length >= 24,
    localCodeExposed: /^\d{6}$/.test(initialCode || ""),
    publicCredentialsHidden:
      publicRequest.response.status === 200 &&
      !publicRequest.payload.verificationToken &&
      !publicRequest.payload.verificationCode &&
      !publicRequest.payload.delivery &&
      !publicRequest.payload.expiresAt,
    publicRequestPreventsEnumeration:
      publicRequest.response.status === unknownPublicRequest.response.status &&
      JSON.stringify(publicRequest.payload) === JSON.stringify(unknownPublicRequest.payload),
    publicPasswordResetPreventsEnumeration:
      publicPasswordResetKnown.response.status === publicPasswordResetUnknown.response.status &&
      JSON.stringify(publicPasswordResetKnown.payload) === JSON.stringify(publicPasswordResetUnknown.payload) &&
      !publicPasswordResetKnown.payload.resetToken &&
      !publicPasswordResetKnown.payload.expiresAt &&
      !publicPasswordResetKnown.payload.delivery,
    resendCooldownEnforced:
      cooldown.response.status === 200 && !cooldown.payload.verificationCode && cooldown.payload.retryAfterSeconds === 60,
    loginBlockedBeforeVerification: loginBefore.response.status === 403 && loginBefore.payload.code === "email_verification_required",
    wrongCodeRejected:
      wrongAttempt.response.status === 400 && wrongAttempt.payload.code === "invalid_email_verification_code",
    confirmCreatesSession: confirm.response.status === 200 && Boolean(cookie),
    verifiedTimestampReturned: Boolean(confirm.payload.user?.emailVerifiedAt),
    trialGrantedAfterVerification: confirm.payload.user?.officialMinutesTotal === 60,
    trialGrantedExactlyOnce:
      usageResponse.status === 200 &&
      usagePayload.usage?.officialMinutesTotal === 60 &&
      usagePayload.usage?.events?.filter((event) => event.type === "register_bonus").length === 1,
    codeSingleUse: reuse.response.status === 400 && reuse.payload.code === "invalid_email_verification_code",
    loginAfterVerification: loginAfter.response.status === 200 && Boolean(extractCookie(loginAfter.response)),
    legacyLinkCompatible:
      legacyConfirm.response.status === 200 && Boolean(legacyCookie) && legacyConfirm.payload.user?.officialMinutesTotal === 60,
    concurrentCodeAndLinkAreSingleUse: concurrentSingleUsePassed,
    fiveWrongAttemptsLockCode:
      invalidAttempts.slice(0, 4).every(
        (attempt) => attempt.response.status === 400 && attempt.payload.code === "invalid_email_verification_code",
      ) &&
      invalidAttempts[4]?.response.status === 429 &&
      invalidAttempts[4]?.payload.code === "email_verification_code_rate_limited" &&
      correctAfterLock.response.status === 429 &&
      correctAfterLock.payload.code === "email_verification_code_rate_limited",
    resendClearsConfirmLimiter:
      /^\d{6}$/.test(lockedResend.payload.verificationCode || "") &&
      confirmAfterResend.response.status === 200 &&
      Boolean(lockedCookie),
    expiredCodeRejected:
      expiredConfirm.response.status === 400 &&
      expiredConfirm.payload.code === "invalid_email_verification_code",
    rateLimitEnforced:
      rateAttempts.slice(0, 4).every((attempt) => attempt.response.status === 200) &&
      rateAttempts[4]?.response.status === 429 &&
      rateAttempts[4]?.payload.code === "email_verification_code_rate_limited" &&
      ipRateAttempts.slice(0, 29).every((attempt) => attempt.response.status === 200) &&
      ipRateAttempts[29]?.response.status === 429 &&
      ipRateAttempts[29]?.payload.code === "email_verification_code_rate_limited",
    accountsDeleted:
      [deleted, legacyDeleted, concurrentDeleted, lockedDeleted, expiredDeleted]
        .every((response) => response.status === 200 || response.status === 202),
    localTokensDeleted:
      storeAfterDelete === null ||
      (storeAfterDelete.emailVerificationTokens.length === 0 &&
        storeAfterDelete.passwordResetTokens.length === 0),
    plaintextCodeNotStored:
      storeAfterRegister === null || !JSON.stringify(storeAfterRegister).includes(initialCode),
    leaksSecrets:
      serialized.includes(password) ||
      serialized.includes(legacyPassword) ||
      serialized.includes(concurrentPassword) ||
      serialized.includes(lockedPassword) ||
      serialized.includes(expiredPassword) ||
      serialized.includes("RESEND_API_KEY") ||
      serialized.includes("AKL"),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (Object.entries(summary).some(([key, value]) => (key === "leaksSecrets" ? value : !value))) process.exitCode = 1;
} finally {
  if (server && server.exitCode === null) server.kill("SIGTERM");
  fs.rmSync(tempDir, { recursive: true, force: true });
}

async function deleteAccount(cookie) {
  return fetch(`${baseUrl}/api/auth/delete`, {
    method: "DELETE",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
      Origin: browserOrigin,
      "Sec-Fetch-Site": "same-origin",
    },
    body: JSON.stringify({ confirmation: "DELETE" }),
  });
}

async function ageLatestOtp(targetEmail) {
  if (process.env.OWNMINUTES_AUTH_REPOSITORY === "postgres") {
    const { Client } = await import("pg");
    const client = new Client({ connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL });
    await client.connect();
    try {
      await client.query(
        `update email_verification_tokens as tokens
         set created_at = now() - interval '61 seconds'
         from users
         where tokens.user_id = users.id
           and tokens.credential_kind = 'otp'
           and lower(users.email) = lower($1)`,
        [targetEmail],
      );
    } finally {
      await client.end();
    }
    return;
  }

  const storePath = path.join(tempDir, "store.json");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  const user = store.users.find((item) => item.email === targetEmail);
  for (const token of store.emailVerificationTokens) {
    if (token.userId === user?.id && token.credentialKind === "otp") {
      token.createdAt = new Date(Date.now() - 61_000).toISOString();
    }
  }
  fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

async function expireLatestOtp(targetEmail) {
  if (process.env.OWNMINUTES_AUTH_REPOSITORY === "postgres") {
    const { Client } = await import("pg");
    const client = new Client({ connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL });
    await client.connect();
    try {
      await client.query(
        `update email_verification_tokens as tokens
         set expires_at = now() - interval '1 second'
         from users
         where tokens.user_id = users.id
           and tokens.credential_kind = 'otp'
           and lower(users.email) = lower($1)`,
        [targetEmail],
      );
    } finally {
      await client.end();
    }
    return;
  }

  const storePath = path.join(tempDir, "store.json");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  const user = store.users.find((item) => item.email === targetEmail);
  for (const token of store.emailVerificationTokens) {
    if (token.userId === user?.id && token.credentialKind === "otp") {
      token.expiresAt = new Date(Date.now() - 1_000).toISOString();
    }
  }
  fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

async function post(apiPath, body, options = {}) {
  if (options.host) return postWithHost(apiPath, body, options);
  const response = await fetch(`${baseUrl}${apiPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: browserOrigin,
      "Sec-Fetch-Site": "same-origin",
      "x-forwarded-for": options.ip || testIp,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok && !options.allowError) throw new Error(`HTTP ${response.status} from ${apiPath}: ${JSON.stringify(payload)}`);
  return { response, payload };
}

async function postWithHost(apiPath, body, options) {
  const payloadText = JSON.stringify(body);
  const result = await new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: apiPath,
        method: "POST",
        headers: {
          Host: options.host,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payloadText),
          "x-forwarded-for": options.ip || testIp,
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () =>
          resolve({
            response: {
              status: response.statusCode || 0,
              headers: { get: (name) => response.headers[name.toLowerCase()] || null },
            },
            payload: JSON.parse(text),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(payloadText);
  });
  if (result.response.status >= 400 && !options.allowError) {
    throw new Error(`HTTP ${result.response.status} from ${apiPath}: ${JSON.stringify(result.payload)}`);
  }
  return result;
}

function extractCookie(response) {
  return response.headers.get("set-cookie")?.split(";")[0] || "";
}

async function waitForServer(child, getOutput) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Email verification preview exited early: ${getOutput().slice(-1000)}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for email verification preview.");
}
