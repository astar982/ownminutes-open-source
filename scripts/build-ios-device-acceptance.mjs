#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { inspectIosAppBundle } from "./lib/ios-appstore-compliance.mjs";
import {
  evaluateDeviceAcceptancePreflight,
  inspectDeviceApiUrl,
  safeDeviceSummary,
  selectPhysicalIosDevice,
  summarizePhysicalIosDevices,
} from "./lib/ios-device-acceptance.mjs";

const repoRoot = process.cwd();
const mobileRoot = join(repoRoot, "apps", "mobile");
const appConfig = JSON.parse(readFileSync(join(mobileRoot, "app.json"), "utf8"));
const appName = appConfig.expo.name;
const bundleId = appConfig.expo.ios.bundleIdentifier;
const version = appConfig.expo.version;
const preflightOnly = process.argv.includes("--preflight");
const installAfterBuild = process.argv.includes("--install");
const stageRoot = resolve(process.env.OWNMINUTES_NATIVE_SMOKE_STAGE || join(tmpdir(), "ownminutes-ios-native-smoke"));
const derivedRoot = resolve(
  process.env.OWNMINUTES_IOS_DEVICE_DERIVED_DATA || join(tmpdir(), "ownminutes-ios-device-acceptance-derived"),
);
const artifactRoot = resolve(
  process.env.OWNMINUTES_IOS_DEVICE_ARTIFACT_ROOT || join(repoRoot, ".data", "ios-device-acceptance"),
);
const apiUrl = inspectDeviceApiUrl(
  process.env.EXPO_PUBLIC_API_BASE_URL || process.env.OWNMINUTES_MOBILE_API_BASE_URL || "",
);
const reachabilityProxy = inspectReachabilityProxy(process.env.OWNMINUTES_DEVICE_PREFLIGHT_PROXY || "");
const teamId = process.env.OWNMINUTES_IOS_TEAM_ID?.trim() || detectXcodeTeam();
const requestedDevice = process.env.OWNMINUTES_IOS_DEVICE_ID || "";
const gitCommit = git(["rev-parse", "HEAD"]);
const gitClean = git(["status", "--porcelain"]) === "";
const buildNumber = process.env.OWNMINUTES_IOS_DEVICE_BUILD_NUMBER?.trim() || timestampBuildNumber();
const deviceList = readPhysicalDevices();
const selectedDevice = selectPhysicalIosDevice(deviceList, requestedDevice);
const identityOutput = capture("security", ["find-identity", "-v", "-p", "codesigning"]);
const developmentIdentityReady =
  Boolean(teamId) && identityOutput.ok && identityOutput.output.includes("Apple Development") && identityOutput.output.includes(teamId);
const serverReachable = apiUrl.valid ? checkServer(apiUrl.normalized, reachabilityProxy) : false;
const evaluated = evaluateDeviceAcceptancePreflight({
  apiUrl,
  device: selectedDevice,
  developmentIdentityReady,
  gitClean,
  managedSourceTree: !existsSync(join(mobileRoot, "ios")),
  serverReachable,
  teamId,
});
const preflight = {
  mode: installAfterBuild ? "physical-device-build-install" : "physical-device-build",
  xcode: capture("xcodebuild", ["-version"]).output.split("\n")[0] || null,
  teamId: teamId || null,
  developmentIdentityReady,
  appName,
  bundleId,
  version,
  buildNumber,
  api: {
    configured: apiUrl.configured,
    valid: apiUrl.valid,
    host: apiUrl.host,
    reason: apiUrl.reason,
    reachableFromMac: serverReachable,
    reachabilityRoute: reachabilityProxy ? "explicit-proxy" : "direct",
  },
  physicalDeviceCount: deviceList.length,
  device: safeDeviceSummary(selectedDevice),
  gitCommit,
  gitClean,
  managedSourceTree: !existsSync(join(mobileRoot, "ios")),
  checks: evaluated.checks,
  ready: evaluated.ready,
  nextActions: nextActions(evaluated.failed),
  boundary: "Development-signed device evidence only; this is not TestFlight or App Store upload evidence.",
};
console.log(JSON.stringify({ preflight }, null, 2));
if (!evaluated.ready) {
  throw new Error(`iPhone acceptance preflight failed: ${evaluated.failed.join(", ")}`);
}
if (preflightOnly) process.exit(0);

mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
const buildEnv = {
  ...process.env,
  EXPO_PUBLIC_API_BASE_URL: apiUrl.normalized,
  EXPO_PUBLIC_API_BASE_URL_MARKER: `ownminutes-api-default:${apiUrl.normalized}`,
  OWNMINUTES_KEEP_NATIVE_SMOKE: "1",
};
runRequired(
  "node",
  ["scripts/smoke-ios-native-build.mjs"],
  buildEnv,
  join(artifactRoot, "native-stage.log"),
);

