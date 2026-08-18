#!/usr/bin/env node

import { buildSilentWav } from "./lib/audio-fixtures.mjs";

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3003";
const browserOrigin = process.env.SMOKE_BROWSER_ORIGIN || baseUrl;
const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const email = `smoke-${timestamp}@ownminutes.local`;
const password = `OwnMinutes-${timestamp}`;
const changedPassword = `OwnMinutesChanged-${timestamp}`;
const resetPassword = `OwnMinutesReset-${timestamp}`;
const bearerPasswordEmail = `smoke-bearer-password-${timestamp}@ownminutes.local`;
const bearerPassword = `OwnMinutesBearer-${timestamp}`;
const bearerChangedPassword = `OwnMinutesBearerChanged-${timestamp}`;
const rateLimitEmail = `smoke-rate-limit-${timestamp}@ownminutes.local`;
const rateLimitPassword = `OwnMinutesRate-${timestamp}`;
const authSmokeIp = `198.51.101.${Number(timestamp.slice(-2)) || 42}`;
const rateLimitSmokeIp = `198.51.102.${Number(timestamp.slice(-2)) || 42}`;
const registerRateLimitIp = `198.51.100.${Number(timestamp.slice(-2)) || 42}`;
const passwordResetRateLimitIp = `198.51.103.${Number(timestamp.slice(-2)) || 42}`;
const bearerPasswordSmokeIp = `198.51.104.${Number(timestamp.slice(-2)) || 42}`;

