#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";

const rootPackage = JSON.parse(readFileSync("package.json", "utf8"));
const mobilePackage = JSON.parse(readFileSync("apps/mobile/package.json", "utf8"));
const appConfig = JSON.parse(readFileSync("apps/mobile/app.json", "utf8"));
const easConfig = JSON.parse(readFileSync("apps/mobile/eas.json", "utf8"));
const mobileReadme = readFileSync("apps/mobile/README.md", "utf8");
const checklist = readFileSync("docs/testflight-checklist.md", "utf8");
const ciWorkflow = readFileSync(".github/workflows/ci.yml", "utf8");

const buildScript = rootPackage.scripts?.["mobile:testflight:build"] ?? "";
const submitScript = rootPackage.scripts?.["mobile:testflight:submit"] ?? "";
const preflightScript = rootPackage.scripts?.["mobile:testflight:preflight"] ?? "";
const testflightPreflightSmoke = rootPackage.scripts?.["smoke:testflight-preflight"] ?? "";
const localXcodePreflight = rootPackage.scripts?.["mobile:ios:local:preflight"] ?? "";
const localXcodeBuild = rootPackage.scripts?.["mobile:ios:local:build"] ?? "";
const localXcodeProbe = rootPackage.scripts?.["mobile:ios:local:signing-probe"] ?? "";
const localXcodeSmoke = rootPackage.scripts?.["smoke:ios-local-testflight-script"] ?? "";
const localUploadPreflight = rootPackage.scripts?.["mobile:ios:local:upload-preflight"] ?? "";
const localUpload = rootPackage.scripts?.["mobile:ios:local:upload"] ?? "";
const localUploadSmoke = rootPackage.scripts?.["smoke:ios-appstore-upload"] ?? "";
const appStoreCapture = rootPackage.scripts?.["appstore:screenshots:capture"] ?? "";
const appStoreValidate = rootPackage.scripts?.["appstore:validate"] ?? "";
const appStoreSmoke = rootPackage.scripts?.["smoke:appstore-submission"] ?? "";
const appStoreComplianceSmoke = rootPackage.scripts?.["smoke:ios-appstore-compliance"] ?? "";
const mobileI18nSmoke = rootPackage.scripts?.["smoke:mobile-i18n"] ?? "";
const mobileUiSmoke = rootPackage.scripts?.["smoke:mobile-ui"] ?? "";
const ios = appConfig.expo?.ios ?? {};
const testflightBuild = easConfig.build?.testflight ?? {};
const testflightSubmit = easConfig.submit?.testflight ?? {};
const expectedLocales = ["en", "zh-Hans", "zh-Hant"];
const localizationPlugin = (appConfig.expo?.plugins ?? []).find((entry) => Array.isArray(entry) && entry[0] === "expo-localization");
const secureStorePlugin = (appConfig.expo?.plugins ?? []).find((entry) => Array.isArray(entry) && entry[0] === "expo-secure-store");
const splashScreenPlugin = (appConfig.expo?.plugins ?? []).find((entry) => Array.isArray(entry) && entry[0] === "expo-splash-screen");

