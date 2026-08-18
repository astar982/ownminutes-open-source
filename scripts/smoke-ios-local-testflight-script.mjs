#!/usr/bin/env node

import { readFileSync } from "node:fs";

const source = readFileSync("scripts/build-ios-local-testflight.mjs", "utf8");
const nativeBuildSource = readFileSync("scripts/smoke-ios-native-build.mjs", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const runbook = readFileSync("docs/ios-testflight-acceptance-runbook.md", "utf8");

const checks = {
  exposesCommands: [
    "mobile:ios:local:preflight",
    "mobile:ios:local:internal-preflight",
    "mobile:ios:local:signing-probe",
    "mobile:ios:local:build",
    "mobile:ios:local:internal-build",
    "mobile:ios:local:upload-preflight",
    "mobile:ios:local:validate",
    "mobile:ios:local:upload",
    "mobile:ios:local:upload-evidence",
    "smoke:ios-local-testflight-script",
    "smoke:ios-appstore-upload",
  ].every((name) => Boolean(packageJson.scripts[name])),
  requiresPublicCandidateUrls:
    source.includes('check-mobile-testflight-env.mjs') &&
    source.includes('verify-public-deployment-live.mjs') &&
    source.includes("cleanGitCandidate"),
  separatesSigningProbe:
    source.includes("SIGNING-PROBE-DO-NOT-UPLOAD") &&
    source.includes("signing-probe-do-not-upload") &&
    source.includes("archiveWillBeUploadable: !signingProbe"),
  requiresUniqueBuildNumber:
    source.includes("OWNMINUTES_IOS_BUILD_NUMBER") &&
    source.includes("CURRENT_PROJECT_VERSION") &&
    source.includes("buildNumberValid") &&
    nativeBuildSource.includes("OWNMINUTES_IOS_BUILD_NUMBER") &&
    nativeBuildSource.includes("buildNumber: iosBuildNumber") &&
    nativeBuildSource.includes("Staged Expo ios.buildNumber"),
  usesAutomaticAppStoreExport:
    source.includes("app-store-connect") &&
    source.includes("-allowProvisioningUpdates") &&
    source.includes("Apple Distribution"),
  separatesInternalOnlyDistribution:
    source.includes("--testflight-internal-only") &&
    source.includes("testflight-internal-only-candidate") &&
    source.includes('distributionScope: internalTestFlightOnly ? "internal-testflight-only"') &&
    source.includes("internalTestFlightDeploymentVerified") &&
    source.includes("productionDeploymentVerified"),
  generatesInternalOnlyUploadOptions:
    source.includes('const uploadOptionsPath = join(artifactRoot, "UploadOptions.plist")') &&
    source.includes('<key>destination</key><string>upload</string>') &&
    source.includes('<key>manageAppVersionAndBuildNumber</key><false/>') &&
    source.includes('<key>testFlightInternalTestingOnly</key><true/>') &&
    source.includes("verifyInternalUploadOptions"),
  verifiesExportedIpa:
    source.includes("codesign") &&
    source.includes("EXPO_PUBLIC_API_BASE_URL_MARKER") &&
    source.includes("beta-reports-active") &&
    source.includes("get-task-allow") &&
    source.includes("apiUrlEmbedded") &&
    source.includes("apiDefaultMarker") &&
    source.includes("noLocalDefaultMarker"),
  preparesSignedOrganizerArchive:
    source.includes("prepareOrganizerArchive(finalIpa)") &&
    source.includes("ApplicationProperties.SigningIdentity") &&
    source.includes("ApplicationProperties.Team") &&
    source.includes("organizerArchiveReady: true") &&
    source.includes('runRequired("codesign", ["--verify", "--deep", "--strict"'),
  keepsCandidateArtifactsPrivate:
    source.includes("chmodSync(finalIpa, 0o600)") &&
    source.includes('chmodSync(join(artifactRoot, "latest-summary.json"), 0o600)'),
  avoidsCredentialLogging:
    !source.includes("APPLE_PRIVATE_KEY") &&
    !source.includes("ASC_KEY") &&
    !source.includes("password"),
  runbookDocumentsLocalPath:
    runbook.includes("mobile:ios:local:signing-probe") &&
    runbook.includes("mobile:ios:local:build") &&
    runbook.includes("DO NOT UPLOAD"),
};

console.log(JSON.stringify(checks, null, 2));
if (Object.values(checks).some((value) => !value)) process.exitCode = 1;
