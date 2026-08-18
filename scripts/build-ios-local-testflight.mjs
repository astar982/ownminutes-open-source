#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { inspectIosAppBundle } from "./lib/ios-appstore-compliance.mjs";

const repoRoot = process.cwd();
const mobileRoot = join(repoRoot, "apps", "mobile");
const appConfig = JSON.parse(readFileSync(join(mobileRoot, "app.json"), "utf8"));
const appName = appConfig.expo.name;
const bundleId = appConfig.expo.ios.bundleIdentifier;
const version = appConfig.expo.version;
const signingProbe = process.argv.includes("--signing-probe");
const preflightOnly = process.argv.includes("--preflight");
const internalTestFlightOnly = process.argv.includes("--testflight-internal-only");
const keepStage = process.env.OWNMINUTES_KEEP_LOCAL_TESTFLIGHT_STAGE === "1";
const stageRoot = resolve(
  process.env.OWNMINUTES_NATIVE_SMOKE_STAGE || join(tmpdir(), "ownminutes-ios-native-smoke"),
);
const nativeDerivedRoot = resolve(
  process.env.OWNMINUTES_NATIVE_SMOKE_DERIVED_DATA || `${stageRoot}-derived`,
);
const openIapRoot = resolve(`${stageRoot}-openiap`);
const artifactRoot = resolve(
  process.env.OWNMINUTES_LOCAL_TESTFLIGHT_ARTIFACT_ROOT || join(repoRoot, ".data", "testflight-local"),
);
const archivePath = join(artifactRoot, signingProbe ? "OwnMinutes-signing-probe.xcarchive" : "OwnMinutes.xcarchive");
const archiveDerivedPath = join(artifactRoot, "archive-derived");
const exportPath = join(artifactRoot, signingProbe ? "signing-probe-export" : "candidate-export");
const exportOptionsPath = join(artifactRoot, "ExportOptions.plist");
const uploadOptionsPath = join(artifactRoot, "UploadOptions.plist");
const apiBaseUrl = normalize(process.env.EXPO_PUBLIC_API_BASE_URL || process.env.OWNMINUTES_MOBILE_API_BASE_URL || "");
const mobileBuildEnvironment = {
  ...process.env,
  EXPO_PUBLIC_API_BASE_URL: apiBaseUrl,
  EXPO_PUBLIC_API_BASE_URL_MARKER: `ownminutes-api-default:${apiBaseUrl}`,
};
const buildNumber = process.env.OWNMINUTES_IOS_BUILD_NUMBER?.trim() || (signingProbe ? "1" : "");
const teamId = process.env.OWNMINUTES_IOS_TEAM_ID?.trim() || detectXcodeTeam();
const gitCommit = git(["rev-parse", "HEAD"]);
const gitClean = git(["status", "--porcelain"]) === "";
const reuseNativeStage = signingProbe && process.env.OWNMINUTES_REUSE_NATIVE_STAGE === "1";

const preflight = collectPreflight();
console.log(JSON.stringify({ preflight }, null, 2));
assertPreflight(preflight);
if (preflightOnly) process.exit(0);

