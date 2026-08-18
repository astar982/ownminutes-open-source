#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import sharp from "sharp";
import { inspectIosAppBundle } from "./lib/ios-appstore-compliance.mjs";

const repoRoot = process.cwd();
const mobileRoot = resolve(repoRoot, "apps/mobile");
const appConfig = JSON.parse(readFileSync(join(mobileRoot, "app.json"), "utf8"));
const mobilePackage = JSON.parse(readFileSync(join(mobileRoot, "package.json"), "utf8"));
const bundledNativeModules = JSON.parse(
  readFileSync(join(mobileRoot, "node_modules/expo/bundledNativeModules.json"), "utf8"),
);
const openIapVersions = JSON.parse(
  readFileSync(join(mobileRoot, "node_modules/expo-iap/openiap-versions.json"), "utf8"),
);
const reactNativePackage = JSON.parse(
  readFileSync(join(mobileRoot, "node_modules/react-native/package.json"), "utf8"),
);

const appName = appConfig.expo.name;
const bundleId = appConfig.expo.ios.bundleIdentifier;
const iosBuildNumber = process.env.OWNMINUTES_IOS_BUILD_NUMBER?.trim() || "";
const stageRoot = resolve(process.env.OWNMINUTES_NATIVE_SMOKE_STAGE || join(tmpdir(), "ownminutes-ios-native-smoke"));
const derivedDataRoot = resolve(
  process.env.OWNMINUTES_NATIVE_SMOKE_DERIVED_DATA || `${stageRoot}-derived`,
);
const openIapRoot = resolve(`${stageRoot}-openiap`);
const artifactRoot = resolve(repoRoot, ".data/native-smoke");
const appStoreScreenshotMode = process.argv.includes("--appstore-screenshots");
const smallScreenMode = process.argv.includes("--small-screen");
const supportedAppStoreScreenshotLocales = ["zh-Hans", "en-US", "zh-Hant"];
const appStoreScreenshotLocaleSelection = appStoreScreenshotMode
  ? readAppStoreScreenshotLocaleSelection()
  : "zh-Hans";
const appStoreScreenshotLocales = appStoreScreenshotLocaleSelection === "all"
  ? supportedAppStoreScreenshotLocales
  : [appStoreScreenshotLocaleSelection];
const screenshotPath = resolve(
  repoRoot,
  smallScreenMode
    ? ".data/screenshots/ownminutes-ios-small-screen-latest.png"
    : ".data/screenshots/ownminutes-ios-native-latest.png",
);
const appStoreScreens = ["recording", "transcript", "summary", "meetings", "settings"];
const preflightOnly = process.argv.includes("--preflight");
const keepTemporaryFiles = process.env.OWNMINUTES_KEEP_NATIVE_SMOKE === "1";
const openIapVersion = String(openIapVersions.apple || "").trim();
const reactNativeVersion = String(mobilePackage.dependencies?.["react-native"] || "").replace(/^[^\d]*/, "");
const hermesVersion = String(reactNativePackage.dependencies?.["hermes-compiler"] || "").trim();
const hermesArchiveSha256 = {
  "250829098.0.10": {
    debug: "6041a81b8d7147e9b532ff48d273cfc69d60827ecabe0d9e677c060fbaa1213e",
    release: "23f8f1b2f771a76e66c81be7d5bae82fb9e58eef18b597de3718bffad7adab51",
  },
}[hermesVersion];
const reactNativeCoreFileName = `reactnative-core-${reactNativeVersion}-debug.tar.gz`;
const reactNativeCoreCachePath = join(repoRoot, ".data/native-smoke-cache", reactNativeCoreFileName);
const stagedReactNativeCorePath = join(stageRoot, "ios/Pods/ReactNativeCore-artifacts", reactNativeCoreFileName);
const reactNativeCoreReleaseFileName = `reactnative-core-${reactNativeVersion}-release.tar.gz`;
const reactNativeCoreReleaseCachePath = join(repoRoot, ".data/native-smoke-cache", reactNativeCoreReleaseFileName);
const stagedReactNativeCoreReleasePath = join(stageRoot, "ios/Pods/ReactNativeCore-artifacts", reactNativeCoreReleaseFileName);
const reactNativeDependenciesFileName = `reactnative-dependencies-${reactNativeVersion}-debug.tar.gz`;
const reactNativeDependenciesCachePath = join(repoRoot, ".data/native-smoke-cache", reactNativeDependenciesFileName);
const stagedReactNativeDependenciesPath = join(
  stageRoot,
  "ios/Pods/ReactNativeDependencies-artifacts",
  reactNativeDependenciesFileName,
);
const hermesArchives = ["debug", "release"].map((configuration) => {
  const fileName = `hermes-ios-${hermesVersion}-${configuration}.tar.gz`;
  return {
    configuration,
    expectedSha256: hermesArchiveSha256?.[configuration] || null,
    cachePath: join(repoRoot, ".data/native-smoke-cache", fileName),
    stagedPath: join(stageRoot, "ios/Pods/hermes-engine-artifacts", fileName),
  };
});