const checks = {
  rootBuildUsesMobileProjectDir:
    buildScript.includes("npm run mobile:testflight:preflight") &&
    buildScript.includes("cd apps/mobile") &&
    buildScript.includes("eas build") &&
    buildScript.includes("--platform ios") &&
    buildScript.includes("--profile testflight"),
  rootHasTestflightPreflight:
    preflightScript.includes("node scripts/check-mobile-testflight-env.mjs") &&
    existsSync("scripts/check-mobile-testflight-env.mjs"),
  rootHasTestflightPreflightSmoke:
    testflightPreflightSmoke.includes("node scripts/smoke-mobile-testflight-preflight.mjs") &&
    existsSync("scripts/smoke-mobile-testflight-preflight.mjs"),
  rootSubmitUsesMobileProjectDir:
    submitScript.includes("cd apps/mobile") &&
    submitScript.includes("eas submit") &&
    submitScript.includes("--platform ios") &&
    submitScript.includes("--profile testflight"),
  rootHasLocalXcodePath:
    localXcodePreflight.includes("build-ios-local-testflight.mjs --preflight") &&
    localXcodeBuild.includes("build-ios-local-testflight.mjs") &&
    localXcodeProbe.includes("--signing-probe") &&
    localXcodeSmoke.includes("smoke-ios-local-testflight-script.mjs") &&
    existsSync("scripts/build-ios-local-testflight.mjs") &&
    existsSync("scripts/smoke-ios-local-testflight-script.mjs"),
  rootHasLocalAppStoreUploadPath:
    localUploadPreflight.includes("upload-ios-local-testflight.mjs --preflight") &&
    localUpload.includes("OWNMINUTES_APPSTORE_UPLOAD=1") &&
    localUploadSmoke.includes("smoke-ios-appstore-upload.mjs") &&
    existsSync("scripts/upload-ios-local-testflight.mjs") &&
    existsSync("scripts/check-ios-appstore-upload-evidence.mjs") &&
    existsSync("scripts/smoke-ios-appstore-upload.mjs"),
  mobileEasConfigExists: existsSync("apps/mobile/eas.json"),
  testflightProfileIsStore: testflightBuild.distribution === "store",
  testflightBuildTargetsDevice: testflightBuild.ios?.simulator === false,
  testflightSubmitProfileExists: Boolean(testflightSubmit.ios),
  bundleIdentifierMatches: ios.bundleIdentifier === "app.ownminutes.mobile",
  nativeSplashUsesCurrentAppIcon:
    mobilePackage.dependencies?.["expo-splash-screen"] === "~56.0.13" &&
    splashScreenPlugin?.[1]?.image === "./assets/icon.png" &&
    splashScreenPlugin?.[1]?.backgroundColor === "#f7f8f6" &&
    splashScreenPlugin?.[1]?.resizeMode === "contain" &&
    Number(splashScreenPlugin?.[1]?.imageWidth) >= 128,
  firstReleaseIsIphoneOnly: ios.supportsTablet === false,
  microphoneUsageDescription:
    typeof ios.infoPlist?.NSMicrophoneUsageDescription === "string" &&
    ios.infoPlist.NSMicrophoneUsageDescription.trim().length > 0 &&
    /microphone/i.test(ios.infoPlist.NSMicrophoneUsageDescription) &&
    /meeting/i.test(ios.infoPlist.NSMicrophoneUsageDescription) &&
    !/[\u3400-\u9fff\uf900-\ufaff]/u.test(ios.infoPlist.NSMicrophoneUsageDescription),
  mobileLocalizationConfigured:
    ios.infoPlist?.CFBundleAllowMixedLocalizations === true &&
    sameStrings(localizationPlugin?.[1]?.supportedLocales?.ios, expectedLocales) &&
    sameStrings(localizationPlugin?.[1]?.supportedLocales?.android, expectedLocales) &&
    sameStrings(Object.keys(appConfig.expo?.locales ?? {}).sort(), [...expectedLocales].sort()),
  nativeLocalizationFilesComplete: expectedLocales.every((locale) => {
    const configuredPath = appConfig.expo?.locales?.[locale];
    const path = typeof configuredPath === "string" ? `apps/mobile/${configuredPath.replace(/^\.\//, "")}` : "";
    if (!path || !existsSync(path)) return false;
    const metadata = JSON.parse(readFileSync(path, "utf8"));
    return (
      typeof metadata.ios?.CFBundleDisplayName === "string" &&
      metadata.ios.CFBundleDisplayName.trim().length > 0 &&
      typeof metadata.ios?.NSMicrophoneUsageDescription === "string" &&
      metadata.ios.NSMicrophoneUsageDescription.trim().length > 0 &&
      typeof metadata.android?.app_name === "string" &&
      metadata.android.app_name.trim().length > 0 &&
      !("NSFaceIDUsageDescription" in (metadata.ios ?? {}))
    );
  }),
  noUnusedFaceIdPermission:
    !("NSFaceIDUsageDescription" in (ios.infoPlist ?? {})) &&
    secureStorePlugin?.[1]?.faceIDPermission === false,
  mobileI18nSmokeIsReleaseGated:
    mobileI18nSmoke.includes("scripts/smoke-mobile-i18n.mjs") &&
    existsSync("scripts/smoke-mobile-i18n.mjs") &&
    mobileUiSmoke.includes("npm run smoke:mobile-i18n") &&
    ciWorkflow.includes("npm run smoke:mobile-ui"),
  appIsPortrait: appConfig.expo?.orientation === "portrait",
  appStoreSubmissionPathExists:
    appStoreCapture.includes("--appstore-screenshots") &&
    appStoreValidate.includes("check-app-store-submission.mjs --strict") &&
    appStoreSmoke.includes("smoke-app-store-submission.mjs") &&
    appStoreComplianceSmoke.includes("smoke-ios-appstore-compliance.mjs") &&
    existsSync("app-store/metadata/zh-Hans.json") &&
    existsSync("docs/app-store-submission-runbook.md"),
  ciProtectsAppStoreAssets:
    ciWorkflow.includes("npm run mobile:brand:generate") &&
    ciWorkflow.includes("git diff --exit-code -- apps/mobile/assets") &&
    ciWorkflow.includes("npm run smoke:appstore-submission") &&
    ciWorkflow.includes("npm run smoke:ios-appstore-compliance") &&
    ciWorkflow.includes("npm run smoke:ios-native-build-script"),
  ciProtectsMobileStability:
    ciWorkflow.includes("npm run smoke:mobile-ui") &&
    ciWorkflow.includes("npm run smoke:mobile-stability") &&
    ciWorkflow.includes("npm run smoke:mobile-recording-watchdog") &&
    ciWorkflow.includes("npm run smoke:mobile-transport") &&
    ciWorkflow.includes("npm run smoke:mobile-pending-sync"),
  mobilePackageHasIosScript: mobilePackage.scripts?.ios === "expo start --ios",
  readmeMentionsTestflight:
    mobileReadme.includes("npm run mobile:testflight:build") &&
    mobileReadme.includes("npm run mobile:testflight:submit") &&
    mobileReadme.includes("Bundle ID") &&
    mobileReadme.includes("app.ownminutes.mobile") &&
    mobileReadme.includes("mobile:ios:local:build") &&
    mobileReadme.includes("mobile:ios:local:upload") &&
    mobileReadme.includes("SIGNING-PROBE-DO-NOT-UPLOAD"),
  readmeRequiresPublicHttpsForTestflight:
    mobileReadme.includes("TestFlight 外部测试") &&
    mobileReadme.includes("必须使用公网 HTTPS") &&
    mobileReadme.includes("EXPO_PUBLIC_API_BASE_URL=https://") &&
    mobileReadme.includes("OWNMINUTES_PRIVACY_URL=https://") &&
    mobileReadme.includes("OWNMINUTES_HEALTH_CHECK_URL=https://") &&
    mobileReadme.includes("mobile:testflight:preflight") &&
    mobileReadme.includes("smoke:testflight-preflight"),
  checklistMentionsMobileProjectDir:
    checklist.includes("cd apps/mobile") &&
    checklist.includes("eas build --platform ios --profile testflight") &&
    checklist.includes("eas submit --platform ios --profile testflight") &&
    checklist.includes("mobile:ios:local:build") &&
    checklist.includes("本地 Xcode"),
  runbookMentionsPreflightSmoke:
    readFileSync("docs/ios-testflight-acceptance-runbook.md", "utf8").includes("npm run smoke:testflight-preflight") &&
    readFileSync("docs/ios-testflight-acceptance-runbook.md", "utf8").includes("privacy, terms, support, and health-check URLs"),
};

console.log(JSON.stringify(checks, null, 2));

if (Object.values(checks).some((value) => !value)) {
  process.exitCode = 1;
}

function sameStrings(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]);
}
