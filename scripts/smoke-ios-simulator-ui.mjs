#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const metroUrl = process.env.OWNMINUTES_EXPO_URL || "exp://127.0.0.1:8081";
const metroHttpUrl = process.env.OWNMINUTES_EXPO_HTTP_URL || "http://127.0.0.1:8081";
const screenshotPath = resolve(".data/screenshots/ownminutes-ios-simulator-latest.png");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });

  return {
    ok: result.status === 0,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
    status: result.status,
  };
}

function runRequired(command, args) {
  const result = run(command, args);
  if (!result.ok) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.output}`);
  }
  return result.output;
}

function parseJsonFromCommand(command, args) {
  const output = execFileSync(command, args, { encoding: "utf8" });
  return JSON.parse(output);
}

async function fetchText(url) {
  const response = await fetch(url);
  return {
    ok: response.ok,
    status: response.status,
    text: await response.text(),
  };
}

function readPngDimensions(path) {
  const buffer = readFileSync(path);
  const pngSignature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== pngSignature) {
    throw new Error("Screenshot is not a PNG file.");
  }

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

async function main() {
  const prereqs = parseJsonFromCommand("node", ["scripts/check-ios-simulator-prereqs.mjs"]);
  const metroStatus = await fetchText(`${metroHttpUrl}/status`);
  const metroHome = await fetchText(metroHttpUrl);
  const metroRunning = metroStatus.ok && metroStatus.text.includes("packager-status:running");
  const metroServesOwnMinutes = metroHome.ok && metroHome.text.includes("OwnMinutes");

  if (!prereqs.canUseExpoGoPreview) {
    throw new Error(`Expo Go preview prerequisites are not ready: ${JSON.stringify(prereqs, null, 2)}`);
  }
  if (!metroRunning) {
    throw new Error(`Metro is not running at ${metroHttpUrl}: ${metroStatus.status} ${metroStatus.text.slice(0, 200)}`);
  }
  if (!metroServesOwnMinutes) {
    throw new Error(`Metro is not serving OwnMinutes at ${metroHttpUrl}.`);
  }

  mkdirSync(dirname(screenshotPath), { recursive: true });
  run("xcrun", ["simctl", "terminate", "booted", "host.exp.Exponent"]);
  runRequired("xcrun", ["simctl", "openurl", "booted", metroUrl]);
  let stats;
  let dimensions;
  let screenshotUsable = false;
  let screenshotAttempts = 0;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    screenshotAttempts = attempt;
    await new Promise((resolveWait) => setTimeout(resolveWait, attempt === 1 ? 5000 : 3000));
    runRequired("xcrun", ["simctl", "io", "booted", "screenshot", screenshotPath]);
    stats = statSync(screenshotPath);
    dimensions = readPngDimensions(screenshotPath);
    screenshotUsable = stats.size > 500_000 && dimensions.width >= 350 && dimensions.height >= 700;
    if (screenshotUsable) break;
  }

  if (!stats || !dimensions) throw new Error("Simulator screenshot was not captured.");
  const summary = {
    prereqOk: prereqs.canUseExpoGoPreview === true,
    bootedSimulator: prereqs.bootedSimulator,
    bootedSimulatorUdid: prereqs.bootedSimulatorUdid,
    expoGoInstalled: prereqs.expoGoInstalled,
    backendPreviewOk: prereqs.backendPreviewOk,
    metroRunning,
    metroServesOwnMinutes,
    openedExpoUrl: metroUrl,
    screenshotPath: relative(process.cwd(), screenshotPath),
    screenshotExists: existsSync(screenshotPath),
    screenshotBytes: stats.size,
    screenshotWidth: dimensions.width,
    screenshotHeight: dimensions.height,
    screenshotAttempts,
    screenshotUsable,
    caveat: "This smoke proves simulator launch and screenshot capture. Visual quality still needs human review; Expo Go development overlays can appear.",
  };

  console.log(JSON.stringify(summary, null, 2));

  if (!summary.screenshotUsable) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