async function main() {
  const register = await postJson("/api/auth/register", {
    name: "Smoke User",
    email,
    password,
  }, undefined, { headers: { "x-forwarded-for": authSmokeIp } });
  const rateLimitRegister = await postJson("/api/auth/register", {
    name: "Rate Limit User",
    email: rateLimitEmail,
    password: rateLimitPassword,
  }, undefined, { headers: { "x-forwarded-for": rateLimitSmokeIp } });
  const rateLimitCookie = extractCookie(rateLimitRegister.response);
  const failedRateLimitLogins = [];
  for (let index = 0; index < 5; index += 1) {
    failedRateLimitLogins.push(
      await postJson("/api/auth/login", { email: rateLimitEmail, password: `wrong-password-${index}` }, undefined, {
        allowError: true,
        headers: { "x-forwarded-for": rateLimitSmokeIp },
      }),
    );
  }
  const lockedRateLimitLogin = await postJson("/api/auth/login", { email: rateLimitEmail, password: rateLimitPassword }, undefined, {
    allowError: true,
    headers: { "x-forwarded-for": rateLimitSmokeIp },
  });
  const registerRateLimitAttempts = [];
  for (let index = 0; index < 5; index += 1) {
    registerRateLimitAttempts.push(
      await postJson(
        "/api/auth/register",
        { name: "X", email: `bad-register-${index}-${timestamp}@ownminutes.local`, password: "short" },
        undefined,
        { allowError: true, headers: { "x-forwarded-for": registerRateLimitIp } },
      ),
    );
  }
  const lockedRegister = await postJson(
    "/api/auth/register",
    { name: "Register Locked", email: `locked-register-${timestamp}@ownminutes.local`, password: `OwnMinutesRegister-${timestamp}` },
    undefined,
    { allowError: true, headers: { "x-forwarded-for": registerRateLimitIp } },
  );
  const passwordResetRateLimitAttempts = [];
  for (let index = 0; index < 5; index += 1) {
    passwordResetRateLimitAttempts.push(
      await postJson(
        "/api/auth/password-reset/request",
        { email: `reset-limit-${timestamp}@ownminutes.local` },
        undefined,
        { allowError: true, headers: { "x-forwarded-for": passwordResetRateLimitIp } },
      ),
    );
  }
  const lockedPasswordReset = await postJson(
    "/api/auth/password-reset/request",
    { email: `reset-limit-${timestamp}@ownminutes.local` },
    undefined,
    { allowError: true, headers: { "x-forwarded-for": passwordResetRateLimitIp } },
  );
  let cookie = extractCookie(register.response);

  const me = await getJson("/api/auth/me", cookie);
  const crossOriginPasswordChange = await postJson(
    "/api/auth/password",
    { currentPassword: password, newPassword: changedPassword },
    cookie,
    {
      allowError: true,
      headers: { Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site" },
    },
  );
  const wrongPasswordChange = await postJson("/api/auth/password", { currentPassword: "wrong-current-password", newPassword: changedPassword }, cookie, {
    allowError: true,
  });
  const passwordChange = await postJson("/api/auth/password", { currentPassword: password, newPassword: changedPassword }, cookie);
  const oldPasswordLogin = await postJson("/api/auth/login", { email, password }, undefined, { allowError: true });
  const newPasswordLogin = await postJson("/api/auth/login", { email, password: changedPassword }, undefined);
  const passwordResetRequest = await postJson("/api/auth/password-reset/request", { email }, undefined);
  const unknownPasswordResetRequest = await postJson("/api/auth/password-reset/request", { email: `unknown-${timestamp}@ownminutes.local` }, undefined);
  const passwordResetToken = passwordResetRequest.payload.resetToken;
  const passwordResetConfirm = await postJson("/api/auth/password-reset/confirm", { token: passwordResetToken, newPassword: resetPassword }, undefined);
  const reusedPasswordResetConfirm = await postJson("/api/auth/password-reset/confirm", { token: passwordResetToken, newPassword: `${resetPassword}-again` }, undefined, {
    allowError: true,
  });
  const changedPasswordLoginAfterReset = await postJson("/api/auth/login", { email, password: changedPassword }, undefined, { allowError: true });
  const resetPasswordLogin = await postJson("/api/auth/login", { email, password: resetPassword }, undefined);
  cookie = extractCookie(resetPasswordLogin.response);
  const bearerLogin = await postJson("/api/auth/login", { email, password: resetPassword }, undefined);
  const bearerToken = extractCookie(bearerLogin.response).split("=").slice(1).join("=");
  const bearerMeResponse = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${bearerToken}` },
  });
  const bearerMe = await readJson(bearerMeResponse, "/api/auth/me bearer");
  const bearerLogoutResponse = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearerToken}` },
  });
  const bearerLogout = await readJson(bearerLogoutResponse, "/api/auth/logout bearer");
  const bearerAfterLogoutResponse = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${bearerToken}` },
  });
  const bearerAfterLogout = await readJson(bearerAfterLogoutResponse, "/api/auth/me bearer after logout", { allowError: true });
  const meetingId = `smoke-auth-meeting-${timestamp}`;
  const upload = await uploadChunk(meetingId, cookie);
  const finalized = await postJson(
    `/api/meetings/${meetingId}/finalize`,
    {
      title: "OwnMinutes auth smoke meeting",
      expectedLastSequence: upload.totalChunks,
      totalBytes: upload.totalBytes,
    },
    cookie,
  );
  const review = await postJson(`/api/meetings/${meetingId}/review`, { confirmed: true }, cookie);
  const publish = await postJson(
    `/api/meetings/${meetingId}/share`,
    {
      visibility: "public",
      includeTranscript: false,
      confirmUnverified: true,
    },
    cookie,
  );
  const publicShareBeforeDelete = await fetch(`${baseUrl}/share/${meetingId}`);
  const publicShareBeforeDeleteText = await publicShareBeforeDelete.text();
  const afterFinalize = await getJson("/api/auth/me", cookie);
  const usageAfterFinalize = await getJson("/api/account/usage", cookie);
  const provider = await postJson(
    "/api/account/provider-credentials",
    {
      providerId: "volcano-asr",
      label: "Smoke Volcano ASR",
      fields: { VOLCANO_ASR_RESOURCE_ID: "volc.seedasr.auc" },
      secrets: { VOLCANO_ASR_API_KEY: "smoke-secret-api-key" },
    },
    cookie,
  );
  const providerLegacyAuth = await postJson(
    "/api/account/provider-credentials",
    {
      providerId: "volcano-asr",
      label: "Smoke Volcano ASR",
      fields: { VOLCANO_ASR_APP_ID: "smoke-app-id", VOLCANO_ASR_RESOURCE_ID: "volc.seedasr.auc" },
      secrets: { VOLCANO_ASR_TOKEN: "smoke-asr-token" },
      removeSecrets: ["VOLCANO_ASR_API_KEY"],
    },
    cookie,
  );
  const providerListAfterLegacyAuth = await getJson("/api/account/provider-credentials", cookie);
  const providerApiKeyAuth = await postJson(
    "/api/account/provider-credentials",
    {
      providerId: "volcano-asr",
      label: "Smoke Volcano ASR",
      fields: { VOLCANO_ASR_RESOURCE_ID: "volc.seedasr.auc" },
      secrets: { VOLCANO_ASR_API_KEY: "smoke-secret-api-key-rotated" },
      removeSecrets: ["VOLCANO_ASR_TOKEN"],
    },
    cookie,
  );
  const arkProvider = await postJson(
    "/api/account/provider-credentials",
    {
      providerId: "volcano-ark",
      label: "Smoke Volcano Ark",
      fields: { ARK_CHAT_MODEL: "smoke-endpoint-id", ARK_BASE_URL: "https://ark.cn-beijing.volces.com/api/v3" },
      secrets: { ARK_API_KEY: "smoke-ark-api-key" },
    },
    cookie,
  );
  const providerList = await getJson("/api/account/provider-credentials", cookie);
  const providerHealth = await getJson("/api/account/provider-health", cookie);
  const plan = await postJson("/api/account/plan", { plan: "plus" }, cookie, { allowError: true });
  const afterPlan = await getJson("/api/auth/me", cookie);
  const usageAfterPlan = await getJson("/api/account/usage", cookie);
  const accountExport = await getJson("/api/account/export", cookie);
  const accountExportText = JSON.stringify(accountExport.payload);
  const legacyAsrCredential = providerListAfterLegacyAuth.payload.providerCredentials?.find((item) => item.providerId === "volcano-asr");
  const finalAsrCredential = providerList.payload.providerCredentials?.find((item) => item.providerId === "volcano-asr");
  const adminUsers = await fetch(`${baseUrl}/api/admin/users`, {
    headers: { Cookie: cookie },
  });
  const adminUsersPayload = await readJson(adminUsers, "/api/admin/users", { allowError: true });
  const adminMetrics = await fetch(`${baseUrl}/api/admin/metrics`, {
    headers: { Cookie: cookie },
  });
  const adminMetricsPayload = await readJson(adminMetrics, "/api/admin/metrics", { allowError: true });
  const adminPlanGrant = await fetch(`${baseUrl}/api/admin/users/${me.payload.user?.id}/plan`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: browserOrigin,
      "Sec-Fetch-Site": "same-origin",
      Cookie: cookie,
    },
    body: JSON.stringify({ plan: "free", reason: "smoke-admin-access-check" }),
  });
  const adminPlanGrantPayload = await readJson(adminPlanGrant, "/api/admin/users/:id/plan", { allowError: true });
  const adminGrantStatus = await fetch(`${baseUrl}/api/admin/entitlement-grants/grant_smoke_forbidden/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: browserOrigin,
      "Sec-Fetch-Site": "same-origin",
      Cookie: cookie,
    },
    body: JSON.stringify({ status: "refunded", reason: "smoke-admin-access-check" }),
  });
  const adminGrantStatusPayload = await readJson(adminGrantStatus, "/api/admin/entitlement-grants/:id/status", { allowError: true });
  const bearerPasswordRegister = await postJson(
    "/api/auth/register",
    { name: "Bearer Password User", email: bearerPasswordEmail, password: bearerPassword },
    undefined,
    { headers: { "x-forwarded-for": bearerPasswordSmokeIp } },
  );
  const bearerPasswordToken = extractCookie(bearerPasswordRegister.response).split("=").slice(1).join("=");
  const bearerPasswordChangeResponse = await fetch(`${baseUrl}/api/auth/password`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearerPasswordToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ currentPassword: bearerPassword, newPassword: bearerChangedPassword }),
  });
  const bearerPasswordChange = await readJson(bearerPasswordChangeResponse, "/api/auth/password bearer");
  const bearerPasswordMeResponse = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${bearerPasswordToken}` },
  });
  const bearerPasswordMe = await readJson(bearerPasswordMeResponse, "/api/auth/me bearer after password change");
  const bearerOldPasswordLogin = await postJson("/api/auth/login", { email: bearerPasswordEmail, password: bearerPassword }, undefined, { allowError: true });
  const bearerNewPasswordLogin = await postJson("/api/auth/login", { email: bearerPasswordEmail, password: bearerChangedPassword }, undefined);
  const bearerPasswordDeleteResponse = await fetch(`${baseUrl}/api/auth/delete`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${bearerPasswordToken}` },
  });
  const bearerPasswordDelete = await readJson(bearerPasswordDeleteResponse, "/api/auth/delete bearer password user");
  const deleteResult = await fetch(`${baseUrl}/api/auth/delete`, {
    method: "DELETE",
    headers: { Cookie: cookie, Origin: browserOrigin, "Sec-Fetch-Site": "same-origin" },
  });
  const deletePayload = await readJson(deleteResult, "/api/auth/delete", { allowError: true });
  const deleteRateLimitResult = await fetch(`${baseUrl}/api/auth/delete`, {
    method: "DELETE",
    headers: { Cookie: rateLimitCookie, Origin: browserOrigin, "Sec-Fetch-Site": "same-origin" },
  });
  const deleteRateLimitPayload = await readJson(deleteRateLimitResult, "/api/auth/delete", { allowError: true });
  const shareAfterAccountDelete = await fetch(`${baseUrl}/share/${meetingId}`);
  const shareAfterAccountDeleteText = await shareAfterAccountDelete.text();
  const meetingAfterAccountDelete = await fetch(`${baseUrl}/api/meetings/${meetingId}`, {
    headers: { Cookie: cookie },
  });

  const summary = {
    registerOk: register.payload.ok === true,
    rateLimitFailuresRejected: failedRateLimitLogins.every((login, index) => (index < 4 ? login.response.status === 401 : login.response.status === 429)),
    rateLimitLockCode: lockedRateLimitLogin.payload.code,
    rateLimitLockStatus: lockedRateLimitLogin.response.status,
    rateLimitHasRetryAfter: Number(lockedRateLimitLogin.response.headers.get("retry-after")) > 0,
    registerRateLimitFailuresRejected: registerRateLimitAttempts.every((attempt, index) => (index < 4 ? attempt.response.status === 400 : attempt.response.status === 429)),
    registerRateLimitLockCode: lockedRegister.payload.code,
    registerRateLimitLockStatus: lockedRegister.response.status,
    registerRateLimitHasRetryAfter: Number(lockedRegister.response.headers.get("retry-after")) > 0,
    passwordResetRateLimitFailuresRejected: passwordResetRateLimitAttempts.every((attempt, index) =>
      index < 4
        ? attempt.response.status === 200 && attempt.payload.ok === true
        : attempt.response.status === 429 && attempt.payload.code === "password_reset_rate_limited",
    ),
    passwordResetRateLimitLockCode: lockedPasswordReset.payload.code,
    passwordResetRateLimitLockStatus: lockedPasswordReset.response.status,
    passwordResetRateLimitHasRetryAfter: Number(lockedPasswordReset.response.headers.get("retry-after")) > 0,
    meOk: me.payload.ok === true,
    userEmail: me.payload.user?.email,
    crossOriginPasswordChangeRejected:
      crossOriginPasswordChange.response.status === 403 &&
      crossOriginPasswordChange.payload.code === "request_origin_forbidden",
    wrongPasswordChangeRejected: wrongPasswordChange.response.status === 401 && wrongPasswordChange.payload.ok === false,
    passwordChangeOk: passwordChange.payload.ok === true,
    oldPasswordLoginRejected: oldPasswordLogin.response.status === 401 && oldPasswordLogin.payload.ok === false,
    newPasswordLoginOk: newPasswordLogin.payload.ok === true,
    passwordResetRequestOk: passwordResetRequest.payload.ok === true && typeof passwordResetToken === "string" && passwordResetToken.length >= 24,
    unknownPasswordResetHidesAccount: unknownPasswordResetRequest.payload.ok === true && !unknownPasswordResetRequest.payload.resetToken,
    passwordResetConfirmOk: passwordResetConfirm.payload.ok === true,
    reusedPasswordResetRejected: reusedPasswordResetConfirm.response.status === 400 && reusedPasswordResetConfirm.payload.ok === false,
    changedPasswordLoginRejectedAfterReset: changedPasswordLoginAfterReset.response.status === 401 && changedPasswordLoginAfterReset.payload.ok === false,
    resetPasswordLoginOk: resetPasswordLogin.payload.ok === true,
    bearerSessionAccepted: bearerMeResponse.status === 200 && bearerMe.ok === true && bearerMe.user?.email === email,
    bearerLogoutDestroysSession:
      bearerLogoutResponse.status === 200 &&
      bearerLogout.ok === true &&
      bearerAfterLogoutResponse.status === 401 &&
      bearerAfterLogout.ok === false,
    bearerPasswordChangeOk: bearerPasswordChangeResponse.status === 200 && bearerPasswordChange.ok === true,
    bearerPasswordChangeKeepsCurrentSession:
      bearerPasswordMeResponse.status === 200 && bearerPasswordMe.ok === true && bearerPasswordMe.user?.email === bearerPasswordEmail,
    bearerPasswordChangeRejectsOldPassword: bearerOldPasswordLogin.response.status === 401 && bearerOldPasswordLogin.payload.ok === false,
    bearerPasswordChangeAcceptsNewPassword: bearerNewPasswordLogin.response.status === 200 && bearerNewPasswordLogin.payload.ok === true,
    bearerPasswordUserDeleted: bearerPasswordDeleteResponse.status === 200 && bearerPasswordDelete.ok === true,
    role: me.payload.user?.role,
    publicRegistrationIsNotAdmin: me.payload.user?.role === "user",
    finalizeOk: finalized.payload.ok === true,
    finalizeProvider: finalized.payload.result?.provider,
    finalizeProcessingRoute: finalized.payload.billing?.processingRoute,
    reviewConfirmed: review.payload.ok === true && review.payload.humanReview?.status === "confirmed",
    publishBeforeDeleteOk: publish.payload.ok === true,
    publicShareBeforeDeleteVisible: publicShareBeforeDeleteText.includes("公开分享的会议纪要"),
    usedMinutesAfterFinalize: afterFinalize.payload.usage?.officialMinutesUsed,
    usageApiOk: usageAfterFinalize.payload.ok === true,
    usageHasMeetingFinalize: usageAfterFinalize.payload.usage?.events?.some((event) => event.type === "meeting_finalize" && event.minutes === 1),
    mockFinalizationDidNotConsumeOfficialQuota:
      finalized.payload.result?.provider !== "mock" ||
      (afterFinalize.payload.usage?.officialMinutesUsed === 0 &&
        !usageAfterFinalize.payload.usage?.events?.some((event) => event.type === "meeting_finalize" && Number(event.minutes) > 0)),
    costControlModeAfterFinalize: usageAfterFinalize.payload.usage?.costControl?.mode,
    providerSaveOk: provider.payload.ok === true,
    providerSwitchedToLegacyAuth: providerLegacyAuth.payload.ok === true,
    legacyAuthRemovedApiKey:
      legacyAsrCredential?.configuredSecrets?.includes("VOLCANO_ASR_TOKEN") === true &&
      legacyAsrCredential?.configuredSecrets?.includes("VOLCANO_ASR_API_KEY") === false,
    providerSwitchedBackToApiKey: providerApiKeyAuth.payload.ok === true,
    apiKeyAuthRemovedLegacyToken:
      finalAsrCredential?.configuredSecrets?.includes("VOLCANO_ASR_API_KEY") === true &&
      finalAsrCredential?.configuredSecrets?.includes("VOLCANO_ASR_TOKEN") === false,
    arkProviderSaveOk: arkProvider.payload.ok === true,
    providerCount: providerList.payload.providerCredentials?.length ?? 0,
    secretPreview: provider.payload.credential?.secretPreviews?.VOLCANO_ASR_API_KEY,
    asrHealthReady: providerHealth.payload.health?.some((item) => item.providerId === "volcano-asr" && item.status === "ready"),
    arkHealthReady: providerHealth.payload.health?.some((item) => item.providerId === "volcano-ark" && item.status === "ready"),
    providerSetupReportReady: providerHealth.payload.setupReport?.readyCount === 2 && providerHealth.payload.setupReport?.score === 100,
    providerSetupReportHasCapabilities: providerHealth.payload.setupReport?.capabilities?.some((item) => item.id === "file_asr") &&
      providerHealth.payload.setupReport?.capabilities?.some((item) => item.id === "summary"),
    planUpdateOk: plan.payload.ok === true,
    planUpdateBlocked: plan.response.status === 402 && plan.payload.code === "simulated_billing_disabled",
    planUpdateStatus: plan.response.status,
    planUpdateCode: plan.payload.code,
    planAfterUpdate: afterPlan.payload.user?.plan,
    minutesAfterPlanUpdate: afterPlan.payload.usage?.officialMinutesTotal,
    usageHasPlanChange: usageAfterPlan.payload.usage?.events?.some((event) => event.type === "manual_adjustment" && event.note === "Changed plan to plus"),
    costControlModeAfterPlan: usageAfterPlan.payload.usage?.costControl?.mode,
    accountExportOk: accountExport.payload.ok === true,
    accountExportEmail: accountExport.payload.user?.email,
    accountExportProviderCount: accountExport.payload.providerCredentials?.length ?? 0,
    accountExportHasMeeting: accountExport.payload.meetings?.some((meeting) => meeting.meetingId === meetingId),
    accountExportHasUsageEvents: Array.isArray(accountExport.payload.usage?.events),
    accountExportHidesSecrets: !accountExportText.includes("smoke-secret-api-key") && !accountExportText.includes("smoke-ark-api-key") && !accountExportText.includes("smoke-asr-token"),
    adminUsersStatus: adminUsers.status,
    adminUsersOkWhenAdmin: me.payload.user?.role === "admin" ? adminUsersPayload.ok === true : undefined,
    adminUsersForbiddenWhenUser: me.payload.user?.role !== "admin" ? adminUsers.status === 403 : undefined,
    adminUsersContainsSelf: Array.isArray(adminUsersPayload.users) ? adminUsersPayload.users.some((user) => user.email === email) : undefined,
    adminMetricsStatus: adminMetrics.status,
    adminMetricsOkWhenAdmin: me.payload.user?.role === "admin" ? adminMetricsPayload.ok === true : undefined,
    adminMetricsForbiddenWhenUser: me.payload.user?.role !== "admin" ? adminMetrics.status === 403 : undefined,
    adminMetricsHasFunnel: Array.isArray(adminMetricsPayload.funnel) && adminMetricsPayload.funnel.length >= 5,
    adminMetricsHasCommercial: typeof adminMetricsPayload.commercialMetrics?.conversionRates?.activation === "number",
    adminPlanGrantStatus: adminPlanGrant.status,
    adminPlanGrantOkWhenAdmin: me.payload.user?.role === "admin" ? adminPlanGrantPayload.ok === true : undefined,
    adminPlanGrantForbiddenWhenUser: me.payload.user?.role !== "admin" ? adminPlanGrant.status === 403 : undefined,
    adminGrantStatusStatus: adminGrantStatus.status,
    adminGrantStatusOkWhenAdmin: me.payload.user?.role === "admin" ? adminGrantStatusPayload.ok === false && adminGrantStatus.status === 404 : undefined,
    adminGrantStatusForbiddenWhenUser: me.payload.user?.role !== "admin" ? adminGrantStatus.status === 403 : undefined,
    deleteStatus: deleteResult.status,
    deleteRateLimitOk: deleteRateLimitPayload.ok === true,
    deleteResponseHidesMeetingIdentifiers:
      !Object.hasOwn(deletePayload, "deletedMeetingIds") &&
      !Object.hasOwn(deletePayload, "deletedMeetings") &&
      !JSON.stringify(deletePayload).includes(meetingId),
    shareHiddenAfterAccountDelete: shareAfterAccountDeleteText.includes("尚未公开"),
    meetingAfterAccountDeleteStatus: meetingAfterAccountDelete.status,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (
    !summary.registerOk ||
    !summary.rateLimitFailuresRejected ||
    summary.rateLimitLockStatus !== 429 ||
    summary.rateLimitLockCode !== "login_rate_limited" ||
    !summary.rateLimitHasRetryAfter ||
    !summary.registerRateLimitFailuresRejected ||
    summary.registerRateLimitLockStatus !== 429 ||
    summary.registerRateLimitLockCode !== "register_rate_limited" ||
    !summary.registerRateLimitHasRetryAfter ||
    !summary.passwordResetRateLimitFailuresRejected ||
    summary.passwordResetRateLimitLockStatus !== 429 ||
    summary.passwordResetRateLimitLockCode !== "password_reset_rate_limited" ||
    !summary.passwordResetRateLimitHasRetryAfter ||
    !summary.meOk ||
    !summary.crossOriginPasswordChangeRejected ||
    !summary.publicRegistrationIsNotAdmin ||
    summary.userEmail !== email ||
    !summary.wrongPasswordChangeRejected ||
    !summary.passwordChangeOk ||
    !summary.oldPasswordLoginRejected ||
    !summary.newPasswordLoginOk ||
    !summary.passwordResetRequestOk ||
    !summary.unknownPasswordResetHidesAccount ||
    !summary.passwordResetConfirmOk ||
    !summary.reusedPasswordResetRejected ||
    !summary.changedPasswordLoginRejectedAfterReset ||
    !summary.resetPasswordLoginOk ||
    !summary.bearerSessionAccepted ||
    !summary.bearerLogoutDestroysSession ||
    !summary.bearerPasswordChangeOk ||
    !summary.bearerPasswordChangeKeepsCurrentSession ||
    !summary.bearerPasswordChangeRejectsOldPassword ||
    !summary.bearerPasswordChangeAcceptsNewPassword ||
    !summary.bearerPasswordUserDeleted ||
    !summary.finalizeOk ||
    !summary.reviewConfirmed ||
    !summary.publishBeforeDeleteOk ||
    !summary.publicShareBeforeDeleteVisible ||
    !["byok", "hybrid", "official_quota"].includes(summary.finalizeProcessingRoute) ||
    (summary.finalizeProvider !== "mock" && summary.finalizeProcessingRoute !== "byok" && summary.usedMinutesAfterFinalize !== 1) ||
    (summary.finalizeProvider !== "mock" && summary.finalizeProcessingRoute === "byok" && summary.usedMinutesAfterFinalize !== 0) ||
    !summary.usageApiOk ||
    (summary.finalizeProvider !== "mock" && summary.finalizeProcessingRoute !== "byok" && !summary.usageHasMeetingFinalize) ||
    (summary.finalizeProvider !== "mock" && summary.finalizeProcessingRoute === "byok" && summary.usageHasMeetingFinalize) ||
    !summary.mockFinalizationDidNotConsumeOfficialQuota ||
    summary.costControlModeAfterFinalize !== "official_quota" ||
    !summary.providerSaveOk ||
    !summary.providerSwitchedToLegacyAuth ||
    !summary.legacyAuthRemovedApiKey ||
    !summary.providerSwitchedBackToApiKey ||
    !summary.apiKeyAuthRemovedLegacyToken ||
    !summary.arkProviderSaveOk ||
    summary.providerCount < 2 ||
    !summary.asrHealthReady ||
    !summary.arkHealthReady ||
    !summary.providerSetupReportReady ||
    !summary.providerSetupReportHasCapabilities ||
    (!summary.planUpdateOk && !summary.planUpdateBlocked) ||
    (summary.planUpdateOk && summary.planAfterUpdate !== "plus") ||
    (summary.planUpdateOk && summary.minutesAfterPlanUpdate !== 600) ||
    (summary.planUpdateOk && !summary.usageHasPlanChange) ||
    (summary.planUpdateOk && summary.costControlModeAfterPlan !== "byok") ||
    (summary.planUpdateBlocked && summary.planAfterUpdate !== "free") ||
    (summary.planUpdateBlocked && summary.minutesAfterPlanUpdate !== 60) ||
    (summary.planUpdateBlocked && summary.usageHasPlanChange) ||
    (summary.planUpdateBlocked && summary.costControlModeAfterPlan !== summary.costControlModeAfterFinalize) ||
    !summary.accountExportOk ||
    summary.accountExportEmail !== email ||
    summary.accountExportProviderCount < 2 ||
    !summary.accountExportHasMeeting ||
    !summary.accountExportHasUsageEvents ||
    !summary.accountExportHidesSecrets ||
    (summary.role === "admin" && (!summary.adminUsersOkWhenAdmin || !summary.adminUsersContainsSelf)) ||
    (summary.role !== "admin" && !summary.adminUsersForbiddenWhenUser) ||
    (summary.role === "admin" && (!summary.adminMetricsOkWhenAdmin || !summary.adminMetricsHasFunnel || !summary.adminMetricsHasCommercial)) ||
    (summary.role !== "admin" && !summary.adminMetricsForbiddenWhenUser) ||
    (summary.role === "admin" && !summary.adminPlanGrantOkWhenAdmin) ||
    (summary.role !== "admin" && !summary.adminPlanGrantForbiddenWhenUser) ||
    (summary.role === "admin" && !summary.adminGrantStatusOkWhenAdmin) ||
    (summary.role !== "admin" && !summary.adminGrantStatusForbiddenWhenUser) ||
    summary.deleteStatus !== 200 ||
    !summary.deleteRateLimitOk ||
    !summary.deleteResponseHidesMeetingIdentifiers ||
    !summary.shareHiddenAfterAccountDelete ||
    summary.meetingAfterAccountDeleteStatus !== 401
  ) {
    process.exitCode = 1;
  }
}

