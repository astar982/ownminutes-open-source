import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import plistModule from "@expo/plist";
import bplistParser from "bplist-parser";

const plist = plistModule.default || plistModule;

export const expectedRequiredReasons = {
  NSPrivacyAccessedAPICategoryUserDefaults: ["CA92.1"],
  NSPrivacyAccessedAPICategoryFileTimestamp: ["C617.1"],
  NSPrivacyAccessedAPICategorySystemBootTime: ["35F9.1"],
};

export const expectedCollectedData = {
  NSPrivacyCollectedDataTypeName: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
  NSPrivacyCollectedDataTypeEmailAddress: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
  NSPrivacyCollectedDataTypeUserID: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
  NSPrivacyCollectedDataTypePurchaseHistory: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
  NSPrivacyCollectedDataTypeAudioData: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
  NSPrivacyCollectedDataTypeOtherUserContent: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
  NSPrivacyCollectedDataTypeProductInteraction: [
    "NSPrivacyCollectedDataTypePurposeAppFunctionality",
    "NSPrivacyCollectedDataTypePurposeAnalytics",
  ],
};

export const expectedAppLocalizations = ["en", "zh-Hans", "zh-Hant"];

const allowedPrivacyKeys = new Set([
  "NSPrivacyAccessedAPITypes",
  "NSPrivacyCollectedDataTypes",
  "NSPrivacyTracking",
  "NSPrivacyTrackingDomains",
]);
const allowedPurposes = new Set([
  "NSPrivacyCollectedDataTypePurposeThirdPartyAdvertising",
  "NSPrivacyCollectedDataTypePurposeDevelopersAdvertising",
  "NSPrivacyCollectedDataTypePurposeAnalytics",
  "NSPrivacyCollectedDataTypePurposeProductPersonalization",
  "NSPrivacyCollectedDataTypePurposeAppFunctionality",
  "NSPrivacyCollectedDataTypePurposeOther",
]);