rmSync(derivedRoot, { force: true, recursive: true });
runRequired(
  "xcodebuild",
  [
    "-workspace",
    join(stageRoot, "ios", `${appName}.xcworkspace`),
    "-scheme",
    appName,
    "-configuration",
    "Release",
    "-sdk",
    "iphoneos",
    "-destination",
    `id=${selectedDevice.hardwareUdid}`,
    "-derivedDataPath",
    derivedRoot,
    `CURRENT_PROJECT_VERSION=${buildNumber}`,
    `MARKETING_VERSION=${version}`,
    `DEVELOPMENT_TEAM=${teamId}`,
    "CODE_SIGN_STYLE=Automatic",
    `PRODUCT_BUNDLE_IDENTIFIER=${bundleId}`,
    "-allowProvisioningUpdates",
    "-allowProvisioningDeviceRegistration",
    "build",
  ],
  buildEnv,
  join(artifactRoot, "device-build.log"),
);

const appPath = join(derivedRoot, "Build", "Products", "Release-iphoneos", `${appName}.app`);
if (!existsSync(appPath)) throw new Error(`Signed iPhone app is missing: ${appPath}`);
const verification = verifyDevelopmentApp(appPath, selectedDevice, apiUrl.normalized);
const artifactPath = join(
  artifactRoot,
  `${appName}-${version}-${buildNumber}-DEVICE-ACCEPTANCE-DO-NOT-UPLOAD.zip`,
);
rmSync(artifactPath, { force: true });
runRequired("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, artifactPath]);
chmodSync(artifactPath, 0o600);

let installed = false;
let launched = false;
if (installAfterBuild) {
  runRequired(
    "xcrun",
    ["devicectl", "device", "install", "app", "--device", selectedDevice.identifier, appPath],
    process.env,
    join(artifactRoot, "device-install.log"),
  );
  installed = true;
  runRequired(
    "xcrun",
    ["devicectl", "device", "process", "launch", "--device", selectedDevice.identifier, bundleId],
    process.env,
    join(artifactRoot, "device-launch.log"),
  );
  launched = true;
}

const summary = {
  ok: true,
  mode: installAfterBuild ? "physical-device-build-install" : "physical-device-build",
  distribution: "Apple Development",
  artifact: artifactPath.replace(`${repoRoot}/`, ""),
  artifactBytes: statSync(artifactPath).size,
  artifactSha256: sha256(artifactPath),
  appName,
  bundleId,
  version,
  buildNumber,
  teamId,
  gitCommit,
  apiHost: apiUrl.host,
  device: safeDeviceSummary(selectedDevice),
  installed,
  launched,
  ...verification,
  boundary: "This proves a development-signed physical iPhone build. TestFlight still requires stable public HTTPS and App Store Connect processing.",
};
const summaryPath = join(artifactRoot, "latest-summary.json");
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
chmodSync(summaryPath, 0o600);
console.log(JSON.stringify({ summary }, null, 2));

function readPhysicalDevices() {
  const outputPath = join(tmpdir(), `ownminutes-ios-devices-${Date.now()}.json`);
  try {
    runRequired("xcrun", ["devicectl", "list", "devices", "--json-output", outputPath]);
    return summarizePhysicalIosDevices(JSON.parse(readFileSync(outputPath, "utf8")));
  } finally {
    rmSync(outputPath, { force: true });
  }
}

function checkServer(origin, proxy) {
  try {
    const args = ["--fail", "--silent", "--show-error", "--max-time", "8", "--header", "Accept: application/json"];
    if (proxy) args.push("--proxy", proxy);
    args.push(`${origin}/api/health`);
    const response = capture("curl", args);
    if (!response.ok) return false;
    const payload = JSON.parse(response.output);
    return payload?.ok === true;
  } catch {
    return false;
  }
}

function inspectReachabilityProxy(rawValue) {
  const value = rawValue.trim();
  if (!value) return "";
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("OWNMINUTES_DEVICE_PREFLIGHT_PROXY must be a valid proxy URL.");
  }
  if (!["http:", "https:", "socks5:", "socks5h:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error("OWNMINUTES_DEVICE_PREFLIGHT_PROXY must use HTTP(S) or SOCKS5.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("OWNMINUTES_DEVICE_PREFLIGHT_PROXY must not contain credentials.");
  }
  return parsed.toString();
}

function verifyDevelopmentApp(path, device, expectedApiUrl) {
  runRequired("xattr", ["-cr", path]);
  runRequired("codesign", ["--verify", "--deep", "--strict", "--verbose=2", path]);
  const info = plistJson(join(path, "Info.plist"));
  const compliance = inspectIosAppBundle(path, { expectedBundleId: bundleId });
  if (!compliance.ready) throw new Error(`Device app compliance failed: ${compliance.errors.join(", ")}`);
  const profilePath = join(artifactRoot, "development-profile.plist");
  const profile = capture("security", ["cms", "-D", "-i", join(path, "embedded.mobileprovision")]);
  if (!profile.ok) throw new Error("Could not decode the development provisioning profile.");
  writeFileSync(profilePath, profile.output, { mode: 0o600 });
  const applicationIdentifier = plistRaw(profilePath, "Entitlements.application-identifier");
  const getTaskAllow = plistRaw(profilePath, "Entitlements.get-task-allow") === "true";
  const provisionedDevices = plistJsonValue(profilePath, "ProvisionedDevices");
  rmSync(profilePath, { force: true });
  const jsBundle = readFileSync(join(path, "main.jsbundle"), "utf8");
  const checks = {
    bundleId: info.CFBundleIdentifier === bundleId,
    version: info.CFBundleShortVersionString === version,
    buildNumber: String(info.CFBundleVersion) === buildNumber,
    applicationIdentifier: applicationIdentifier === `${teamId}.${bundleId}`,
    developmentBuild: getTaskAllow,
    selectedDeviceProvisioned: Array.isArray(provisionedDevices) && provisionedDevices.includes(device.hardwareUdid),
    apiUrlEmbedded: jsBundle.includes(expectedApiUrl),
    apiDefaultMarker: jsBundle.includes(`ownminutes-api-default:${expectedApiUrl}`),
    noLoopbackDefault:
      !/ownminutes-api-default:https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)/.test(
        jsBundle,
      ),
    appStoreCompliance: compliance.ready,
  };
  const failed = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  if (failed.length > 0) throw new Error(`Development-signed app verification failed: ${failed.join(", ")}`);
  return {
    signatureVerified: true,
    developmentProfile: true,
    minimumOsVersion: info.MinimumOSVersion || null,
    compliance: {
      deviceFamily: compliance.deviceFamily,
      backgroundModes: compliance.backgroundModes,
      privacyManifestCount: compliance.privacyManifestCount,
      checks: compliance.checks,
    },
    checks,
  };
}

