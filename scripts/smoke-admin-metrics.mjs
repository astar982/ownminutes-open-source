#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildSilentWav } from "./lib/audio-fixtures.mjs";

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3003";
const requestOrigin = new URL(baseUrl).origin;
const authDir = path.join(process.cwd(), ".data", "auth");
const storePath = path.join(authDir, "store.json");
const secretPath = path.join(authDir, "local-secret");
const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const meetingId = `admin-share-analytics-${timestamp}`;
const attributedMeetingId = `admin-share-attributed-${timestamp}`;
const targetRegisterIp = `198.51.120.${crypto.randomInt(1, 255)}`;
const attributedRegisterIp = `198.51.121.${crypto.randomInt(1, 255)}`;

async function main() {
  const store = readStore();
  const admin = store.users.find((user) => !user.deletedAt && user.role === "admin");
  if (!admin) {
    throw new Error("No active admin user found in local auth store.");
  }

  const token = crypto.randomBytes(32).toString("base64url");
  const session = createSession(admin.id, token);
  store.sessions.push(session);
  writeStore(store);

  try {
    const target = await postJson("/api/auth/register", {
      name: "Admin Grant Smoke",
      email: `admin-grant-${timestamp}@ownminutes.local`,
      password: `OwnMinutes-${timestamp}`,
    }, undefined, { "x-forwarded-for": targetRegisterIp });
    const targetCookie = extractCookie(target.response);
    const grant = await postJson(
      `/api/admin/users/${target.payload.user?.id}/plan`,
      {
        plan: "plus",
        reason: "smoke-admin-grant",
      },
      `${cookieName()}=${token}`,
    );
    const audio = new Blob([buildSilentWav()], {
      type: "audio/wav",
    });
    const form = new FormData();
    form.append("sequence", "1");
    form.append("mimeType", "audio/wav");
    form.append("recordedAt", String(Date.now()));
    form.append("durationMs", "1000");
    form.append("chunk", audio, "chunk-000001.wav");
    const upload = await postForm(`/api/meetings/${meetingId}/chunks`, form, targetCookie);
    const final = await postJson(
      `/api/meetings/${meetingId}/finalize`,
      {
        title: "后台分享访问烟测",
        expectedLastSequence: upload.totalChunks,
        totalBytes: upload.totalBytes,
      },
      targetCookie,
    );
    const review = await postJson(`/api/meetings/${meetingId}/review`, { confirmed: true }, targetCookie);
    const publishShare = await postJson(
      `/api/meetings/${meetingId}/share`,
      {
        visibility: "public",
        includeTranscript: false,
        confirmUnverified: true,
      },
      targetCookie,
    );
    const publicShare = await fetch(`${baseUrl}/share/${meetingId}`);
    const publicShareText = await publicShare.text();
    const attributedRegister = await postJson("/api/auth/register", {
      name: "Share Attributed Smoke",
      email: `share-attributed-${timestamp}@ownminutes.local`,
      password: `OwnMinutesShare-${timestamp}`,
      source: "share",
      shareId: meetingId,
    }, undefined, { "x-forwarded-for": attributedRegisterIp });
    const attributedCookie = extractCookie(attributedRegister.response);
    const attributedProvider = await postJson(
      "/api/account/provider-credentials",
      {
        providerId: "volcano-asr",
        label: "Share Attribution Smoke ASR",
        fields: { VOLCANO_ASR_APP_ID: "share-attribution-app-id" },
        secrets: { VOLCANO_ASR_API_KEY: "share-attribution-secret-key" },
      },
      attributedCookie,
    );
    const attributedAudio = new Blob([buildSilentWav()], {
      type: "audio/wav",
    });
    const attributedForm = new FormData();
    attributedForm.append("sequence", "1");
    attributedForm.append("mimeType", "audio/wav");
    attributedForm.append("recordedAt", String(Date.now()));
    attributedForm.append("durationMs", "1000");
    attributedForm.append("chunk", attributedAudio, "chunk-000001.wav");
    const attributedUpload = await postForm(`/api/meetings/${attributedMeetingId}/chunks`, attributedForm, attributedCookie);
    const attributedFinal = await postJson(
      `/api/meetings/${attributedMeetingId}/finalize`,
      {
        title: "分享来源首场会议烟测",
        expectedLastSequence: attributedUpload.totalChunks,
        totalBytes: attributedUpload.totalBytes,
      },
      attributedCookie,
    );
    const adminMetrics = await getJson("/api/admin/metrics", `${cookieName()}=${token}`);
    const targetGrant = adminMetrics.payload.entitlementGrants?.find(
      (item) =>
        item.userId === target.payload.user?.id &&
        item.plan === "plus" &&
        item.previousPlan === "free" &&
        item.source === "admin_manual" &&
        item.status === "active" &&
        item.reason === "smoke-admin-grant",
    );
    const targetAfterGrant = await getJson("/api/auth/me", targetCookie);
    const targetUsageAfterGrant = await getJson("/api/account/usage", targetCookie);
    const refund = await postJson(
      `/api/admin/entitlement-grants/${targetGrant?.id}/status`,
      {
        status: "refunded",
        reason: "smoke-admin-refund",
      },
      `${cookieName()}=${token}`,
    );
    const adminMetricsAfterRefund = await getJson("/api/admin/metrics", `${cookieName()}=${token}`);
    const adminUsers = await getJson("/api/admin/users", `${cookieName()}=${token}`);
    const adminPage = await fetch(`${baseUrl}/admin`, {
      headers: { Cookie: `${cookieName()}=${token}` },
    });
    const adminHtml = await adminPage.text();
    const targetAfterRefund = await getJson("/api/auth/me", targetCookie);
    const targetUsageAfterRefund = await getJson("/api/account/usage", targetCookie);
    const deleteTarget = await fetch(`${baseUrl}/api/auth/delete`, {
      method: "DELETE",
      headers: { Cookie: targetCookie, Origin: requestOrigin },
    });
    const deleteTargetPayload = await readJson(deleteTarget, "/api/auth/delete", { allowError: true });
    const deleteAttributed = await fetch(`${baseUrl}/api/auth/delete`, {
      method: "DELETE",
      headers: { Cookie: attributedCookie, Origin: requestOrigin },
    });
    const deleteAttributedPayload = await readJson(deleteAttributed, "/api/auth/delete", { allowError: true });

    const summary = {
      adminEmail: admin.email,
      targetRegistered: target.payload.ok === true,
      grantOk: grant.payload.ok === true,
      uploadOk: upload.ok === true,
      finalizeOk: final.payload?.ok === true,
      reviewConfirmed: review.payload?.ok === true && review.payload?.humanReview?.status === "confirmed",
      publishShareOk: publishShare.payload?.ok === true,
      publicShareStatus: publicShare.status,
      publicShareVisible: publicShareText.includes("后台分享访问烟测") && publicShareText.includes("公开分享的会议纪要"),
      publicShareHasRegisterCta: publicShareText.includes("免费注册，记录我的会议") && publicShareText.includes(`shareId=${meetingId}`),
      attributedRegisterOk: attributedRegister.payload.ok === true,
      attributedProviderOk: attributedProvider.payload.ok === true,
      attributedUploadOk: attributedUpload.ok === true,
      attributedFinalizeOk: attributedFinal.payload?.ok === true,
      targetPlanAfterGrant: targetAfterGrant.payload.user?.plan,
      targetMinutesAfterGrant: targetUsageAfterGrant.payload.usage?.officialMinutesTotal,
      targetUsageHasAdminGrant: targetUsageAfterGrant.payload.usage?.events?.some((event) => event.type === "manual_adjustment" && event.note?.includes("smoke-admin-grant")),
      refundOk: refund.payload.ok === true,
      targetPlanAfterRefund: targetAfterRefund.payload.user?.plan,
      targetMinutesAfterRefund: targetUsageAfterRefund.payload.usage?.officialMinutesTotal,
      targetUsageHasRefund: targetUsageAfterRefund.payload.usage?.events?.some((event) => event.type === "manual_adjustment" && event.note?.includes("smoke-admin-refund")),
      metricsOk: adminMetrics.payload.ok === true,
      usersOk: adminUsers.payload.ok === true,
      adminPageStatus: adminPage.status,
      adminPageHasLaunchRisk:
        adminHtml.includes("上线风险") &&
        adminHtml.includes("critical blocker") &&
        adminHtml.includes("TestFlight") &&
        adminHtml.includes("Blocked") &&
        adminHtml.includes("打开验收中心") &&
        adminHtml.includes('href="/checkup"') &&
        adminHtml.includes("配置模型") &&
        adminHtml.includes('href="/settings"'),
      adminPageHasShareAnalytics: adminHtml.includes("分享访问") && adminHtml.includes("公开链接") && adminHtml.includes("被打开"),
      adminPageHasGrowthAttribution: adminHtml.includes("分享带来注册") && adminHtml.includes("配置模型") && adminHtml.includes("完成首场会议"),
      adminPageHasShareActivationFunnel:
        adminHtml.includes("分享后配置模型") &&
        adminHtml.includes("分享后首场会议") &&
        adminHtml.includes("分享后付费"),
      activeUsers: adminMetrics.payload.metrics?.activeUsers,
      funnelSteps: adminMetrics.payload.funnel?.length,
      hasProviderSetupRate: typeof adminMetrics.payload.commercialMetrics?.conversionRates?.providerSetup === "number",
      hasActivationRate: typeof adminMetrics.payload.commercialMetrics?.conversionRates?.activation === "number",
      hasPaidRate: typeof adminMetrics.payload.commercialMetrics?.conversionRates?.paid === "number",
      hasEntitlementGrants: Array.isArray(adminMetrics.payload.entitlementGrants),
      hasBillingOrders: Array.isArray(adminMetrics.payload.billingOrders),
      hasShareAnalytics:
        typeof adminMetrics.payload.shareAnalytics?.publicShares === "number" &&
        typeof adminMetrics.payload.shareAnalytics?.viewedShares === "number" &&
        typeof adminMetrics.payload.shareAnalytics?.totalShareViews === "number",
      shareAnalyticsRecorded:
        adminMetrics.payload.shareAnalytics?.publicShares >= 1 &&
        adminMetrics.payload.shareAnalytics?.viewedShares >= 1 &&
        adminMetrics.payload.shareAnalytics?.totalShareViews >= 1,
      hasGrowthMetrics:
        typeof adminMetrics.payload.growthMetrics?.shareAttributedRegistrations === "number" &&
        typeof adminMetrics.payload.growthMetrics?.shareAttributedProviderUsers === "number" &&
        typeof adminMetrics.payload.growthMetrics?.shareAttributedActivatedUsers === "number" &&
        typeof adminMetrics.payload.growthMetrics?.shareAttributedPayingUsers === "number" &&
        typeof adminMetrics.payload.growthMetrics?.shareConversionRates?.providerSetup === "number" &&
        typeof adminMetrics.payload.growthMetrics?.shareConversionRates?.activation === "number" &&
        typeof adminMetrics.payload.growthMetrics?.totalTrackedRegistrations === "number" &&
        Array.isArray(adminMetrics.payload.growthMetrics?.topShareRegistrations),
      shareRegistrationRecorded:
        adminMetrics.payload.growthMetrics?.shareAttributedRegistrations >= 1 &&
        adminMetrics.payload.growthMetrics?.topShareRegistrations?.some((item) => item.shareId === meetingId && item.registrations >= 1),
      shareActivationRecorded:
        adminMetrics.payload.growthMetrics?.shareAttributedProviderUsers >= 1 &&
        adminMetrics.payload.growthMetrics?.shareAttributedActivatedUsers >= 1,
      entitlementGrantHasTarget: Boolean(targetGrant),
      billingOrderHasTarget: adminMetrics.payload.billingOrders?.some(
        (item) =>
          item.id === targetGrant?.billingOrderId &&
          item.userId === target.payload.user?.id &&
          item.provider === "admin_manual" &&
          item.status === "paid" &&
          item.plan === "plus" &&
          item.amountCents === 0 &&
          item.entitlementGrantId === targetGrant?.id &&
          typeof item.idempotencyKey === "string" &&
          item.idempotencyKey.includes(target.payload.user?.id),
      ),
      entitlementGrantRefunded: adminMetricsAfterRefund.payload.entitlementGrants?.some(
        (item) =>
          item.userId === target.payload.user?.id &&
          item.plan === "plus" &&
          item.previousPlan === "free" &&
          item.source === "admin_manual" &&
          item.status === "refunded" &&
          item.reason === "smoke-admin-grant" &&
          item.statusReason === "smoke-admin-refund",
      ),
      billingOrderRefunded: adminMetricsAfterRefund.payload.billingOrders?.some(
        (item) => item.id === targetGrant?.billingOrderId && item.status === "refunded" && item.statusReason === "smoke-admin-refund",
      ),
      usersReturned: adminUsers.payload.users?.length,
      adminUsersHasTargetFree: adminUsers.payload.users?.some((user) => user.id === target.payload.user?.id && user.plan === "free" && user.officialMinutesTotal === 60),
      targetDeleteOk: deleteTargetPayload.ok === true,
      attributedDeleteOk: deleteAttributedPayload.ok === true,
      secretsLeaked: JSON.stringify(adminMetrics.payload).includes("smoke-secret-api-key") || JSON.stringify(adminMetrics.payload).includes("smoke-ark-api-key"),
    };

    console.log(JSON.stringify(summary, null, 2));

    if (
      !summary.metricsOk ||
      summary.adminPageStatus !== 200 ||
      !summary.adminPageHasLaunchRisk ||
      !summary.adminPageHasShareAnalytics ||
      !summary.adminPageHasGrowthAttribution ||
      !summary.adminPageHasShareActivationFunnel ||
      !summary.targetRegistered ||
      !summary.grantOk ||
      !summary.uploadOk ||
      !summary.finalizeOk ||
      !summary.reviewConfirmed ||
      !summary.publishShareOk ||
      summary.publicShareStatus !== 200 ||
      !summary.publicShareVisible ||
      !summary.publicShareHasRegisterCta ||
      !summary.attributedRegisterOk ||
      !summary.attributedProviderOk ||
      !summary.attributedUploadOk ||
      !summary.attributedFinalizeOk ||
      summary.targetPlanAfterGrant !== "plus" ||
      summary.targetMinutesAfterGrant !== 600 ||
      !summary.targetUsageHasAdminGrant ||
      !summary.refundOk ||
      summary.targetPlanAfterRefund !== "free" ||
      summary.targetMinutesAfterRefund !== 60 ||
      !summary.targetUsageHasRefund ||
      !summary.usersOk ||
      typeof summary.activeUsers !== "number" ||
      summary.funnelSteps < 5 ||
      !summary.hasProviderSetupRate ||
      !summary.hasActivationRate ||
      !summary.hasPaidRate ||
      !summary.hasEntitlementGrants ||
      !summary.hasBillingOrders ||
      !summary.hasShareAnalytics ||
      !summary.shareAnalyticsRecorded ||
      !summary.hasGrowthMetrics ||
      !summary.shareRegistrationRecorded ||
      !summary.shareActivationRecorded ||
      !summary.entitlementGrantHasTarget ||
      !summary.billingOrderHasTarget ||
      !summary.entitlementGrantRefunded ||
      !summary.billingOrderRefunded ||
      typeof summary.usersReturned !== "number" ||
      !summary.adminUsersHasTargetFree ||
      !summary.targetDeleteOk ||
      !summary.attributedDeleteOk ||
      summary.secretsLeaked
    ) {
      process.exitCode = 1;
    }
  } finally {
    const nextStore = readStore();
    nextStore.sessions = nextStore.sessions.filter((item) => item.id !== session.id);
    writeStore(nextStore);
  }
}