export function inspectIosAppBundle(appPath, options = {}) {
  const errors = [];
  const infoPath = join(appPath, "Info.plist");
  const rootPrivacyPath = join(appPath, "PrivacyInfo.xcprivacy");
  const info = readPlistRequired(infoPath, errors, "Info.plist");
  const rootPrivacy = readPlistRequired(rootPrivacyPath, errors, "root PrivacyInfo.xcprivacy");
  const expectedLocalizations = options.expectedLocalizations || expectedAppLocalizations;
  const localizedInfo = Object.fromEntries(expectedLocalizations.map((locale) => {
    const label = `${locale}.lproj/InfoPlist.strings`;
    return [locale, readInfoPlistStringsRequired(join(appPath, label), errors, label)];
  }));
  const privacyPaths = findFiles(appPath, "PrivacyInfo.xcprivacy");
  const parsedPrivacy = [];

  for (const path of privacyPaths) {
    const label = relative(appPath, path) || "PrivacyInfo.xcprivacy";
    const manifest = readPlistRequired(path, errors, label);
    if (manifest) {
      validatePrivacyManifest(manifest, label, errors);
      parsedPrivacy.push({ label, manifest });
    }
  }

  const deviceFamily = Array.isArray(info?.UIDeviceFamily) ? info.UIDeviceFamily.map(Number) : [];
  const backgroundModes = Array.isArray(info?.UIBackgroundModes) ? info.UIBackgroundModes : [];
  const urlSchemes = Array.isArray(info?.CFBundleURLTypes)
    ? info.CFBundleURLTypes.flatMap((item) => Array.isArray(item?.CFBundleURLSchemes) ? item.CFBundleURLSchemes : []).filter((item) => typeof item === "string")
    : [];
  const allowedUrlSchemes = new Set(options.allowedUrlSchemes || (options.expectedBundleId ? [options.expectedBundleId] : []));
  const unexpectedUrlSchemes = urlSchemes.filter((scheme) => !allowedUrlSchemes.has(scheme));
  if (options.expectedBundleId && info?.CFBundleIdentifier !== options.expectedBundleId) errors.push("Info.plist bundle identifier does not match the expected app");
  if (deviceFamily.length !== 1 || deviceFamily[0] !== 1) errors.push("UIDeviceFamily must contain only iPhone (1) for the first release");
  if (backgroundModes.length !== 1 || backgroundModes[0] !== "audio") errors.push("UIBackgroundModes must contain only audio");
  if (info?.ITSAppUsesNonExemptEncryption !== false) errors.push("ITSAppUsesNonExemptEncryption must be false for the current exempt-encryption declaration");
  if (info?.LSRequiresIPhoneOS !== true) errors.push("LSRequiresIPhoneOS must be true");
  if (!nonEmptyString(info?.NSMicrophoneUsageDescription)) errors.push("NSMicrophoneUsageDescription must be non-empty");
  if (Object.hasOwn(info || {}, "NSFaceIDUsageDescription")) errors.push("NSFaceIDUsageDescription is forbidden while Face ID is unused");
  for (const locale of expectedLocalizations) {
    const strings = localizedInfo[locale];
    if (!strings) continue;
    if (!nonEmptyString(strings.NSMicrophoneUsageDescription)) errors.push(`${locale}.lproj/InfoPlist.strings must contain a non-empty NSMicrophoneUsageDescription`);
    if (Object.hasOwn(strings, "NSFaceIDUsageDescription")) errors.push(`${locale}.lproj/InfoPlist.strings must not declare NSFaceIDUsageDescription while Face ID is unused`);
  }
  if (info?.NSUserTrackingUsageDescription) errors.push("NSUserTrackingUsageDescription is forbidden while tracking is disabled");
  if (info?.NSAppTransportSecurity?.NSAllowsArbitraryLoads === true) errors.push("NSAllowsArbitraryLoads must not be enabled");
  if (unexpectedUrlSchemes.length > 0) errors.push(`unexpected URL schemes: ${unexpectedUrlSchemes.join(", ")}`);

  if (!rootPrivacy) {
    errors.push("the app bundle must include a root PrivacyInfo.xcprivacy");
  } else {
    validateRootPrivacy(rootPrivacy, errors);
  }
  if (privacyPaths.length < 1) errors.push("no privacy manifests were found in the app bundle");
  for (const { label, manifest } of parsedPrivacy) {
    if (manifest.NSPrivacyTracking === true) errors.push(`${label} declares tracking`);
    if (Array.isArray(manifest.NSPrivacyTrackingDomains) && manifest.NSPrivacyTrackingDomains.length > 0) errors.push(`${label} declares tracking domains`);
  }

  const checks = {
    bundleId: !options.expectedBundleId || info?.CFBundleIdentifier === options.expectedBundleId,
    iphoneOnly: deviceFamily.length === 1 && deviceFamily[0] === 1,
    backgroundAudioOnly: backgroundModes.length === 1 && backgroundModes[0] === "audio",
    exemptEncryptionDeclared: info?.ITSAppUsesNonExemptEncryption === false,
    microphonePurposeDeclared: nonEmptyString(info?.NSMicrophoneUsageDescription),
    localizedInfoPlistStrings: expectedLocalizations.every((locale) => Boolean(localizedInfo[locale])),
    localizedMicrophonePurposes: expectedLocalizations.every((locale) => nonEmptyString(localizedInfo[locale]?.NSMicrophoneUsageDescription)),
    noFaceIdPermission:
      !Object.hasOwn(info || {}, "NSFaceIDUsageDescription") &&
      expectedLocalizations.every((locale) => !Object.hasOwn(localizedInfo[locale] || {}, "NSFaceIDUsageDescription")),
    noTrackingPermission: !info?.NSUserTrackingUsageDescription,
    transportSecurityRestricted: info?.NSAppTransportSecurity?.NSAllowsArbitraryLoads !== true,
    approvedUrlSchemes: unexpectedUrlSchemes.length === 0,
    rootPrivacyManifest: Boolean(rootPrivacy),
    requiredReasonApis: rootPrivacy ? requiredReasonsReady(rootPrivacy) : false,
    collectedDataDeclared: rootPrivacy ? collectedDataReady(rootPrivacy) : false,
    trackingDisabled: parsedPrivacy.every(({ manifest }) => manifest.NSPrivacyTracking !== true && (!Array.isArray(manifest.NSPrivacyTrackingDomains) || manifest.NSPrivacyTrackingDomains.length === 0)),
    allPrivacyManifestsValid: privacyPaths.length > 0 && errors.every((error) => !error.includes("PrivacyInfo") && !error.includes("privacy manifest")),
  };

  return {
    ready: errors.length === 0,
    bundleId: info?.CFBundleIdentifier || null,
    version: info?.CFBundleShortVersionString || null,
    buildNumber: info?.CFBundleVersion ? String(info.CFBundleVersion) : null,
    deviceFamily,
    backgroundModes,
    urlSchemes,
    localizations: expectedLocalizations.map((locale) => ({
      locale,
      infoPlistStrings: Boolean(localizedInfo[locale]),
      microphonePurposeDeclared: nonEmptyString(localizedInfo[locale]?.NSMicrophoneUsageDescription),
    })),
    privacyManifestCount: privacyPaths.length,
    collectedDataTypes: Array.isArray(rootPrivacy?.NSPrivacyCollectedDataTypes)
      ? rootPrivacy.NSPrivacyCollectedDataTypes.map((item) => item.NSPrivacyCollectedDataType).filter(Boolean).sort()
      : [],
    requiredReasonCategories: Array.isArray(rootPrivacy?.NSPrivacyAccessedAPITypes)
      ? rootPrivacy.NSPrivacyAccessedAPITypes.map((item) => item.NSPrivacyAccessedAPIType).filter(Boolean).sort()
      : [],
    checks,
    errors,
  };
}

