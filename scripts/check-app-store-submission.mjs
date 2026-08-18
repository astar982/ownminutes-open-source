#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const localeArgument = readOption(args, "--locale");
const requestedLocale = String(localeArgument ?? process.env.OWNMINUTES_APPSTORE_LOCALE ?? "zh-Hans").trim();
const localeIsValid = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(requestedLocale);
const localePathSegment = localeIsValid ? requestedLocale : "zh-Hans";
const metadataPath = resolve(process.env.OWNMINUTES_APPSTORE_METADATA_PATH || `app-store/metadata/${localePathSegment}.json`);
const appConfigPath = resolve(process.env.OWNMINUTES_APPSTORE_APP_CONFIG_PATH || "apps/mobile/app.json");
const iconPath = resolve(process.env.OWNMINUTES_APPSTORE_ICON_PATH || "apps/mobile/assets/icon.png");
const screenshotDir = resolve(process.env.OWNMINUTES_APPSTORE_SCREENSHOT_DIR || `.data/appstore-submission/${localePathSegment}/iphone-6.9`);
const manifestPath = resolve(process.env.OWNMINUTES_APPSTORE_MANIFEST_PATH || ".data/appstore-submission/manifest.json");
const acceptedPortraitSizes = new Set(["1260x2736", "1290x2796", "1320x2868"]);
const errors = [];
const blockers = [];

if (!localeIsValid) errors.push("locale must be a safe App Store locale identifier such as zh-Hans, zh-Hant, or en-US");

const metadata = readJson(metadataPath, "metadata");
const appConfig = readJson(appConfigPath, "Expo app config");
const ios = appConfig?.expo?.ios || {};

validateText("name", metadata?.name, 2, 30);
validateText("subtitle", metadata?.subtitle, 1, 30);
validateText("promotionalText", metadata?.promotionalText, 1, 170);
validateText("description", metadata?.description, 1, 4000);
validateKeywords(metadata?.keywords);

if (metadata?.locale !== requestedLocale) errors.push(`metadata locale must match requested locale ${requestedLocale || "(empty)"}`);
if (appConfig?.expo?.name !== metadata?.name) errors.push("Expo app name and App Store name do not match");
if (ios.bundleIdentifier !== "app.ownminutes.mobile") errors.push("unexpected iOS bundle identifier");
if (ios.supportsTablet !== false) errors.push("first release must be iPhone-only until the iPad UX and 13-inch screenshots are accepted");
if (appConfig?.expo?.orientation !== "portrait") errors.push("App Store screenshot contract currently requires portrait orientation");
if (metadata?.screenshots?.length < 5 || metadata?.screenshots?.length > 10) errors.push("the launch screenshot set must contain 5-10 screenshots");
if (new Set((metadata?.screenshots || []).map((item) => item.id)).size !== metadata?.screenshots?.length) errors.push("screenshot ids must be unique");

const resolvedUrls = resolveUrls(metadata?.urls || {});
for (const name of ["privacyPolicy", "support"]) {
  if (!isPublicHttps(resolvedUrls[name])) blockers.push(`${name} must resolve to a stable public HTTPS URL`);
}
if (resolvedUrls.marketing && !isPublicHttps(resolvedUrls.marketing)) {
  blockers.push("marketing must be empty or resolve to a stable public HTTPS URL");
}
const supportEmail = (process.env.OWNMINUTES_SUPPORT_EMAIL || process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "").trim();
if (!isPublicSupportEmail(supportEmail)) blockers.push("OWNMINUTES_SUPPORT_EMAIL must provide a real public support contact, not a placeholder domain");

const review = metadata?.review || {};
for (const [field, envName] of Object.entries({
  contactFirstName: "OWNMINUTES_REVIEW_CONTACT_FIRST_NAME",
  contactLastName: "OWNMINUTES_REVIEW_CONTACT_LAST_NAME",
  contactEmail: "OWNMINUTES_REVIEW_CONTACT_EMAIL",
  contactPhone: "OWNMINUTES_REVIEW_CONTACT_PHONE",
})) {
  const value = resolveTemplate(review[field], envName);
  if (!value || value.includes("{{")) blockers.push(`${field} must be supplied through ${envName}`);
}
if (!review.notes || review.notes.length < 120) errors.push("review notes must explain login, microphone, AI, sharing, and account deletion");
if (!review.demoAccountReference || /password|密码\s*[:：]|@.+\.[a-z]{2,}\s*[/|,，]\s*\S+/i.test(review.demoAccountReference)) {
  errors.push("demo account credentials must stay in App Store Connect, not versioned metadata");
}
if (metadata?.privacy?.tracking !== false) errors.push("tracking declaration must be explicit");
if (!metadata?.privacy?.dataLinkedToUser?.includes("Audio Data")) errors.push("privacy declaration must include linked Audio Data");
if (!metadata?.privacy?.dataLinkedToUser?.includes("Email Address")) errors.push("privacy declaration must include linked Email Address");
if (!metadata?.privacy?.dataLinkedToUser?.includes("Product Interaction")) errors.push("privacy declaration must include linked Product Interaction");

const icon = await inspectImage(iconPath);
if (!icon.exists) errors.push("1024px app icon is missing");
if (icon.exists && (icon.width !== 1024 || icon.height !== 1024)) errors.push("app icon must be exactly 1024x1024");
if (icon.exists && icon.hasAlpha) errors.push("app icon must not contain an alpha channel");

