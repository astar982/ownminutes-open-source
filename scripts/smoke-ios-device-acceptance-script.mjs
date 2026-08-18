#!/usr/bin/env node

import { readFileSync } from "node:fs";
import {
  evaluateDeviceAcceptancePreflight,
  inspectDeviceApiUrl,
  safeDeviceSummary,
  selectPhysicalIosDevice,
  summarizePhysicalIosDevices,
} from "./lib/ios-device-acceptance.mjs";

const fixture = {
  result: {
    devices: [
      {
        identifier: "core-device-id",
        connectionProperties: { pairingState: "paired", tunnelState: "connected" },
        deviceProperties: {
          ddiServicesAvailable: true,
          developerModeStatus: "enabled",
          name: "Acceptance iPhone",
          osVersionNumber: "26.5",
        },
        hardwareProperties: {
          deviceType: "iPhone",
          marketingName: "iPhone 16 Pro",
          platform: "iOS",
          productType: "iPhone17,1",
          reality: "physical",
          serialNumber: "must-not-leak",
          udid: "hardware-udid",
        },
      },
    ],
  },
};
const devices = summarizePhysicalIosDevices(fixture);
const selected = selectPhysicalIosDevice(devices);
const validApi = inspectDeviceApiUrl("https://device-test.ownminutes.app/");
const ready = evaluateDeviceAcceptancePreflight({
  apiUrl: validApi,
  device: selected,
  developmentIdentityReady: true,
  gitClean: true,
  managedSourceTree: true,
  serverReachable: true,
  teamId: "TEAMID1234",
});
const unavailable = evaluateDeviceAcceptancePreflight({
  apiUrl: validApi,
  device: { ...selected, available: false, developerMode: false },
  developmentIdentityReady: true,
  gitClean: true,
  managedSourceTree: true,
  serverReachable: true,
  teamId: "TEAMID1234",
});
const safe = safeDeviceSummary(selected);
const source = readFileSync("scripts/build-ios-device-acceptance.mjs", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const workflow = readFileSync(".github/workflows/ci.yml", "utf8");

const checks = {
  parsesSafePhysicalDeviceState:
    devices.length === 1 &&
    selected?.available === true &&
    selected?.developerMode === true &&
    !JSON.stringify(safe).includes("must-not-leak") &&
    !("hardwareUdid" in safe) &&
    !("identifier" in safe),
  selectsExplicitDevice:
    selectPhysicalIosDevice(devices, "core-device-id") === selected &&
    selectPhysicalIosDevice(devices, "hardware-udid") === selected,
  requiresReachableHttpsOrigin:
    validApi.valid === true &&
    inspectDeviceApiUrl("http://192.168.1.20:3003").reason === "https-required" &&
    inspectDeviceApiUrl("https://127.0.0.1:3003").reason === "device-unreachable-host" &&
    inspectDeviceApiUrl("https://192.168.1.20:3003").reason === "device-unreachable-host" &&
    inspectDeviceApiUrl("https://10.0.0.20").reason === "device-unreachable-host" &&
    inspectDeviceApiUrl("https://[::1]").reason === "device-unreachable-host" &&
    inspectDeviceApiUrl("https://iphone.local").reason === "device-unreachable-host" &&
    inspectDeviceApiUrl("https://example.com/path").reason === "origin-required",
  detectsReadyAndUnavailableDevices:
    ready.ready === true &&
    unavailable.ready === false &&
    unavailable.failed.includes("deviceAvailable") &&
    unavailable.failed.includes("developerMode"),
  buildsSignsInstallsAndLaunches:
    source.includes('"-allowProvisioningDeviceRegistration"') &&
    source.includes('"devicectl", "device", "install", "app"') &&
    source.includes('"devicectl", "device", "process", "launch"') &&
    source.includes("selectedDeviceProvisioned") &&
    source.includes("DEVICE-ACCEPTANCE-DO-NOT-UPLOAD"),
  supportsExplicitCredentialFreeReachabilityProxy:
    source.includes("OWNMINUTES_DEVICE_PREFLIGHT_PROXY") &&
    source.includes('args.push("--proxy", proxy)') &&
    source.includes('reachabilityRoute: reachabilityProxy ? "explicit-proxy" : "direct"') &&
    source.includes("must not contain credentials"),
  keepsEvidencePrivate:
    source.includes('mode: 0o600') &&
    source.includes("chmodSync(artifactPath, 0o600)") &&
    source.includes("safeDeviceSummary(selectedDevice)") &&
    !source.includes("serialNumber"),
  exposesCommandsAndCiGate:
    [
      "mobile:ios:device:preflight",
      "mobile:ios:device:build",
      "mobile:ios:device:install",
      "smoke:ios-device-acceptance-script",
    ].every((name) => Boolean(packageJson.scripts[name])) &&
    workflow.includes("npm run smoke:ios-device-acceptance-script"),
};

console.log(JSON.stringify(checks, null, 2));
if (Object.values(checks).some((value) => value !== true)) process.exitCode = 1;