function readAppStoreScreenshotLocaleSelection() {
  let cliValue;
  for (const option of ["--appstore-locale", "--locale"]) {
    const inlineArgument = process.argv.find((argument) => argument.startsWith(`${option}=`));
    const separateArgumentIndex = process.argv.indexOf(option);
    if (inlineArgument) {
      cliValue = inlineArgument.slice(`${option}=`.length);
      break;
    }
    if (separateArgumentIndex >= 0) {
      const candidate = process.argv[separateArgumentIndex + 1];
      if (!candidate || candidate.startsWith("--")) throw new Error(`${option} requires a locale value.`);
      cliValue = candidate;
      break;
    }
  }
  const value = cliValue?.trim()
    || process.env.OWNMINUTES_APPSTORE_SCREENSHOT_LOCALE?.trim()
    || process.env.OWNMINUTES_APPSTORE_LOCALE?.trim()
    || "zh-Hans";
  if (value !== "all" && !supportedAppStoreScreenshotLocales.includes(value)) {
    throw new Error(`Unsupported App Store screenshot locale: ${value}. Expected ${supportedAppStoreScreenshotLocales.join(", ")}, or all.`);
  }
  return value;
}

function appStoreScreenshotRoot(locale) {
  return resolve(repoRoot, ".data/appstore-submission", locale, "iphone-6.9");
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: "utf8",
    env: options.env || process.env,
    maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
    status: result.status,
  };
}

