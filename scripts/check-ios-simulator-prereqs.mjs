#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const mobilePackage = JSON.parse(readFileSync("apps/mobile/package.json", "utf8"));
const appJson = JSON.parse(readFileSync("apps/mobile/app.json", "utf8"));

function commandExists(command, args = ["--version"]) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    ok: result.status === 0,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
  };
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    ok: result.status === 0,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
    status: result.status,
  };
}

function getBootedSimulator() {
  const result = run("xcrun", ["simctl", "list", "devices", "booted"]);
  const match = result.output.match(/^\s+(.+?) \(([0-9A-F-]+)\) \(Booted\)/m);
  return {
    available: result.ok,
    name: match?.[1] ?? null,
    udid: match?.[2] ?? null,
    output: result.output,
  };
}

function getExpoGoContainer() {
  const result = run("xcrun", ["simctl", "get_app_container", "booted", "host.exp.Exponent"]);
  return {
    installed: result.ok,
    path: result.ok ? result.output : null,
    diagnostic: result.ok ? "Expo Go is installed on the booted simulator." : "Expo Go is not installed on the booted simulator.",
  };
}

async function getBackendHealth() {
  try {
    const response = await fetch("http://127.0.0.1:3003/api/health", { method: "GET" });
    const payload = await response.json();
    return {
      ok: response.ok && payload.ok === true,
      status: response.status,
      service: payload.service ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      service: null,
      error: error instanceof Error ? error.message : "unknown",
    };
  }
}

const xcrun = commandExists("xcrun", ["--version"]);
const brew = commandExists("brew", ["--version"]);
const pod = commandExists("pod", ["--version"]);
const simulator = getBootedSimulator();
const expoGo = simulator.udid ? getExpoGoContainer() : { installed: false, path: null, diagnostic: "No booted simulator." };
const backend = await getBackendHealth();

const hasManagedScripts =
  mobilePackage.scripts?.ios === "expo start --ios" &&
  mobilePackage.scripts?.android === "expo start --android";
const hasNativeIosDirectory = existsSync("apps/mobile/ios");
const hasMicrophonePermission = Boolean(appJson.expo?.ios?.infoPlist?.NSMicrophoneUsageDescription);
const canUseExpoGoPreview = xcrun.ok && simulator.udid && expoGo.installed && backend.ok && hasManagedScripts && !hasNativeIosDirectory;
const canUseNativeRunIos = xcrun.ok && simulator.udid && pod.ok;

const summary = {
  xcrunAvailable: xcrun.ok,
  brewAvailable: brew.ok,
  cocoaPodsAvailable: pod.ok,
  bootedSimulator: simulator.name,
  bootedSimulatorUdid: simulator.udid,
  expoGoInstalled: expoGo.installed,
  backendPreviewOk: backend.ok,
  backendPreviewStatus: backend.status,
  managedExpoScripts: hasManagedScripts,
  nativeIosDirectoryPresent: hasNativeIosDirectory,
  microphoneUsageDescription: hasMicrophonePermission,
  canUseExpoGoPreview: Boolean(canUseExpoGoPreview),
  canUseNativeRunIos: Boolean(canUseNativeRunIos),
  nextAction: canUseExpoGoPreview
    ? "Run npm run mobile:ios and capture simulator screenshots."
    : expoGo.installed
      ? "Start backend preview and run npm run mobile:ios."
      : pod.ok
        ? "Use npx expo run:ios if a native local build is intentionally desired."
        : "Install Expo Go on the booted simulator or install CocoaPods before native run:ios; keep managed Expo scripts unchanged.",
};

console.log(JSON.stringify(summary, null, 2));

const hardFailures = [
  ["xcrunAvailable", summary.xcrunAvailable],
  ["bootedSimulator", Boolean(summary.bootedSimulatorUdid)],
  ["managedExpoScripts", summary.managedExpoScripts],
  ["nativeIosDirectoryAbsent", !summary.nativeIosDirectoryPresent],
  ["microphoneUsageDescription", summary.microphoneUsageDescription],
];

const failed = hardFailures.filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length > 0) {
  console.error(`Hard prerequisite failure: ${failed.join(", ")}`);
  process.exitCode = 1;
}
