#!/usr/bin/env node

import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import sharp from "sharp";

const root = resolve(".data/smoke/app-store-submission");
const showcaseSource = readFileSync("apps/mobile/src/AppStoreShowcase.tsx", "utf8");
const transcriptFixtureSource = showcaseSource.slice(0, showcaseSource.indexOf("export function AppStoreShowcase"));
const englishShowcaseSource = showcaseSource.slice(showcaseSource.indexOf('  "en-US": {'), showcaseSource.indexOf('  "zh-Hant": {'));
const traditionalChineseShowcaseSource = showcaseSource.slice(showcaseSource.indexOf('  "zh-Hant": {'), showcaseSource.indexOf("type ShowcaseCopy"));
const taskLineSource = showcaseSource.match(/function TaskLine[\s\S]*?\n}/)?.[0] || "";
const bottomTabsSource = showcaseSource.match(/function BottomTabs[\s\S]*?\n}/)?.[0] || "";
const fixtureRoot = join(root, "pass");
const screenshotDir = join(fixtureRoot, "screenshots");
const metadataPath = join(fixtureRoot, "metadata.json");
const iconPath = join(fixtureRoot, "icon.png");
const appConfigPath = join(fixtureRoot, "app.json");
rmSync(root, { recursive: true, force: true });
mkdirSync(screenshotDir, { recursive: true });

const metadata = JSON.parse(readFileSync("app-store/metadata/zh-Hans.json", "utf8"));
const localizedMetadata = [
  metadata,
  JSON.parse(readFileSync("app-store/metadata/en-US.json", "utf8")),
  JSON.parse(readFileSync("app-store/metadata/zh-Hant.json", "utf8")),
];
writePrivate(metadataPath, JSON.stringify(metadata, null, 2));
writePrivate(appConfigPath, readFileSync("apps/mobile/app.json"));
copyFileSync("apps/mobile/assets/icon.png", iconPath);
chmodSync(iconPath, 0o600);

for (const item of metadata.screenshots) {
  await createFixtureScreenshot(join(screenshotDir, `${String(item.order).padStart(2, "0")}-${item.id}.png`), item.order, item.title);
}

const pass = run({ metadataPath, appConfigPath, iconPath, screenshotDir, strict: true });
const englishViaArgument = run({ appConfigPath, iconPath, screenshotDir, strict: true, localeArgument: "en-US" });
const traditionalChineseViaEnvironment = run({ appConfigPath, iconPath, screenshotDir, strict: true, localeEnvironment: "zh-Hant" });
const mismatchedLocale = run({ metadataPath, appConfigPath, iconPath, screenshotDir, strict: true, localeArgument: "en-US" });

writePrivate(metadataPath, JSON.stringify({ ...metadata, keywords: `${metadata.keywords},Obsidian` }, null, 2));
const thirdPartyKeyword = run({ metadataPath, appConfigPath, iconPath, screenshotDir, strict: true });
writePrivate(metadataPath, JSON.stringify(metadata, null, 2));

writePrivate(metadataPath, JSON.stringify({ ...metadata, urls: { ...metadata.urls, marketing: "" } }, null, 2));
const emptyMarketingUrl = run({ metadataPath, appConfigPath, iconPath, screenshotDir, strict: true });
writePrivate(metadataPath, JSON.stringify({ ...metadata, urls: { ...metadata.urls, marketing: "http://localhost:3000" } }, null, 2));
const invalidMarketingUrl = run({ metadataPath, appConfigPath, iconPath, screenshotDir, strict: true });
writePrivate(metadataPath, JSON.stringify(metadata, null, 2));

rmSync(join(screenshotDir, "02-transcript.png"));
const missingScreenshot = run({ metadataPath, appConfigPath, iconPath, screenshotDir, strict: true });
await createFixtureScreenshot(join(screenshotDir, "02-transcript.png"), 2, metadata.screenshots[1].title);

copyFileSync(join(screenshotDir, "01-recording.png"), join(screenshotDir, "02-transcript.png"));
const duplicateScreenshot = run({ metadataPath, appConfigPath, iconPath, screenshotDir, strict: true });
await createFixtureScreenshot(join(screenshotDir, "02-transcript.png"), 2, metadata.screenshots[1].title);

await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 13, g: 59, b: 49, alpha: 0.5 } } }).png().toFile(iconPath);
const alphaIcon = run({ metadataPath, appConfigPath, iconPath, screenshotDir, strict: true });
copyFileSync("apps/mobile/assets/icon.png", iconPath);

const brokenMetadata = { ...metadata, subtitle: "这是一条故意超过三十个字符限制并且不能提交到应用商店的超长副标题", keywords: `${metadata.keywords},${"超长关键词".repeat(12)}` };
writePrivate(metadataPath, JSON.stringify(brokenMetadata, null, 2));
const invalidMetadata = run({ metadataPath, appConfigPath, iconPath, screenshotDir, strict: true });

