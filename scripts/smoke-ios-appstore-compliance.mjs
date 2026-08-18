#!/usr/bin/env node

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import plistModule from "@expo/plist";
import { expectedAppLocalizations, expectedCollectedData, expectedRequiredReasons, inspectIosAppBundle } from "./lib/ios-appstore-compliance.mjs";

const plist = plistModule.default || plistModule;

const root = resolve(".data/smoke/ios-appstore-compliance");
const appPath = join(root, "OwnMinutes.app");
const appConfig = JSON.parse(readFileSync("apps/mobile/app.json", "utf8"));

const validInfo = {
  CFBundleIdentifier: "app.ownminutes.mobile",
  CFBundleShortVersionString: "1.0.0",
  CFBundleVersion: "1",
  UIDeviceFamily: [1],
  UIBackgroundModes: ["audio"],
  ITSAppUsesNonExemptEncryption: false,
  LSRequiresIPhoneOS: true,
  NSMicrophoneUsageDescription: "OwnMinutes uses the microphone to record meeting audio and create meeting notes.",
  CFBundleURLTypes: [{ CFBundleURLSchemes: ["app.ownminutes.mobile"] }],
};
const validLocalizedInfo = {
  en: {
    CFBundleDisplayName: "OwnMinutes",
    NSMicrophoneUsageDescription: "OwnMinutes uses the microphone to record meeting audio and create meeting notes.",
  },
  "zh-Hans": {
    CFBundleDisplayName: "OwnMinutes",
    NSMicrophoneUsageDescription: "OwnMinutes 需要使用麦克风录制会议语音并生成会议纪要。",
  },
  "zh-Hant": {
    CFBundleDisplayName: "OwnMinutes",
    NSMicrophoneUsageDescription: "OwnMinutes 需要使用麥克風錄製會議語音並產生會議紀要。",
  },
};
const validNestedPrivacy = { NSPrivacyTracking: false, NSPrivacyCollectedDataTypes: [], NSPrivacyAccessedAPITypes: [] };
const validPrivacy = {
  NSPrivacyTracking: false,
  NSPrivacyTrackingDomains: [],
  NSPrivacyAccessedAPITypes: Object.entries(expectedRequiredReasons).map(([type, reasons]) => ({
    NSPrivacyAccessedAPIType: type,
    NSPrivacyAccessedAPITypeReasons: reasons,
  })),
  NSPrivacyCollectedDataTypes: Object.entries(expectedCollectedData).map(([type, purposes]) => ({
    NSPrivacyCollectedDataType: type,
    NSPrivacyCollectedDataTypeLinked: true,
    NSPrivacyCollectedDataTypeTracking: false,
    NSPrivacyCollectedDataTypePurposes: purposes,
  })),
};

const pass = runCase("pass", validInfo, validPrivacy);
const ipad = runCase("ipad", { ...validInfo, UIDeviceFamily: [1, 2] }, validPrivacy);
const encryption = runCase("encryption", without(validInfo, "ITSAppUsesNonExemptEncryption"), validPrivacy);
const audioMissing = runCase("audio-missing", validInfo, {
  ...validPrivacy,
  NSPrivacyCollectedDataTypes: validPrivacy.NSPrivacyCollectedDataTypes.filter((item) => item.NSPrivacyCollectedDataType !== "NSPrivacyCollectedDataTypeAudioData"),
});
const tracking = runCase("tracking", validInfo, { ...validPrivacy, NSPrivacyTracking: true, NSPrivacyTrackingDomains: ["tracker.example.com"] });
const arbitraryLoads = runCase("arbitrary-loads", { ...validInfo, NSAppTransportSecurity: { NSAllowsArbitraryLoads: true } }, validPrivacy);
const missingReason = runCase("missing-reason", validInfo, {
  ...validPrivacy,
  NSPrivacyAccessedAPITypes: validPrivacy.NSPrivacyAccessedAPITypes.filter((item) => item.NSPrivacyAccessedAPIType !== "NSPrivacyAccessedAPICategorySystemBootTime"),
});
const customScheme = runCase("custom-scheme", { ...validInfo, CFBundleURLTypes: [{ CFBundleURLSchemes: ["app.ownminutes.mobile", "ownminutes"] }] }, validPrivacy);
const nestedTracking = runCase("nested-tracking", validInfo, validPrivacy, { NSPrivacyTracking: true, NSPrivacyTrackingDomains: ["sdk.example.com"] });
const missingLocalization = runCase("missing-localization", validInfo, validPrivacy, validNestedPrivacy, without(validLocalizedInfo, "zh-Hant"));
const emptyBaseMicrophone = runCase("empty-base-microphone", { ...validInfo, NSMicrophoneUsageDescription: "  " }, validPrivacy);
const emptyLocalizedMicrophone = runCase("empty-localized-microphone", validInfo, validPrivacy, validNestedPrivacy, {
  ...validLocalizedInfo,
  en: { ...validLocalizedInfo.en, NSMicrophoneUsageDescription: "" },
});
const faceId = runCase("face-id", { ...validInfo, NSFaceIDUsageDescription: "Use Face ID" }, validPrivacy);
const localizedFaceId = runCase("localized-face-id", validInfo, validPrivacy, validNestedPrivacy, {
  ...validLocalizedInfo,
  en: { ...validLocalizedInfo.en, NSFaceIDUsageDescription: "Use Face ID" },
});