function createSession(userId, token) {
  const now = new Date();
  return {
    id: `session_smoke_${Date.now()}`,
    userId,
    tokenHash: hashToken(token),
    createdAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
  };
}

function hashToken(token) {
  return crypto.createHmac("sha256", getLocalSecret()).update(token).digest("base64url");
}

function getLocalSecret() {
  const envSecret = process.env.OWNMINUTES_APP_SECRET || process.env.AUTH_SECRET;
  if (envSecret && envSecret.length >= 32) return envSecret;
  if (!fs.existsSync(secretPath)) throw new Error("Local auth secret is missing.");
  return fs.readFileSync(secretPath, "utf8").trim();
}

function readStore() {
  if (!fs.existsSync(storePath)) throw new Error("Local auth store is missing.");
  return JSON.parse(fs.readFileSync(storePath, "utf8"));
}

function writeStore(store) {
  fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

async function getJson(apiPath, cookie) {
  const response = await fetch(`${baseUrl}${apiPath}`, {
    headers: { Cookie: cookie },
  });
  const payload = await readJson(response, apiPath);
  return { response, payload };
}

async function postForm(apiPath, body, cookie) {
  const response = await fetch(`${baseUrl}${apiPath}`, {
    method: "POST",
    headers: {
      Origin: requestOrigin,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body,
  });
  return readJson(response, apiPath);
}

async function postJson(apiPath, body, cookie, extraHeaders = {}) {
  const response = await fetch(`${baseUrl}${apiPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: requestOrigin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const payload = await readJson(response, apiPath);
  return { response, payload };
}

async function readJson(response, apiPath, options = {}) {
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON from ${apiPath}: ${error.message}\n${text.slice(0, 500)}`);
  }

  if (!response.ok && !options.allowError) {
    throw new Error(`HTTP ${response.status} from ${apiPath}: ${JSON.stringify(payload)}`);
  }

  return payload;
}

function extractCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("Register response did not set a session cookie.");
  return setCookie.split(";")[0];
}

function cookieName() {
  return "ownminutes_session";
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