function runRequiredCapture(command, args, options = {}) {
  const result = runCapture(command, args, options);
  if (!result.ok) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.output}`);
  }
  return result.output;
}

async function runLogged(command, args, logPath, options = {}) {
  mkdirSync(dirname(logPath), { recursive: true });
  const stream = createWriteStream(logPath, { flags: "w" });
  console.log(`[ios-native] ${command} ${args.join(" ")}`);

  const exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
    child.once("error", reject);
    child.once("close", resolveExit);
  });

  await new Promise((resolveStream) => stream.end(resolveStream));
  if (exitCode !== 0) {
    const output = readFileSync(logPath, "utf8");
    throw new Error(
      `${command} failed with exit code ${exitCode}. Log: ${logPath}\n${tail(output, 100)}`,
    );
  }
}

function tail(value, lineCount) {
  return value.split("\n").slice(-lineCount).join("\n");
}

function findBootedSimulator() {
  const payload = JSON.parse(
    runRequiredCapture("xcrun", ["simctl", "list", "devices", "booted", "--json"]),
  );
  for (const [runtime, devices] of Object.entries(payload.devices || {})) {
    const device = devices.find((candidate) => candidate.state === "Booted" && candidate.isAvailable !== false);
    if (device) return { ...device, runtime };
  }
  return null;
}

function ensureAppStoreSimulator() {
  const payload = JSON.parse(runRequiredCapture("xcrun", ["simctl", "list", "devices", "available", "--json"]));
  const preferredNames = ["iPhone 17 Pro Max", "iPhone 16 Pro Max", "iPhone 15 Pro Max"];
  for (const name of preferredNames) {
    for (const [runtime, devices] of Object.entries(payload.devices || {})) {
      const device = devices.find((candidate) => candidate.name === name && candidate.isAvailable !== false);
      if (!device) continue;
      if (device.state !== "Booted") {
        runRequiredCapture("xcrun", ["simctl", "boot", device.udid]);
        runRequiredCapture("xcrun", ["simctl", "bootstatus", device.udid, "-b"]);
      }
      return { ...device, state: "Booted", runtime };
    }
  }
  return null;
}

function ensureSmallScreenSimulator() {
  const deviceName = "OwnMinutes Small iPhone";
  const deviceType = "com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation";
  let payload = JSON.parse(runRequiredCapture("xcrun", ["simctl", "list", "devices", "available", "--json"]));
  let device;
  let runtime;

  for (const [candidateRuntime, devices] of Object.entries(payload.devices || {})) {
    const candidate = devices.find(
      (entry) =>
        entry.name === deviceName &&
        entry.deviceTypeIdentifier === deviceType &&
        entry.isAvailable !== false,
    );
    if (candidate) {
      device = candidate;
      runtime = candidateRuntime;
      break;
    }
  }

  if (!device) {
    const runtimes = JSON.parse(runRequiredCapture("xcrun", ["simctl", "list", "runtimes", "available", "--json"]));
    const iosRuntime = [...(runtimes.runtimes || [])]
      .filter((entry) => entry.platform === "iOS" && entry.isAvailable !== false)
      .sort((left, right) => String(right.version).localeCompare(String(left.version), undefined, { numeric: true }))[0];
    if (!iosRuntime?.identifier) return null;
    const udid = runRequiredCapture("xcrun", ["simctl", "create", deviceName, deviceType, iosRuntime.identifier]).trim();
    payload = JSON.parse(runRequiredCapture("xcrun", ["simctl", "list", "devices", "available", "--json"]));
    runtime = iosRuntime.identifier;
    device = (payload.devices?.[runtime] || []).find((entry) => entry.udid === udid);
  }

  if (!device) return null;
  if (device.state !== "Booted") {
    runRequiredCapture("xcrun", ["simctl", "boot", device.udid]);
    runRequiredCapture("xcrun", ["simctl", "bootstatus", device.udid, "-b"]);
  }
  return { ...device, state: "Booted", runtime };
}

function commandVersion(command, args) {
  const result = runCapture(command, args);
  return { available: result.ok, value: result.output || null };
}

function collectPreflight() {
  const simulator = process.platform === "darwin"
    ? smallScreenMode
      ? ensureSmallScreenSimulator()
      : appStoreScreenshotMode
      ? ensureAppStoreSimulator()
      : findBootedSimulator()
    : null;
  const podPath = runCapture("which", ["pod"]);
  const expoFontExpected = bundledNativeModules["expo-font"];
  const expoFontActual = mobilePackage.dependencies?.["expo-font"] || null;
  return {
    appName,
    bundleId,
    platform: process.platform,
    macos: process.platform === "darwin",
    xcodebuild: commandVersion("xcodebuild", ["-version"]),
    xcrun: commandVersion("xcrun", ["--version"]),
    cocoaPods: podPath.ok
      ? { available: true, path: podPath.output, version: commandVersion(podPath.output, ["--version"]).value }
      : { available: false, path: null, version: null },
    rsync: commandVersion("rsync", ["--version"]),
    gh: commandVersion("gh", ["--version"]),
    simulator,
    managedSourceTree: !existsSync(join(mobileRoot, "ios")),
    expoFontActual,
    expoFontExpected,
    expoFontAligned: expoFontActual === expoFontExpected,
    openIapVersion,
    hermesVersion,
    hermesChecksumsConfigured: Boolean(hermesArchiveSha256),
    appStoreScreenshotMode,
    appStoreScreenshotLocaleSelection,
    appStoreScreenshotLocales,
    smallScreenMode,
    stageRoot,
    derivedDataRoot,
  };
}

function assertPreflight(preflight) {
  const checks = {
    macos: preflight.macos,
    xcodebuild: preflight.xcodebuild.available,
    xcrun: preflight.xcrun.available,
    cocoaPods: preflight.cocoaPods.available,
    rsync: preflight.rsync.available,
    gh: preflight.gh.available,
    bootedSimulator: Boolean(preflight.simulator?.udid),
    managedSourceTree: preflight.managedSourceTree,
    expoFontAligned: preflight.expoFontAligned,
    openIapVersion: Boolean(preflight.openIapVersion),
    hermesVersion: Boolean(preflight.hermesVersion),
    hermesChecksumsConfigured: preflight.hermesChecksumsConfigured,
  };
  const failed = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  if (failed.length > 0) {
    throw new Error(`Native iOS preflight failed: ${failed.join(", ")}`);
  }
}

function stageMobileProject() {
  rmSync(stageRoot, { force: true, recursive: true });
  mkdirSync(stageRoot, { recursive: true });
  runRequiredCapture("rsync", [
    "-a",
    "--delete",
    "--exclude",
    "/ios",
    "--exclude",
    "/.expo",
    `${mobileRoot}/`,
    `${stageRoot}/`,
  ]);
  if (iosBuildNumber) {
    if (!/^[1-9]\d*$/.test(iosBuildNumber)) {
      throw new Error("OWNMINUTES_IOS_BUILD_NUMBER must be a positive integer.");
    }
    const stagedAppConfigPath = join(stageRoot, "app.json");
    const stagedAppConfig = JSON.parse(readFileSync(stagedAppConfigPath, "utf8"));
    stagedAppConfig.expo.ios = {
      ...stagedAppConfig.expo.ios,
      buildNumber: iosBuildNumber,
    };
    writeFileSync(stagedAppConfigPath, `${JSON.stringify(stagedAppConfig, null, 2)}\n`);
    console.log(`[ios-native] Staged Expo ios.buildNumber=${iosBuildNumber}.`);
  }
}

function seedReactNativeCoreCache() {
  const archives = [
    [reactNativeCoreCachePath, stagedReactNativeCorePath],
    [reactNativeCoreReleaseCachePath, stagedReactNativeCoreReleasePath],
  ];
  const valid = archives.filter(([cachePath]) => isValidReactNativeCoreArchive(cachePath));
  for (const [cachePath, stagedPath] of valid) {
    mkdirSync(dirname(stagedPath), { recursive: true });
    copyFileSync(cachePath, stagedPath);
  }
  if (valid.length > 0) console.log(`[ios-native] Reusing ${valid.length}/2 cached React Native core archives ${reactNativeVersion}.`);
  return valid.length === archives.length;
}

function retainReactNativeCoreCache() {
  const archives = [
    [stagedReactNativeCorePath, reactNativeCoreCachePath],
    [stagedReactNativeCoreReleasePath, reactNativeCoreReleaseCachePath],
  ];
  let retained = 0;
  for (const [stagedPath, cachePath] of archives) {
    if (!isValidReactNativeCoreArchive(stagedPath)) continue;
    mkdirSync(dirname(cachePath), { recursive: true });
    copyFileSync(stagedPath, cachePath);
    retained += 1;
  }
  return retained === archives.length;
}

function seedReactNativeDependenciesCache() {
  if (!isValidReactNativeDependenciesArchive(reactNativeDependenciesCachePath)) return false;
  mkdirSync(dirname(stagedReactNativeDependenciesPath), { recursive: true });
  copyFileSync(reactNativeDependenciesCachePath, stagedReactNativeDependenciesPath);
  console.log(`[ios-native] Reusing cached React Native dependencies ${reactNativeVersion}.`);
  return true;
}

function retainReactNativeDependenciesCache() {
  if (!isValidReactNativeDependenciesArchive(stagedReactNativeDependenciesPath)) return false;
  mkdirSync(dirname(reactNativeDependenciesCachePath), { recursive: true });
  const temporaryPath = `${reactNativeDependenciesCachePath}.tmp`;
  copyFileSync(stagedReactNativeDependenciesPath, temporaryPath);
  if (!isValidReactNativeDependenciesArchive(temporaryPath)) {
    rmSync(temporaryPath, { force: true });
    return false;
  }
  renameSync(temporaryPath, reactNativeDependenciesCachePath);
  return true;
}

function seedHermesCache() {
  const valid = hermesArchives.filter((archive) => isValidHermesArchive(archive.cachePath, archive.expectedSha256));
  for (const archive of valid) {
    mkdirSync(dirname(archive.stagedPath), { recursive: true });
    copyFileSync(archive.cachePath, archive.stagedPath);
  }
  if (valid.length > 0) {
    console.log(`[ios-native] Reusing ${valid.length}/${hermesArchives.length} cached Hermes ${hermesVersion} archives.`);
  }
  return valid.length === hermesArchives.length;
}

function retainHermesCache() {
  let retained = 0;
  for (const archive of hermesArchives) {
    if (!isValidHermesArchive(archive.stagedPath, archive.expectedSha256)) continue;
    mkdirSync(dirname(archive.cachePath), { recursive: true });
    const temporaryPath = `${archive.cachePath}.tmp`;
    copyFileSync(archive.stagedPath, temporaryPath);
    if (!isValidHermesArchive(temporaryPath, archive.expectedSha256)) {
      rmSync(temporaryPath, { force: true });
      continue;
    }
    renameSync(temporaryPath, archive.cachePath);
    retained += 1;
  }
  return retained === hermesArchives.length;
}

function isValidReactNativeCoreArchive(path) {
  if (!existsSync(path) || statSync(path).size < 20 * 1024 * 1024) return false;
  return runCapture("gzip", ["-t", path]).ok;
}

function isValidReactNativeDependenciesArchive(path) {
  if (!existsSync(path) || statSync(path).size < 10 * 1024 * 1024) return false;
  return runCapture("gzip", ["-t", path]).ok;
}

function isValidHermesArchive(path, expectedSha256) {
  if (!expectedSha256 || !existsSync(path) || statSync(path).size < 20 * 1024 * 1024) return false;
  if (!runCapture("gzip", ["-t", path]).ok) return false;
  return createHash("sha256").update(readFileSync(path)).digest("hex") === expectedSha256;
}

function ghApi(path) {
  const retryAttempts = 4;
  let lastOutput = "";

  for (let attempt = 1; attempt <= retryAttempts; attempt += 1) {
    const result = runCapture("gh", ["api", "--cache", "1h", path], { maxBuffer: 50 * 1024 * 1024 });
    if (result.ok) return JSON.parse(result.output);
    lastOutput = result.output;
    if (attempt < retryAttempts) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 1_000);
    }
  }

  throw new Error(`gh api ${path} failed after ${retryAttempts} attempts:\n${lastOutput}`);
}

async function prepareOpenIapSource() {
  rmSync(openIapRoot, { force: true, recursive: true });
  mkdirSync(openIapRoot, { recursive: true });
  const tree = ghApi(`repos/hyodotdev/openiap/git/trees/${openIapVersion}?recursive=1`);
  const blobs = tree.tree.filter(
    (item) =>
      item.type === "blob" &&
      (item.path === "LICENSE" ||
        item.path === "openiap-versions.json" ||
        item.path.startsWith("packages/apple/Sources/")),
  );
  if (blobs.length < 10) throw new Error("OpenIAP source tree is incomplete.");

  for (const item of blobs) {
    const blob = ghApi(item.url);
    const target = join(openIapRoot, item.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(String(blob.content || "").replaceAll("\n", ""), "base64"));
  }

  const cachedPodspec = join(
    homedir(),
    ".cocoapods/repos/trunk/Specs/8/5/e/openiap",
    openIapVersion,
    "openiap.podspec.json",
  );
  let podspec;
  if (existsSync(cachedPodspec)) {
    podspec = readFileSync(cachedPodspec);
  } else {
    const response = await fetch(
      `https://cdn.cocoapods.org/Specs/8/5/e/openiap/${openIapVersion}/openiap.podspec.json`,
    );
    if (!response.ok) throw new Error(`OpenIAP podspec download failed: ${response.status}`);
    podspec = Buffer.from(await response.arrayBuffer());
  }
  writeFileSync(join(openIapRoot, "openiap.podspec.json"), podspec);
}