const screenshots = [];
for (const item of metadata?.screenshots || []) {
  const name = `${String(item.order).padStart(2, "0")}-${item.id}.png`;
  const path = join(screenshotDir, name);
  const image = await inspectImage(path);
  screenshots.push({ ...item, name, path, ...image });
  if (!image.exists) blockers.push(`missing screenshot ${name}`);
  if (image.exists && !acceptedPortraitSizes.has(`${image.width}x${image.height}`)) errors.push(`${name} has unsupported 6.9-inch dimensions`);
  if (image.exists && image.hasAlpha) errors.push(`${name} must not contain an alpha channel`);
  if (image.exists && image.bytes < 20_000) errors.push(`${name} is too small to be credible native UI evidence`);
}

const screenshotHashes = screenshots.filter((item) => item.hash).map((item) => item.hash);
if (new Set(screenshotHashes).size !== screenshotHashes.length) errors.push("App Store screenshots must not be duplicates");

const forbiddenSourcePatterns = [
  /AKLT[A-Za-z0-9+/=]{12,}/,
  /sk-proj-[A-Za-z0-9_-]+/,
  /-----BEGIN (?:PRIVATE|OPENSSH) KEY-----/,
  /Secret Access Key\s*[:=]\s*\S+/i,
  /Bearer\s+[A-Za-z0-9._~-]{16,}/,
];
const metadataSource = existsSync(metadataPath) ? readFileSync(metadataPath, "utf8") : "";
if (forbiddenSourcePatterns.some((pattern) => pattern.test(metadataSource))) errors.push("metadata contains a secret-like value");

const summary = {
  checkedAt: new Date().toISOString(),
  strict,
  bundleIdentifier: ios.bundleIdentifier || null,
  version: appConfig?.expo?.version || null,
  requestedLocale,
  locale: metadata?.locale || null,
  deviceFamily: "iPhone",
  acceptedPortraitSizes: Array.from(acceptedPortraitSizes),
  icon,
  resolvedUrls,
  supportEmailConfigured: Boolean(supportEmail),
  screenshotCount: screenshots.filter((item) => item.exists).length,
  requiredScreenshotCount: metadata?.screenshots?.length || 0,
  screenshots: screenshots.map(({ path, ...item }) => ({ ...item, path: path.replace(`${process.cwd()}/`, "") })),
  errors,
  blockers,
  metadataReady: errors.length === 0,
  submissionReady: errors.length === 0 && blockers.length === 0,
};

mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
chmodSync(manifestPath, 0o600);
console.log(JSON.stringify(summary, null, 2));

if (errors.length > 0 || (strict && blockers.length > 0)) process.exitCode = 1;

function isPublicSupportEmail(value) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return false;
  const host = value.split("@")[1].toLowerCase();
  return !/^(example\.(com|net|org)|localhost)$/.test(host) && !/\.(test|invalid|localhost)$/.test(host);
}

function readJson(path, label) {
  if (!existsSync(path)) {
    errors.push(`${label} file is missing`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    errors.push(`${label} is not valid JSON`);
    return null;
  }
}

function validateText(name, value, minimum, maximum) {
  const count = typeof value === "string" ? Array.from(value).length : 0;
  if (count < minimum || count > maximum) errors.push(`${name} must contain ${minimum}-${maximum} characters`);
}

function validateKeywords(value) {
  if (typeof value !== "string" || !value.trim()) return errors.push("keywords are required");
  if (Buffer.byteLength(value, "utf8") > 100) errors.push("keywords must not exceed 100 UTF-8 bytes");
  const words = value.split(",").map((word) => word.trim());
  if (words.some((word) => Array.from(word).length < 3)) errors.push("every keyword must contain at least 3 characters");
  if (new Set(words.map((word) => word.toLowerCase())).size !== words.length) errors.push("keywords must be unique");
  const thirdPartyAppNames = [
    /钉钉|飞书|腾讯会议|石墨文档|语雀|印象笔记/i,
    /\b(?:Obsidian|Notion|Evernote|Zoom|Slack|Webex)\b/i,
    /\b(?:Microsoft Teams|Google Meet|Otter(?:\.ai)?|Fireflies(?:\.ai)?)\b/i,
  ];
  if (words.some((word) => /OwnMinutes/i.test(word) || thirdPartyAppNames.some((pattern) => pattern.test(word)))) {
    errors.push("keywords must not repeat the app name or use third-party app names");
  }
}

function readOption(values, name) {
  const inline = values.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = values.indexOf(name);
  if (index < 0) return undefined;
  const next = values[index + 1];
  return next && !next.startsWith("--") ? next : "";
}

function resolveUrls(urls) {
  const appUrl = String(process.env.OWNMINUTES_APP_URL || "").replace(/\/$/, "");
  return Object.fromEntries(Object.entries(urls).map(([key, value]) => [key, String(value || "").replaceAll("{{APP_URL}}", appUrl)]));
}

function resolveTemplate(value, envName) {
  return String(value || "").replace(`{{${envName.replace("OWNMINUTES_", "")}}}`, process.env[envName] || "");
}

function isPublicHttps(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && host !== "localhost" && host !== "127.0.0.1" && host !== "::1" && !host.endsWith(".local") && !/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host);
  } catch {
    return false;
  }
}

async function inspectImage(path) {
  if (!existsSync(path)) return { exists: false, bytes: 0, width: 0, height: 0, hasAlpha: false, hash: null };
  const file = readFileSync(path);
  const info = await sharp(file).metadata();
  return {
    exists: true,
    bytes: statSync(path).size,
    width: info.width || 0,
    height: info.height || 0,
    hasAlpha: Boolean(info.hasAlpha),
    format: info.format || null,
    hash: createHash("sha256").update(file).digest("hex"),
  };
}