writePrivate(metadataPath, JSON.stringify(metadata, null, 2));
const noProductionUrls = run({ metadataPath, appConfigPath, iconPath, screenshotDir, strict: true, omitProduction: true });

const summary = {
  passFixtureAccepted: pass.status === 0 && pass.payload?.submissionReady === true && pass.payload?.requestedLocale === "zh-Hans" && pass.payload?.screenshotCount === 5,
  localeArgumentAccepted: englishViaArgument.status === 0 && englishViaArgument.payload?.submissionReady === true && englishViaArgument.payload?.locale === "en-US",
  localeEnvironmentAccepted: traditionalChineseViaEnvironment.status === 0 && traditionalChineseViaEnvironment.payload?.submissionReady === true && traditionalChineseViaEnvironment.payload?.locale === "zh-Hant",
  localeMismatchRejected: mismatchedLocale.status !== 0 && mismatchedLocale.payload?.errors?.includes("metadata locale must match requested locale en-US"),
  thirdPartyKeywordRejected: thirdPartyKeyword.status !== 0 && thirdPartyKeyword.payload?.errors?.includes("keywords must not repeat the app name or use third-party app names"),
  emptyMarketingUrlAccepted: emptyMarketingUrl.status === 0 && emptyMarketingUrl.payload?.submissionReady === true,
  invalidMarketingUrlRejected: invalidMarketingUrl.status !== 0 && invalidMarketingUrl.payload?.blockers?.includes("marketing must be empty or resolve to a stable public HTTPS URL"),
  privacyDraftLinksProductInteraction:
    localizedMetadata.every((item) => item.privacy?.dataLinkedToUser?.includes("Product Interaction")) &&
    localizedMetadata.every((item) => item.privacy?.dataNotLinkedToUser?.length === 0) &&
    localizedMetadata.every((item) => !item.privacy?.dataLinkedToUser?.some((value) => ["Crash Data", "Performance Data"].includes(value))),
  missingScreenshotRejected: missingScreenshot.status !== 0 && missingScreenshot.payload?.blockers?.some((item) => item.includes("02-transcript.png")),
  duplicateScreenshotRejected: duplicateScreenshot.status !== 0 && duplicateScreenshot.payload?.errors?.includes("App Store screenshots must not be duplicates"),
  alphaIconRejected: alphaIcon.status !== 0 && alphaIcon.payload?.errors?.includes("app icon must not contain an alpha channel"),
  metadataLimitsEnforced: invalidMetadata.status !== 0 && invalidMetadata.payload?.errors?.some((item) => item.startsWith("subtitle must")) && invalidMetadata.payload?.errors?.includes("keywords must not exceed 100 UTF-8 bytes"),
  productionUrlsRequired: noProductionUrls.status !== 0 && noProductionUrls.payload?.submissionReady === false && noProductionUrls.payload?.blockers?.some((item) => item.includes("public HTTPS")),
  liveTranscriptUsesDraftSpeakerLabels:
    transcriptFixtureSource.includes('speaker: "Speaker 1"') &&
    transcriptFixtureSource.includes('speaker: "Speaker 2"') &&
    !transcriptFixtureSource.includes("王睿") &&
    !transcriptFixtureSource.includes("陈曦") &&
    showcaseSource.includes("会后将用完整音频重新识别并校正发言人"),
  localizedShowcaseSupportsCaptureLocales:
    showcaseSource.includes('type ShowcaseLocale = "zh-Hans" | "en-US" | "zh-Hant"') &&
    showcaseSource.includes('locale: "zh-Hans"') &&
    showcaseSource.includes("parseShowcaseControl") &&
    showcaseSource.includes("transcriptRowsByLocale[control.locale]") &&
    showcaseSource.includes("showcaseCopy[control.locale]"),
  localizedShowcaseKeepsAnonymousTruthBoundary:
    !showcaseSource.includes("王睿") &&
    !showcaseSource.includes("陈曦") &&
    !showcaseSource.includes("李然") &&
    [englishShowcaseSource, traditionalChineseShowcaseSource].every((source) => source.length > 0) &&
    [englishShowcaseSource, traditionalChineseShowcaseSource].every((source) => !["王睿", "陈曦", "李然", "火山引擎", "豆包大模型", "ASR 2.0", "支付成功", "付款成功", "Payment successful", "90-minute", "90 分鐘"].some((claim) => source.includes(claim))) &&
    englishShowcaseSource.includes('speechProvider: "Your speech-to-text provider"') &&
    englishShowcaseSource.includes('summaryProvider: "Your language model"') &&
    traditionalChineseShowcaseSource.includes('speechProvider: "你的語音辨識服務"') &&
    traditionalChineseShowcaseSource.includes('summaryProvider: "你的語言模型"') &&
    showcaseSource.match(/status="BYOK"/g)?.length === 2,
  showcaseAvoidsUnverifiedClaims:
    !showcaseSource.includes("完成 90 分钟真机录音验收") &&
    !showcaseSource.includes("补齐多人会议转写质量样本") &&
    !showcaseSource.includes("实时草稿延迟约 3 秒") &&
    !showcaseSource.includes("Live draft delay is about 3 seconds") &&
    !showcaseSource.includes("即時草稿延遲約 3 秒") &&
    !showcaseSource.includes("火山引擎 ASR 2.0") &&
    !showcaseSource.includes('status="已连接"') &&
    showcaseSource.includes('speechProvider: "火山引擎文件识别"') &&
    showcaseSource.includes('summaryProvider: "豆包大模型"') &&
    showcaseSource.match(/status="BYOK"/g)?.length === 2,
  pendingTasksDoNotLookCompleted:
    taskLineSource.includes('name="time-outline"') &&
    !taskLineSource.includes('name="checkmark"'),
  showcaseUsesThreePrimaryTabs:
    bottomTabsSource.includes('{ id: "recording"') &&
    bottomTabsSource.includes('{ id: "meetings"') &&
    bottomTabsSource.includes('{ id: "account"') &&
    !bottomTabsSource.includes('{ id: "settings"') &&
    bottomTabsSource.includes(': "account"') &&
    showcaseSource.includes('appShell: { flex: 1, minHeight: 0 }') &&
    showcaseSource.includes('screenScroll: { flex: 1 }') &&
    showcaseSource.includes('tabBar: { height: 76, flexShrink: 0'),
};