let succeeded = false;
try {
  mkdirSync(artifactRoot, { recursive: true });
  if (!reuseNativeStage || !existsSync(join(stageRoot, "ios", `${appName}.xcworkspace`))) {
    runRequired(
      "node",
      ["scripts/smoke-ios-native-build.mjs"],
      {
        ...mobileBuildEnvironment,
        OWNMINUTES_KEEP_NATIVE_SMOKE: "1",
      },
      join(artifactRoot, "native-release-smoke.log"),
    );
  }

  rmSync(archivePath, { force: true, recursive: true });
  rmSync(archiveDerivedPath, { force: true, recursive: true });
  rmSync(exportPath, { force: true, recursive: true });
  writeFileSync(exportOptionsPath, exportOptions(teamId));

  runRequired(
    "xcodebuild",
    [
      "-workspace",
      join(stageRoot, "ios", `${appName}.xcworkspace`),
      "-scheme",
      appName,
      "-configuration",
      "Release",
      "-destination",
      "generic/platform=iOS",
      "-archivePath",
      archivePath,
      "-derivedDataPath",
      archiveDerivedPath,
      `CURRENT_PROJECT_VERSION=${buildNumber}`,
      `MARKETING_VERSION=${version}`,
      "CODE_SIGNING_ALLOWED=NO",
      "CODE_SIGNING_REQUIRED=NO",
      "archive",
    ],
    mobileBuildEnvironment,
    join(artifactRoot, "archive.log"),
  );

  runRequired(
    "xcodebuild",
    [
      "-exportArchive",
      "-archivePath",
      archivePath,
      "-exportPath",
      exportPath,
      "-exportOptionsPlist",
      exportOptionsPath,
      "-allowProvisioningUpdates",
    ],
    process.env,
    join(artifactRoot, "export.log"),
  );

  const exportedIpa = join(exportPath, `${appName}.ipa`);
  if (!existsSync(exportedIpa)) throw new Error(`Exported IPA is missing: ${exportedIpa}`);
  const artifactName = signingProbe
    ? `${appName}-${version}-${buildNumber}-SIGNING-PROBE-DO-NOT-UPLOAD.ipa`
    : `${appName}-${version}-${buildNumber}.ipa`;
  const finalIpa = join(artifactRoot, artifactName);
  rmSync(finalIpa, { force: true });
  renameSync(exportedIpa, finalIpa);
  chmodSync(finalIpa, 0o600);
  const organizerArchive = prepareOrganizerArchive(finalIpa);
  const verification = verifyIpa(finalIpa);
  if (internalTestFlightOnly) {
    writeFileSync(uploadOptionsPath, internalUploadOptions(teamId), { mode: 0o600 });
    chmodSync(uploadOptionsPath, 0o600);
    verification.checks.internalOnlyUploadOptions = verifyInternalUploadOptions(uploadOptionsPath);
    if (!verification.checks.internalOnlyUploadOptions) {
      throw new Error("Internal TestFlight upload options verification failed.");
    }
  } else {
    rmSync(uploadOptionsPath, { force: true });
  }
  const summary = {
    ok: true,
    mode: candidateMode(),
    artifact: finalIpa.replace(`${repoRoot}/`, ""),
    bytes: statSync(finalIpa).size,
    sha256: sha256(finalIpa),
    appName,
    bundleId,
    version,
    buildNumber,
    teamId,
    gitCommit,
    apiHost: new URL(apiBaseUrl).hostname,
    distributionScope: internalTestFlightOnly ? "internal-testflight-only" : "app-store-connect",
    testFlightInternalTestingOnly: internalTestFlightOnly,
    productionDeploymentVerified: preflight.liveDeployment.productionDeploymentVerified === true,
    internalTestFlightDeploymentVerified:
      preflight.liveDeployment.internalTestFlightDeploymentVerified === true,
    uploadOptions: internalTestFlightOnly
      ? uploadOptionsPath.replace(`${repoRoot}/`, "")
      : null,
    ...organizerArchive,
    ...verification,
  };
  writeFileSync(join(artifactRoot, "latest-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(join(artifactRoot, "latest-summary.json"), 0o600);
  console.log(JSON.stringify({ summary }, null, 2));
  succeeded = true;
} finally {
  if (succeeded && !keepStage) {
    rmSync(stageRoot, { force: true, recursive: true });
    rmSync(nativeDerivedRoot, { force: true, recursive: true });
    rmSync(openIapRoot, { force: true, recursive: true });
    rmSync(archiveDerivedPath, { force: true, recursive: true });
  } else if (!succeeded) {
    console.error(`Local TestFlight temporary files retained at ${stageRoot} and ${artifactRoot}.`);
  }
}

function prepareOrganizerArchive(ipaPath) {
  const organizerRoot = join(tmpdir(), "ownminutes-local-testflight-organizer");
  rmSync(organizerRoot, { force: true, recursive: true });
  mkdirSync(organizerRoot, { recursive: true });
  runRequired("ditto", ["-x", "-k", ipaPath, organizerRoot], process.env);

  const payloadRoot = join(organizerRoot, "Payload");
  const appDirectory = readdirSync(payloadRoot).find((entry) => entry.endsWith(".app"));
  if (!appDirectory) throw new Error("IPA Payload does not contain an app bundle for Organizer.");

  const signedAppPath = join(payloadRoot, appDirectory);
  const archiveAppPath = join(archivePath, "Products", "Applications", appDirectory);
  rmSync(archiveAppPath, { force: true, recursive: true });
  runRequired("ditto", ["--noextattr", "--noqtn", signedAppPath, archiveAppPath], process.env);
  runRequired("xattr", ["-cr", archiveAppPath], process.env);
  runRequired("codesign", ["--verify", "--deep", "--strict", "--verbose=2", archiveAppPath], process.env);

  const signature = capture("codesign", ["-dv", "--verbose=4", archiveAppPath]);
  const signingIdentity = signature.output.match(/^Authority=(.+)$/m)?.[1]?.trim() || "";
  if (!signature.ok || !signingIdentity.includes("Apple Distribution")) {
    throw new Error(`Could not identify the Organizer archive distribution identity: ${tail(signature.output, 20)}`);
  }

  const archiveInfoPath = join(archivePath, "Info.plist");
  runRequired(
    "plutil",
    ["-replace", "ApplicationProperties.SigningIdentity", "-string", signingIdentity, archiveInfoPath],
    process.env,
  );
  runRequired(
    "plutil",
    ["-replace", "ApplicationProperties.Team", "-string", teamId, archiveInfoPath],
    process.env,
  );
  const archiveSigningIdentity = plistRaw(archiveInfoPath, "ApplicationProperties.SigningIdentity");
  const archiveTeam = plistRaw(archiveInfoPath, "ApplicationProperties.Team");
  if (archiveSigningIdentity !== signingIdentity || archiveTeam !== teamId) {
    throw new Error("Organizer archive signing metadata verification failed.");
  }

  rmSync(organizerRoot, { force: true, recursive: true });
  return {
    organizerArchiveReady: true,
    organizerSigningIdentity: signingIdentity,
  };
}

function collectPreflight() {
  const xcode = capture("xcodebuild", ["-version"]);
  const distributionIdentities = capture("security", ["find-identity", "-v", "-p", "codesigning"]);
  const urlPreflight = signingProbe ? { ok: true, mode: "signing-probe" } : runUrlPreflight();
  const liveDeployment = signingProbe ? { ok: true, mode: "signing-probe" } : runLiveDeploymentVerification();
  return {
    mode: candidateMode(),
    macos: process.platform === "darwin",
    xcodeAvailable: xcode.ok,
    xcodeVersion: xcode.output.split("\n")[0] || null,
    teamId: teamId || null,
    hasDistributionIdentity:
      Boolean(teamId) && distributionIdentities.ok && distributionIdentities.output.includes("Apple Distribution") && distributionIdentities.output.includes(teamId),
    appName,
    bundleId,
    version,
    buildNumber: buildNumber || null,
    buildNumberValid: /^[1-9]\d*$/.test(buildNumber),
    apiBaseUrl: apiBaseUrl ? { configured: true, host: safeHost(apiBaseUrl), publicHttps: isPublicHttps(apiBaseUrl) } : { configured: false, host: null, publicHttps: false },
    gitCommit,
    gitClean,
    managedSourceTree: !existsSync(join(mobileRoot, "ios")),
    urlPreflight,
    liveDeployment,
    archiveWillBeUploadable: !signingProbe,
    distributionScope: internalTestFlightOnly ? "internal-testflight-only" : "app-store-connect",
    testFlightInternalTestingOnly: internalTestFlightOnly,
  };
}

function assertPreflight(value) {
  const checks = {
    macos: value.macos,
    xcodeAvailable: value.xcodeAvailable,
    teamId: /^[A-Z0-9]{10}$/.test(value.teamId || ""),
    distributionIdentity: value.hasDistributionIdentity,
    bundleId: /^[a-zA-Z0-9.-]+$/.test(value.bundleId || ""),
    version: Boolean(value.version),
    buildNumber: value.buildNumberValid,
    apiBaseUrl: signingProbe ? value.apiBaseUrl.configured : value.apiBaseUrl.publicHttps,
    managedSourceTree: value.managedSourceTree,
    cleanGitCandidate: signingProbe || value.gitClean,
    urlPreflight: value.urlPreflight.ok,
    liveDeployment: value.liveDeployment.ok,
    internalDeploymentBoundary:
      signingProbe ||
      !internalTestFlightOnly ||
      value.liveDeployment.internalTestFlightDeploymentVerified === true,
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length > 0) {
    throw new Error(`Local TestFlight preflight failed: ${failed.join(", ")}`);
  }
}

function runUrlPreflight() {
  const result = capture("node", ["scripts/check-mobile-testflight-env.mjs"], process.env);
  return { ok: result.ok, mode: "candidate", detail: result.ok ? "Public URL preflight passed." : tail(result.output, 12) };
}

function runLiveDeploymentVerification() {
  const args = [
    "scripts/verify-public-deployment-live.mjs",
    ...(internalTestFlightOnly ? ["--testflight-internal-only"] : []),
  ];
  const result = capture("node", args, process.env);
  const payload = parseJson(result.output);
  return {
    ok: result.ok,
    mode: internalTestFlightOnly ? "internal-testflight-only" : "candidate",
    productionDeploymentVerified: payload?.productionDeploymentVerified === true,
    internalTestFlightDeploymentVerified:
      payload?.internalTestFlightDeploymentVerified === true,
    detail: result.ok
      ? internalTestFlightOnly
        ? "Internal-only live deployment verification passed; production verification remains separate."
        : "Live deployment verification passed."
      : tail(result.output, 12),
  };
}

function candidateMode() {
  if (signingProbe) return "signing-probe-do-not-upload";
  return internalTestFlightOnly
    ? "testflight-internal-only-candidate"
    : "testflight-candidate";
}

function detectXcodeTeam() {
  const result = capture("defaults", ["read", "com.apple.dt.Xcode", "IDEProvisioningTeamByIdentifier"]);
  if (!result.ok) return "";
  const teamIds = [...result.output.matchAll(/teamID\s*=\s*([A-Z0-9]{10})/g)].map((match) => match[1]);
  return [...new Set(teamIds)].length === 1 ? teamIds[0] : "";
}

function verifyIpa(ipaPath) {
  const verifyRoot = join(tmpdir(), "ownminutes-local-testflight-verify");
  rmSync(verifyRoot, { force: true, recursive: true });
  mkdirSync(verifyRoot, { recursive: true });
  runRequired("ditto", ["-x", "-k", ipaPath, verifyRoot], process.env);
  const payloadRoot = join(verifyRoot, "Payload");
  const appDirectory = readdirSync(payloadRoot).find((entry) => entry.endsWith(".app"));
  if (!appDirectory) throw new Error("IPA Payload does not contain an app bundle.");
  const appPath = join(payloadRoot, appDirectory);
  runRequired("xattr", ["-cr", appPath], process.env);
  runRequired("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], process.env);

  const info = plistJson(join(appPath, "Info.plist"));
  const compliance = inspectIosAppBundle(appPath, { expectedBundleId: bundleId });
  if (!compliance.ready) throw new Error(`Exported IPA compliance verification failed: ${compliance.errors.join(", ")}`);
  const profilePlist = join(verifyRoot, "profile.plist");
  const profile = capture("security", ["cms", "-D", "-i", join(appPath, "embedded.mobileprovision")]);
  if (!profile.ok) throw new Error(`Could not decode embedded provisioning profile: ${profile.output}`);
  writeFileSync(profilePlist, profile.output);
  const profileName = plistRaw(profilePlist, "Name");
  const profileExpiration = plistRaw(profilePlist, "ExpirationDate");
  const applicationIdentifier = plistRaw(profilePlist, "Entitlements.application-identifier");
  const betaReportsActive = plistRaw(profilePlist, "Entitlements.beta-reports-active") === "true";
  const getTaskAllow = plistRaw(profilePlist, "Entitlements.get-task-allow") === "true";
  const jsBundlePath = join(appPath, "main.jsbundle");
  const jsBundle = readFileSync(jsBundlePath, "utf8");
  const expectedApplicationId = `${teamId}.${bundleId}`;
  const checks = {
    bundleId: info.CFBundleIdentifier === bundleId,
    version: info.CFBundleShortVersionString === version,
    buildNumber: String(info.CFBundleVersion) === buildNumber,
    applicationIdentifier: applicationIdentifier === expectedApplicationId,
    betaReportsActive,
    distributionBuild: !getTaskAllow,
    apiUrlEmbedded: jsBundle.includes(apiBaseUrl),
    apiDefaultMarker: jsBundle.includes(`ownminutes-api-default:${apiBaseUrl}`),
    noLocalDefaultMarker: !jsBundle.includes("ownminutes-api-default:http://"),
    appStoreCompliance: compliance.ready,
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length > 0) throw new Error(`Exported IPA verification failed: ${failed.join(", ")}`);
  const result = {
    signatureVerified: true,
    appStoreProfile: true,
    profileName,
    profileExpiration,
    minimumOsVersion: info.MinimumOSVersion || null,
    compliance: {
      deviceFamily: compliance.deviceFamily,
      backgroundModes: compliance.backgroundModes,
      privacyManifestCount: compliance.privacyManifestCount,
      collectedDataTypes: compliance.collectedDataTypes,
      requiredReasonCategories: compliance.requiredReasonCategories,
      checks: compliance.checks,
    },
    checks,
  };
  rmSync(verifyRoot, { force: true, recursive: true });
  return result;
}

function exportOptions(selectedTeamId) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>destination</key><string>export</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>method</key><string>app-store-connect</string>
  <key>signingStyle</key><string>automatic</string>
  <key>stripSwiftSymbols</key><true/>
  <key>teamID</key><string>${selectedTeamId}</string>
  <key>uploadSymbols</key><true/>
</dict>
</plist>
`;
}

function internalUploadOptions(selectedTeamId) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>destination</key><string>upload</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>method</key><string>app-store-connect</string>
  <key>signingStyle</key><string>automatic</string>
  <key>stripSwiftSymbols</key><true/>
  <key>teamID</key><string>${selectedTeamId}</string>
  <key>testFlightInternalTestingOnly</key><true/>
  <key>uploadSymbols</key><true/>
</dict>
</plist>
`;
}

function verifyInternalUploadOptions(path) {
  return (
    plistRaw(path, "destination") === "upload" &&
    plistRaw(path, "manageAppVersionAndBuildNumber") === "false" &&
    plistRaw(path, "method") === "app-store-connect" &&
    plistRaw(path, "testFlightInternalTestingOnly") === "true"
  );
}

function plistJson(path) {
  const result = capture("plutil", ["-convert", "json", "-o", "-", path]);
  if (!result.ok) throw new Error(`Could not parse plist ${basename(path)}: ${result.output}`);
  return JSON.parse(result.output);
}

function plistRaw(path, key) {
  const result = capture("plutil", ["-extract", key, "raw", "-o", "-", path]);
  if (!result.ok) throw new Error(`Could not read ${key} from ${basename(path)}: ${result.output}`);
  return result.output;
}

function runRequired(command, args, env = process.env, logPath = "") {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (logPath) writeFileSync(logPath, output);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed:\n${tail(output, 120)}`);
  return output.trim();
}

function capture(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
  };
}

function parseJson(value) {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(value.slice(start, end + 1));
  } catch {
    return null;
  }
}

function git(args) {
  const result = capture("git", args);
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.output}`);
  return result.output;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function normalize(value) {
  return value.trim().replace(/\/$/, "");
}

function safeHost(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

function isPublicHttps(value) {
  try {
    const url = new URL(value);
    const host = url.hostname;
    return (
      url.protocol === "https:" &&
      !["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(host) &&
      !/^10\./.test(host) &&
      !/^192\.168\./.test(host) &&
      !/^172\.(1[6-9]|2\d|3[01])\./.test(host)
    );
  } catch {
    return false;
  }
}

function tail(value, lines) {
  return value.split("\n").slice(-lines).join("\n");
}