const configuredTypes = new Set(appConfig.expo.ios.privacyManifests.NSPrivacyCollectedDataTypes.map((item) => item.NSPrivacyCollectedDataType));
const summary = {
  passAccepted: pass.ready === true && pass.privacyManifestCount === 2 && Object.values(pass.checks).every(Boolean),
  ipadRejected: ipad.ready === false && ipad.errors.some((error) => error.includes("UIDeviceFamily")),
  missingEncryptionDeclarationRejected: encryption.ready === false && encryption.errors.some((error) => error.includes("ITSAppUsesNonExemptEncryption")),
  missingAudioDeclarationRejected: audioMissing.ready === false && audioMissing.errors.some((error) => error.includes("linked non-tracking data")),
  trackingRejected: tracking.ready === false && tracking.errors.some((error) => error.includes("tracking")),
  arbitraryLoadsRejected: arbitraryLoads.ready === false && arbitraryLoads.errors.some((error) => error.includes("NSAllowsArbitraryLoads")),
  missingRequiredReasonRejected: missingReason.ready === false && missingReason.errors.some((error) => error.includes("required reason")),
  customSchemeRejected: customScheme.ready === false && customScheme.errors.some((error) => error.includes("unexpected URL schemes")),
  nestedSdkTrackingRejected: nestedTracking.ready === false && nestedTracking.errors.some((error) => error.includes("SDKPrivacy.bundle")),
  missingLocalizationRejected:
    missingLocalization.ready === false &&
    missingLocalization.errors.some((error) => error.includes("zh-Hant.lproj/InfoPlist.strings is missing")),
  emptyBaseMicrophoneRejected:
    emptyBaseMicrophone.ready === false &&
    emptyBaseMicrophone.errors.some((error) => error.includes("NSMicrophoneUsageDescription must be non-empty")),
  emptyLocalizedMicrophoneRejected:
    emptyLocalizedMicrophone.ready === false &&
    emptyLocalizedMicrophone.errors.some((error) => error.includes("en.lproj/InfoPlist.strings must contain a non-empty")),
  baseFaceIdPermissionRejected:
    faceId.ready === false &&
    faceId.errors.some((error) => error.includes("NSFaceIDUsageDescription is forbidden")),
  localizedFaceIdPermissionRejected:
    localizedFaceId.ready === false &&
    localizedFaceId.errors.some((error) => error.includes("en.lproj/InfoPlist.strings must not declare NSFaceIDUsageDescription")),
  expectedLocalizationsStable: expectedAppLocalizations.join(",") === "en,zh-Hans,zh-Hant",
  appConfigDeclaresExemptEncryption: appConfig.expo.ios.config?.usesNonExemptEncryption === false,
  appConfigDeclaresAllCollectedData: Object.keys(expectedCollectedData).every((type) => configuredTypes.has(type)),
};

console.log(JSON.stringify(summary, null, 2));
if (Object.values(summary).some((value) => value !== true)) process.exitCode = 1;

function runCase(name, info, privacy, nestedPrivacy = validNestedPrivacy, localizedInfo = validLocalizedInfo) {
  rmSync(appPath, { recursive: true, force: true });
  mkdirSync(join(appPath, "SDKPrivacy.bundle"), { recursive: true });
  writeFileSync(join(appPath, "Info.plist"), plist.build(info));
  writeFileSync(join(appPath, "PrivacyInfo.xcprivacy"), plist.build(privacy));
  writeFileSync(join(appPath, "SDKPrivacy.bundle/PrivacyInfo.xcprivacy"), plist.build(nestedPrivacy));
  for (const [locale, strings] of Object.entries(localizedInfo)) {
    const directory = join(appPath, `${locale}.lproj`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "InfoPlist.strings"), serializeStrings(strings));
  }
  const result = inspectIosAppBundle(appPath, { expectedBundleId: "app.ownminutes.mobile" });
  return { name, ...result };
}

function serializeStrings(strings) {
  return `${Object.entries(strings).map(([key, value]) => `${key} = "${escapeStrings(value)}";`).join("\n")}\n`;
}

function escapeStrings(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

function without(value, key) {
  const copy = structuredClone(value);
  delete copy[key];
  return copy;
}