export function readPlist(path) {
  const buffer = readFileSync(path);
  if (buffer.subarray(0, 8).toString("utf8") === "bplist00") {
    const parsed = bplistParser.parseBuffer(buffer);
    if (!Array.isArray(parsed) || !parsed[0] || typeof parsed[0] !== "object") throw new Error("binary plist has no root object");
    return parsed[0];
  }
  return plist.parse(buffer.toString("utf8"));
}

function readPlistRequired(path, errors, label) {
  if (!existsSync(path)) return null;
  try {
    return readPlist(path);
  } catch {
    errors.push(`${label} is not a valid plist`);
    return null;
  }
}

function readInfoPlistStringsRequired(path, errors, label) {
  if (!existsSync(path)) {
    errors.push(`${label} is missing`);
    return null;
  }
  try {
    const buffer = readFileSync(path);
    if (buffer.subarray(0, 8).toString("utf8") === "bplist00") {
      const parsed = bplistParser.parseBuffer(buffer);
      if (!Array.isArray(parsed) || !parsed[0] || typeof parsed[0] !== "object") throw new Error("binary strings file has no root object");
      return parsed[0];
    }
    const text = buffer.toString("utf8").replace(/^\ufeff/, "");
    if (/^\s*(?:<\?xml|<plist\b)/.test(text)) return plist.parse(text);
    const parsed = {};
    const rows = text.matchAll(/(?:"((?:\\.|[^"\\])*)"|([A-Za-z0-9_.-]+))\s*=\s*"((?:\\.|[^"\\])*)"\s*;/g);
    for (const row of rows) parsed[row[1] === undefined ? row[2] : decodeStringsValue(row[1])] = decodeStringsValue(row[3]);
    if (Object.keys(parsed).length === 0) throw new Error("strings file has no key-value pairs");
    return parsed;
  } catch {
    errors.push(`${label} is not a valid strings plist`);
    return null;
  }
}

function decodeStringsValue(value) {
  return value.replace(/\\([\\"nrt])/g, (_, escape) => ({ "\\": "\\", '"': '"', n: "\n", r: "\r", t: "\t" })[escape]);
}

function findFiles(root, name) {
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const matches = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === name) matches.push(path);
    }
  };
  visit(root);
  return matches.sort();
}

function validatePrivacyManifest(manifest, label, errors) {
  for (const key of Object.keys(manifest)) if (!allowedPrivacyKeys.has(key)) errors.push(`${label} contains unexpected key ${key}`);
  if (manifest.NSPrivacyTracking !== undefined && typeof manifest.NSPrivacyTracking !== "boolean") errors.push(`${label} has invalid NSPrivacyTracking`);
  if (manifest.NSPrivacyTrackingDomains !== undefined && !arrayOfStrings(manifest.NSPrivacyTrackingDomains)) errors.push(`${label} has invalid tracking domains`);
  if (manifest.NSPrivacyAccessedAPITypes !== undefined && !Array.isArray(manifest.NSPrivacyAccessedAPITypes)) errors.push(`${label} has invalid required reason API list`);
  if (manifest.NSPrivacyCollectedDataTypes !== undefined && !Array.isArray(manifest.NSPrivacyCollectedDataTypes)) errors.push(`${label} has invalid collected data list`);

  for (const item of manifest.NSPrivacyAccessedAPITypes || []) {
    if (!item || typeof item.NSPrivacyAccessedAPIType !== "string" || !arrayOfStrings(item.NSPrivacyAccessedAPITypeReasons) || item.NSPrivacyAccessedAPITypeReasons.length === 0) {
      errors.push(`${label} has an invalid required reason API declaration`);
    }
  }
  for (const item of manifest.NSPrivacyCollectedDataTypes || []) {
    if (!item || typeof item.NSPrivacyCollectedDataType !== "string" || typeof item.NSPrivacyCollectedDataTypeLinked !== "boolean" || typeof item.NSPrivacyCollectedDataTypeTracking !== "boolean" || !arrayOfStrings(item.NSPrivacyCollectedDataTypePurposes) || item.NSPrivacyCollectedDataTypePurposes.length === 0 || item.NSPrivacyCollectedDataTypePurposes.some((purpose) => !allowedPurposes.has(purpose))) {
      errors.push(`${label} has an invalid collected data declaration`);
    }
  }
}

function validateRootPrivacy(manifest, errors) {
  if (manifest.NSPrivacyTracking !== false) errors.push("root privacy manifest must explicitly disable tracking");
  if (Array.isArray(manifest.NSPrivacyTrackingDomains) && manifest.NSPrivacyTrackingDomains.length > 0) errors.push("root privacy manifest must not include tracking domains");
  if (!requiredReasonsReady(manifest)) errors.push("root privacy manifest is missing required reason API categories or approved reasons");
  if (!collectedDataReady(manifest)) errors.push("root privacy manifest is missing linked non-tracking data declarations");
}

function requiredReasonsReady(manifest) {
  const rows = new Map((manifest.NSPrivacyAccessedAPITypes || []).map((item) => [item.NSPrivacyAccessedAPIType, item.NSPrivacyAccessedAPITypeReasons || []]));
  return Object.entries(expectedRequiredReasons).every(([type, reasons]) => reasons.every((reason) => rows.get(type)?.includes(reason)));
}

function collectedDataReady(manifest) {
  const rows = new Map((manifest.NSPrivacyCollectedDataTypes || []).map((item) => [item.NSPrivacyCollectedDataType, item]));
  return Object.entries(expectedCollectedData).every(([type, purposes]) => {
    const item = rows.get(type);
    return item?.NSPrivacyCollectedDataTypeLinked === true && item?.NSPrivacyCollectedDataTypeTracking === false && purposes.every((purpose) => item.NSPrivacyCollectedDataTypePurposes?.includes(purpose));
  });
}

function arrayOfStrings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