console.log(JSON.stringify(summary, null, 2));
if (Object.values(summary).some((value) => value !== true)) process.exitCode = 1;

async function createFixtureScreenshot(path, order, title) {
  const bars = Array.from({ length: 42 }, (_, index) => `<rect x="${80 + index * 28}" y="${650 + ((index * 47) % 600)}" width="18" height="${120 + ((index * 31) % 320)}" rx="9" fill="#${order % 2 ? "58B99A" : "F2B84B"}" opacity="0.75"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1320" height="2868"><rect width="1320" height="2868" fill="#F5F8F6"/><rect x="60" y="180" width="1200" height="2440" rx="56" fill="#FFFFFF" stroke="#DCE7E2" stroke-width="6"/><text x="110" y="340" font-family="Arial" font-size="74" font-weight="700" fill="#10251F">${escapeXml(title)}</text><text x="110" y="450" font-family="Arial" font-size="42" fill="#60716A">OwnMinutes native fixture ${order}</text>${bars}<circle cx="660" cy="2060" r="230" fill="#176B59"/><circle cx="660" cy="2060" r="76" fill="#FFFFFF"/><rect x="280" y="2440" width="760" height="24" rx="12" fill="#DCE7E2"/></svg>`;
  await sharp(Buffer.from(svg)).flatten({ background: "#F5F8F6" }).removeAlpha().png().toFile(path);
  chmodSync(path, 0o600);
}

function run({ metadataPath, appConfigPath, iconPath, screenshotDir, strict, omitProduction = false, localeArgument, localeEnvironment }) {
  const env = {
    ...process.env,
    OWNMINUTES_APPSTORE_APP_CONFIG_PATH: appConfigPath,
    OWNMINUTES_APPSTORE_ICON_PATH: iconPath,
    OWNMINUTES_APPSTORE_SCREENSHOT_DIR: screenshotDir,
    OWNMINUTES_APPSTORE_MANIFEST_PATH: join(root, `manifest-${Date.now()}-${Math.random().toString(16).slice(2)}.json`),
    OWNMINUTES_REVIEW_CONTACT_FIRST_NAME: omitProduction ? "" : "QA",
    OWNMINUTES_REVIEW_CONTACT_LAST_NAME: omitProduction ? "" : "Owner",
    OWNMINUTES_REVIEW_CONTACT_EMAIL: omitProduction ? "" : "review@example.com",
    OWNMINUTES_REVIEW_CONTACT_PHONE: omitProduction ? "" : "+8613800000000",
    OWNMINUTES_APP_URL: omitProduction ? "" : "https://app.example.com",
    OWNMINUTES_SUPPORT_EMAIL: omitProduction ? "" : "support@ownminutes.app",
  };
  if (metadataPath) env.OWNMINUTES_APPSTORE_METADATA_PATH = metadataPath;
  else delete env.OWNMINUTES_APPSTORE_METADATA_PATH;
  if (localeEnvironment !== undefined) env.OWNMINUTES_APPSTORE_LOCALE = localeEnvironment;
  else delete env.OWNMINUTES_APPSTORE_LOCALE;
  const result = spawnSync(
    process.execPath,
    ["scripts/check-app-store-submission.mjs", ...(strict ? ["--strict"] : []), ...(localeArgument ? ["--locale", localeArgument] : [])],
    { encoding: "utf8", env },
  );
  return { status: result.status, payload: parseJson(result.stdout), output: `${result.stdout || ""}${result.stderr || ""}` };
}

function parseJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function writePrivate(path, value) {
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