async function uploadChunk(meetingId, cookie) {
  const audio = new Blob([buildSilentWav()], {
    type: "audio/wav",
  });
  const form = new FormData();
  form.append("sequence", "1");
  form.append("mimeType", "audio/wav");
  form.append("recordedAt", String(Date.now()));
  form.append("durationMs", "1000");
  form.append("chunk", audio, "chunk-000001.wav");

  const response = await fetch(`${baseUrl}/api/meetings/${meetingId}/chunks`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: browserOrigin, "Sec-Fetch-Site": "same-origin" },
    body: form,
  });
  return readJson(response, `/api/meetings/${meetingId}/chunks`);
}

async function postJson(path, body, cookie, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: browserOrigin,
      "Sec-Fetch-Site": "same-origin",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.headers || {}),
    },
    body: JSON.stringify(body),
  });
  const payload = await readJson(response, path, { allowError: options.allowError });
  return { response, payload };
}

async function getJson(path, cookie) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Cookie: cookie },
  });
  const payload = await readJson(response, path);
  return { response, payload };
}

async function readJson(response, path, options = {}) {
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON from ${path}: ${error.message}\n${text.slice(0, 500)}`);
  }

  if (!response.ok && !options.allowError) {
    throw new Error(`HTTP ${response.status} from ${path}: ${JSON.stringify(payload)}`);
  }

  return payload;
}

function extractCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("Register response did not set a session cookie.");
  return setCookie.split(";")[0];
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