function injectLocalOpenIapPod() {
  const podfilePath = join(stageRoot, "ios/Podfile");
  const podfile = readFileSync(podfilePath, "utf8");
  const target = `target '${appName}' do\n`;
  if (!podfile.includes(target)) throw new Error(`Could not find ${target.trim()} in generated Podfile.`);
  const escapedPath = openIapRoot.replaceAll("'", "\\'");
  writeFileSync(
    podfilePath,
    podfile.replace(target, `${target}  pod 'openiap', :path => '${escapedPath}'\n`),
  );
}

function readPngDimensions(path) {
  const buffer = readFileSync(path);
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("Native smoke screenshot is not a PNG file.");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function launchNativeApp(appPath, simulator) {
  runCapture("xcrun", ["simctl", "terminate", simulator.udid, bundleId]);
  if (process.env.OWNMINUTES_NATIVE_SMOKE_PRESERVE_APP_DATA !== "1") {
    runCapture("xcrun", ["simctl", "uninstall", simulator.udid, bundleId]);
  }
  runRequiredCapture("xcrun", ["simctl", "install", simulator.udid, appPath]);
  const launchOutput = runRequiredCapture("xcrun", ["simctl", "launch", simulator.udid, bundleId]);
  const pid = Number(launchOutput.match(/:\s*(\d+)$/)?.[1]);
  if (!Number.isFinite(pid)) throw new Error(`Could not parse app PID from: ${launchOutput}`);
  return pid;
}

async function relaunchAfterSimulatorRestart(simulator) {
  runRequiredCapture("xcrun", ["simctl", "shutdown", simulator.udid]);
  runRequiredCapture("xcrun", ["simctl", "boot", simulator.udid]);
  runRequiredCapture("xcrun", ["simctl", "bootstatus", simulator.udid, "-b"]);
  let lastOutput = "";
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const launch = runCapture("xcrun", ["simctl", "launch", simulator.udid, bundleId]);
    lastOutput = launch.output;
    if (launch.ok) {
      const pid = Number(launch.output.match(/:\s*(\d+)$/)?.[1]);
      if (Number.isFinite(pid)) return pid;
    }
    if (attempt === 10 || attempt === 20) {
      runCapture("xcrun", ["simctl", "bootstatus", simulator.udid, "-b"]);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
  }
  throw new Error(`App did not launch after simulator restart: ${lastOutput}`);
}

function inspectRuntimeLogs(simulator, pid) {
  const output = runRequiredCapture("xcrun", [
    "simctl",
    "spawn",
    simulator.udid,
    "log",
    "show",
    "--last",
    "3m",
    "--style",
    "compact",
    "--predicate",
    `processIdentifier == ${pid}`,
  ], { maxBuffer: 50 * 1024 * 1024 });
  const fatalPattern = /Symbol not found|Cannot find native module|Uncaught \(in promise|FunctionCallException|Unhandled JS Exception|\[OwnMinutes\] App render failed|Terminated due to signal|Fatal error/i;
  return {
    fatalMatches: output.split("\n").filter((line) => fatalPattern.test(line)),
    output,
  };
}

async function main() {
  const preflight = collectPreflight();
  console.log(JSON.stringify({ preflight }, null, 2));
  assertPreflight(preflight);
  if (preflightOnly) return;

  let succeeded = false;
  try {
    mkdirSync(artifactRoot, { recursive: true });
    mkdirSync(dirname(screenshotPath), { recursive: true });
    stageMobileProject();
    const buildEnv = {
      ...process.env,
      ...(appStoreScreenshotMode ? { EXPO_PUBLIC_APPSTORE_SHOWCASE: "1" } : {}),
    };
    await runLogged(
      join(stageRoot, "node_modules/.bin/expo"),
      ["prebuild", "--platform", "ios", "--no-install"],
      join(artifactRoot, "expo-prebuild.log"),
      { cwd: stageRoot, env: { ...buildEnv, EXPO_OFFLINE: "1" } },
    );
    await prepareOpenIapSource();
    injectLocalOpenIapPod();
    seedReactNativeCoreCache();
    const reactNativeDependenciesCacheReused = seedReactNativeDependenciesCache();
    const hermesCacheReused = seedHermesCache();
    await runLogged(
      preflight.cocoaPods.path,
      ["install"],
      join(artifactRoot, "pod-install.log"),
      { cwd: join(stageRoot, "ios"), env: buildEnv },
    );
    retainReactNativeCoreCache();
    const reactNativeDependenciesCacheRetained = retainReactNativeDependenciesCache();
    const hermesCacheRetained = retainHermesCache();
    await runLogged(
      "xcodebuild",
      [
        "-workspace",
        `${appName}.xcworkspace`,
        "-scheme",
        appName,
        "-configuration",
        "Release",
        "-sdk",
        "iphonesimulator",
        "-destination",
        `platform=iOS Simulator,id=${preflight.simulator.udid}`,
        "-derivedDataPath",
        derivedDataRoot,
        "build",
      ],
      join(artifactRoot, "xcodebuild.log"),
      { cwd: join(stageRoot, "ios"), env: buildEnv },
    );

    const appPath = join(
      derivedDataRoot,
      `Build/Products/Release-iphonesimulator/${appName}.app`,
    );
    if (!existsSync(appPath)) throw new Error(`Built app is missing: ${appPath}`);
    const appStoreCompliance = inspectIosAppBundle(appPath, { expectedBundleId: bundleId });
    if (!appStoreCompliance.ready) {
      throw new Error(`Native iOS App Store compliance verification failed: ${appStoreCompliance.errors.join(", ")}`);
    }
    let pid = launchNativeApp(appPath, preflight.simulator);
    if (appStoreScreenshotMode) pid = await relaunchAfterSimulatorRestart(preflight.simulator);
    await new Promise((resolveWait) => setTimeout(resolveWait, 8000));
    let runtimeScreenshotRecoveredAfterSimulatorRestart = false;
    const appStoreScreenshotSummaries = [];
    if (appStoreScreenshotMode) {
      const dataContainer = runRequiredCapture("xcrun", ["simctl", "get_app_container", preflight.simulator.udid, bundleId, "data"]);
      const screenControlPath = join(dataContainer, "Documents/ownminutes-appstore-showcase.txt");
      for (const locale of appStoreScreenshotLocales) {
        const localeScreenshotRoot = appStoreScreenshotRoot(locale);
        rmSync(localeScreenshotRoot, { force: true, recursive: true });
        mkdirSync(localeScreenshotRoot, { recursive: true });
        for (const [index, screen] of appStoreScreens.entries()) {
          writeFileSync(screenControlPath, `${JSON.stringify({ screen, locale })}\n`);
          await new Promise((resolveWait) => setTimeout(resolveWait, 900));
          const target = join(localeScreenshotRoot, `${String(index + 1).padStart(2, "0")}-${screen}.png`);
          runRequiredCapture("xcrun", ["simctl", "io", preflight.simulator.udid, "screenshot", target]);
          const flattenedTarget = `${target}.rgb.png`;
          await sharp(target).flatten({ background: "#F6F8F7" }).removeAlpha().png().toFile(flattenedTarget);
          renameSync(flattenedTarget, target);
          chmodSync(target, 0o600);
          const dimensions = readPngDimensions(target);
          const bytes = statSync(target).size;
          if (!["1260x2736", "1290x2796", "1320x2868"].includes(`${dimensions.width}x${dimensions.height}`) || bytes < 100_000) {
            throw new Error(`App Store screenshot ${locale}/${screen} is not a valid 6.9-inch native capture.`);
          }
          appStoreScreenshotSummaries.push({ locale, screen, path: target.replace(`${repoRoot}/`, ""), bytes, ...dimensions });
        }
      }
      rmSync(screenControlPath, { force: true });
      copyFileSync(join(appStoreScreenshotRoot(appStoreScreenshotLocales[0]), "01-recording.png"), screenshotPath);
    } else {
      runRequiredCapture("xcrun", ["simctl", "io", preflight.simulator.udid, "screenshot", screenshotPath]);
      if (statSync(screenshotPath).size < 100_000) {
        console.warn("[ios-native] First runtime screenshot was incomplete; restarting the simulator for one clean retry.");
        pid = await relaunchAfterSimulatorRestart(preflight.simulator);
        runtimeScreenshotRecoveredAfterSimulatorRestart = true;
        await new Promise((resolveWait) => setTimeout(resolveWait, 8000));
        runRequiredCapture("xcrun", ["simctl", "io", preflight.simulator.udid, "screenshot", screenshotPath]);
      }
    }
    chmodSync(screenshotPath, 0o600);
    const runtime = inspectRuntimeLogs(preflight.simulator, pid);
    writeFileSync(join(artifactRoot, "runtime.log"), runtime.output);
    const screenshotStats = statSync(screenshotPath);
    const dimensions = readPngDimensions(screenshotPath);
    const smallScreenDimensionsValid = !smallScreenMode || `${dimensions.width}x${dimensions.height}` === "750x1334";
    const hermesChecksumsVerified = hermesArchives.every((archive) =>
      isValidHermesArchive(archive.cachePath, archive.expectedSha256));
    const summary = {
      nativeBuildSucceeded: true,
      configuration: "Release",
      appName,
      bundleId,
      simulator: preflight.simulator.name,
      simulatorUdid: preflight.simulator.udid,
      appPid: pid,
      expoIapVersion: mobilePackage.dependencies["expo-iap"],
      openIapVersion,
      hermesVersion,
      reactNativeDependenciesCacheReused,
      reactNativeDependenciesCacheRetained,
      hermesCacheReused,
      hermesCacheRetained,
      hermesChecksumsVerified,
      expoFontVersion: mobilePackage.dependencies["expo-font"],
      screenshotPath: screenshotPath.replace(`${repoRoot}/`, ""),
      screenshotBytes: screenshotStats.size,
      screenshotWidth: dimensions.width,
      screenshotHeight: dimensions.height,
      screenProfile: smallScreenMode ? "small-iphone" : appStoreScreenshotMode ? "app-store-6.9-inch" : "current-simulator",
      appStoreScreenshotLocaleSelection,
      appStoreScreenshotLocales,
      smallScreenDimensionsValid,
      runtimeScreenshotRecoveredAfterSimulatorRestart,
      runtimeFatalMatches: runtime.fatalMatches,
      appStoreCompliance: {
        ready: appStoreCompliance.ready,
        deviceFamily: appStoreCompliance.deviceFamily,
        backgroundModes: appStoreCompliance.backgroundModes,
        urlSchemes: appStoreCompliance.urlSchemes,
        privacyManifestCount: appStoreCompliance.privacyManifestCount,
        collectedDataTypes: appStoreCompliance.collectedDataTypes,
        requiredReasonCategories: appStoreCompliance.requiredReasonCategories,
        checks: appStoreCompliance.checks,
      },
      appStoreScreenshots: appStoreScreenshotSummaries,
      artifactRoot: artifactRoot.replace(`${repoRoot}/`, ""),
    };
    console.log(JSON.stringify({ summary }, null, 2));
    if (
      runtime.fatalMatches.length > 0 ||
      !hermesChecksumsVerified ||
      screenshotStats.size < 100_000 ||
      dimensions.width < 350 ||
      dimensions.height < 700 ||
      !smallScreenDimensionsValid
    ) {
      throw new Error("Native iOS runtime verification failed.");
    }
    succeeded = true;
  } finally {
    if (succeeded && !keepTemporaryFiles) {
      rmSync(stageRoot, { force: true, recursive: true });
      rmSync(derivedDataRoot, { force: true, recursive: true });
      rmSync(openIapRoot, { force: true, recursive: true });
    } else if (!succeeded) {
      console.error(`Native smoke temporary files retained at ${stageRoot}.`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