function nextActions(failed) {
  const actions = [];
  if (failed.includes("apiUrl")) actions.push("Set EXPO_PUBLIC_API_BASE_URL to a reachable HTTPS origin; loopback and plain HTTP are not accepted for physical-device evidence.");
  if (failed.includes("serverReachable")) actions.push("Verify /api/health from the Mac; when the current network requires a proxy, set OWNMINUTES_DEVICE_PREFLIGHT_PROXY to a credential-free proxy URL.");
  if (failed.includes("deviceDetected") || failed.includes("deviceAvailable")) actions.push("Connect and unlock the paired iPhone, keep it on the same trusted network or USB, and accept the computer trust prompt.");
  if (failed.includes("developerMode")) actions.push("Enable Developer Mode on the iPhone and complete its required restart/confirmation.");
  if (failed.includes("cleanGit")) actions.push("Commit or intentionally stash source changes before collecting device acceptance evidence.");
  if (failed.includes("developmentIdentity")) actions.push("Install a valid Apple Development identity for the configured team.");
  return actions;
}

function detectXcodeTeam() {
  const result = capture("defaults", ["read", "com.apple.dt.Xcode", "IDEProvisioningTeamByIdentifier"]);
  if (!result.ok) return "";
  const ids = [...result.output.matchAll(/teamID\s*=\s*([A-Z0-9]{10})/g)].map((match) => match[1]);
  return [...new Set(ids)].length === 1 ? ids[0] : "";
}

function timestampBuildNumber() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
}

function runRequired(command, args, env = process.env, logPath = "") {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (logPath) {
    writeFileSync(logPath, output, { mode: 0o600 });
    chmodSync(logPath, 0o600);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed:\n${redactDeviceIdentifiers(tail(output, 80))}`);
  }
  return output.trim();
}

function capture(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  return { ok: result.status === 0, output: `${result.stdout || ""}${result.stderr || ""}`.trim() };
}

function git(args) {
  const result = capture("git", args);
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.output}`);
  return result.output;
}

function plistJson(path) {
  const result = capture("plutil", ["-convert", "json", "-o", "-", path]);
  if (!result.ok) throw new Error(`Could not parse ${basename(path)}.`);
  return JSON.parse(result.output);
}

function plistJsonValue(path, key) {
  const result = capture("plutil", ["-extract", key, "json", "-o", "-", path]);
  if (!result.ok) return null;
  return JSON.parse(result.output);
}

function plistRaw(path, key) {
  const result = capture("plutil", ["-extract", key, "raw", "-o", "-", path]);
  if (!result.ok) throw new Error(`Could not read ${key} from ${basename(path)}.`);
  return result.output;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function tail(value, lines) {
  return value.split("\n").slice(-lines).join("\n");
}

function redactDeviceIdentifiers(value) {
  return value
    .replace(/\b0000[0-9A-F]{4}-[0-9A-F]{16}\b/gi, "[REDACTED_DEVICE_UDID]")
    .replace(
      /\b[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\b/gi,
      "[REDACTED_DEVICE_ID]",
    );
}
