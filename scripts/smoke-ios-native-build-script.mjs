#!/usr/bin/env node

import { readFileSync } from "node:fs";

const source = readFileSync("scripts/smoke-ios-native-build.mjs", "utf8");
const ciWorkflow = readFileSync(".github/workflows/ci.yml", "utf8");
const iosReleaseJob = readWorkflowJob(ciWorkflow, "ios-release");
const rootPackage = JSON.parse(readFileSync("package.json", "utf8"));
const mobilePackage = JSON.parse(readFileSync("apps/mobile/package.json", "utf8"));
const localTestflightSource = readFileSync("scripts/build-ios-local-testflight.mjs", "utf8");
const expoModulesJsiApplePackage = readFileSync(
  "apps/mobile/node_modules/expo-modules-jsi/apple/Package.swift",
  "utf8",
);
const bundledNativeModules = JSON.parse(
  readFileSync("apps/mobile/node_modules/expo/bundledNativeModules.json", "utf8"),
);

const checks = {
  hasRootCommands:
    rootPackage.scripts?.["mobile:ios:native:preflight"] ===
      "node scripts/smoke-ios-native-build.mjs --preflight" &&
    rootPackage.scripts?.["smoke:ios-native-build"] ===
      "node scripts/smoke-ios-native-build.mjs",
  dependencyRequiresSwift62:
    expoModulesJsiApplePackage.split(/\r?\n/, 1)[0]?.trim() === "// swift-tools-version: 6.2",
  ciPinsSwift62Toolchain:
    iosReleaseJob.includes("runs-on: macos-15") &&
    iosReleaseJob.includes("DEVELOPER_DIR: /Applications/Xcode_26.2.app/Contents/Developer") &&
    iosReleaseJob.includes("Swift 6.2 or newer is required") &&
    iosReleaseJob.includes("ios-pods-${{ runner.os }}-xcode-26.2-") &&
    iosReleaseJob.includes("swift_major") &&
    iosReleaseJob.includes("swift_minor") &&
    iosReleaseJob.includes("xcrun swift package") &&
    iosReleaseJob.includes("apps/mobile/node_modules/expo-modules-jsi/apple"),
  hasSmallScreenVerificationCommand:
    rootPackage.scripts?.["mobile:ios:small-screen:verify"] ===
      "node scripts/smoke-ios-native-build.mjs --small-screen" &&
    source.includes('const smallScreenMode = process.argv.includes("--small-screen")') &&
    source.includes('const deviceName = "OwnMinutes Small iPhone"') &&
    source.includes('com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation') &&
    source.includes('`${dimensions.width}x${dimensions.height}` === "750x1334"') &&
    source.includes('screenProfile: smallScreenMode ? "small-iphone"'),
  hasAppStoreCaptureCommand:
    rootPackage.scripts?.["appstore:screenshots:capture"] ===
      "node scripts/smoke-ios-native-build.mjs --appstore-screenshots",
  stagesOutsideUnicodeRepo:
    source.includes('mkdtempSync(join(tmpdir(), "ownminutes-ios-native-smoke-"))') &&
    source.includes('OWNMINUTES_NATIVE_SMOKE_STAGE_PRECREATED === "1"') &&
    source.includes('"--exclude",\n    "/ios"') &&
    source.includes('"prebuild", "--platform", "ios", "--no-install"'),
  createsPrivateTemporaryDirectories:
    localTestflightSource.includes('mkdtempSync(join(tmpdir(), "ownminutes-ios-native-smoke-"))') &&
    localTestflightSource.includes('mkdtempSync(join(tmpdir(), "ownminutes-local-testflight-organizer-"))') &&
    localTestflightSource.includes('mkdtempSync(join(tmpdir(), "ownminutes-local-testflight-verify-"))'),
  keepsManagedSourceTree:
    source.includes('managedSourceTree: !existsSync(join(mobileRoot, "ios"))') &&
    source.includes("Native iOS preflight failed"),
  usesReleaseBuild:
    source.includes('"-configuration",\n        "Release"') &&
    source.includes("Release-iphonesimulator"),
  includesNativeIap:
    source.includes("openiap-versions.json") &&
    source.includes("prepareOpenIapSource") &&
    source.includes("injectLocalOpenIapPod") &&
    source.includes("packages/apple/Sources/"),
  retriesOpenIapGitHubFetches:
    source.includes('const retryAttempts = 4') &&
    source.includes('["api", "--cache", "1h", path]') &&
    source.includes("failed after ${retryAttempts} attempts"),
  checksExpoVersionAlignment:
    mobilePackage.dependencies?.["expo-font"] === bundledNativeModules["expo-font"] &&
    source.includes("expoFontAligned"),
  installsAndLaunchesApp:
    source.includes('"simctl", "install"') &&
    source.includes('"simctl", "launch"') &&
    source.includes("launchNativeApp"),
  checksRuntimeFailures:
    source.includes("processIdentifier == ${pid}") &&
    source.includes("Symbol not found") &&
    source.includes("Cannot find native module") &&
    source.includes("FunctionCallException") &&
    source.includes("Unhandled JS Exception") &&
    source.includes("\\[OwnMinutes\\] App render failed"),
  reusesValidatedNativeCoreCache:
    source.includes("native-smoke-cache") &&
    source.includes("seedReactNativeCoreCache") &&
    source.includes("retainReactNativeCoreCache") &&
    source.includes('runCapture("gzip", ["-t", path]).ok'),
  reusesValidatedNativeDependenciesCache:
    source.includes("seedReactNativeDependenciesCache") &&
    source.includes("retainReactNativeDependenciesCache") &&
    source.includes("isValidReactNativeDependenciesArchive") &&
    source.includes("reactNativeDependenciesCacheReused") &&
    source.includes("reactNativeDependenciesCacheRetained"),
  reusesValidatedHermesCache:
    source.includes("hermesVersion") &&
    source.includes("hermes-ios-") &&
    source.includes("seedHermesCache()") &&
    source.includes("retainHermesCache()") &&
    source.includes("isValidHermesArchive") &&
    source.includes("cached Hermes ${hermesVersion} archives") &&
    source.includes('createHash("sha256")') &&
    source.includes("hermesChecksumsConfigured") &&
    source.includes("hermesChecksumsVerified") &&
    source.includes("!hermesChecksumsVerified") &&
    source.includes("hermesCacheReused") &&
    source.includes("hermesCacheRetained"),
  capturesVisualEvidence:
    source.includes("ownminutes-ios-native-latest.png") &&
    source.includes("readPngDimensions") &&
    source.includes("screenshotStats.size < 100_000") &&
    source.includes("First runtime screenshot was incomplete") &&
    source.includes("runtimeScreenshotRecoveredAfterSimulatorRestart"),
  capturesCleanAppStoreSet:
    source.includes("ownminutes-appstore-showcase.txt") &&
    source.includes('const supportedAppStoreScreenshotLocales = ["zh-Hans", "en-US", "zh-Hant"]') &&
    source.includes('["--appstore-locale", "--locale"]') &&
    source.includes("OWNMINUTES_APPSTORE_SCREENSHOT_LOCALE") &&
    source.includes("OWNMINUTES_APPSTORE_LOCALE") &&
    source.includes('value !== "all"') &&
    source.includes('resolve(repoRoot, ".data/appstore-submission", locale, "iphone-6.9")') &&
    source.includes("JSON.stringify({ screen, locale })") &&
    source.includes("relaunchAfterSimulatorRestart") &&
    source.includes("attempt <= 30") &&
    source.includes("attempt === 10 || attempt === 20") &&
    source.includes("setTimeout(resolveWait, 1500)") &&
    source.includes("removeAlpha()") &&
    source.includes('const appStoreScreens = ["recording", "transcript", "summary", "meetings", "settings"]') &&
    source.includes("appStoreScreenshotLocales") &&
    source.includes("appStoreScreenshots"),
  localCandidateRequiresCompliance:
    localTestflightSource.includes("inspectIosAppBundle") &&
    localTestflightSource.includes("Exported IPA compliance verification failed") &&
    localTestflightSource.includes("appStoreCompliance: compliance.ready") &&
    localTestflightSource.includes("privacyManifestCount"),
  nativeReleaseRequiresCompliance:
    source.includes('import { inspectIosAppBundle } from "./lib/ios-appstore-compliance.mjs"') &&
    source.includes("Native iOS App Store compliance verification failed") &&
    source.includes("appStoreCompliance.ready") &&
    source.includes("requiredReasonCategories"),
  cleansTemporaryFiles:
    source.includes("OWNMINUTES_KEEP_NATIVE_SMOKE") &&
    source.includes("rmSync(stageRoot") &&
    source.includes("rmSync(derivedDataRoot") &&
    source.includes("rmSync(openIapRoot"),
};

console.log(JSON.stringify(checks, null, 2));
if (Object.values(checks).some((value) => !value)) process.exitCode = 1;

function readWorkflowJob(workflow, jobName) {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  if (start < 0) return "";
  const relativeEnd = lines
    .slice(start + 1)
    .findIndex((line) => /^  [A-Za-z0-9_-]+:$/.test(line));
  const end = relativeEnd < 0 ? lines.length : start + 1 + relativeEnd;
  return lines.slice(start, end).join("\n");
}
