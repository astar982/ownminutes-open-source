#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const rootDir = path.resolve(import.meta.dirname, "..");
const dataDir = path.join(rootDir, ".data", "staging");
const logDir = path.join(rootDir, ".data", "logs");
const statePath = path.join(dataDir, "https-staging.json");
const tunnelLogPath = path.join(logDir, "cloudflared-ownminutes.log");
const previewLogPath = path.join(logDir, "screen-preview-3003.log");
const tunnelSession = "ownminutes-https-staging";
const previewSession = "ownminutes-preview";
const localOrigin = "http://127.0.0.1:3003";
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: options.stdio ?? "pipe",
  });
  if (options.check && result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
  }
  return result;
}

function requireCommand(command) {
  if (run("which", [command]).status !== 0) throw new Error(`Required command is unavailable: ${command}`);
}

function screenRunning(name) {
  const result = run("screen", ["-ls"]);
  return `${result.stdout}\n${result.stderr}`.includes(`.${name}`);
}

function stopScreen(name) {
  run("screen", ["-S", name, "-X", "quit"]);
}

function readState() {
  if (!fs.existsSync(statePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

function stagingEnv(origin) {
  return {
    OWNMINUTES_APP_URL: origin,
    NEXT_PUBLIC_APP_URL: origin,
    EXPO_PUBLIC_API_BASE_URL: origin,
    OWNMINUTES_MOBILE_API_BASE_URL: origin,
    OWNMINUTES_PRIVACY_URL: `${origin}/privacy`,
    OWNMINUTES_TERMS_URL: `${origin}/terms`,
    OWNMINUTES_SUPPORT_URL: `${origin}/support`,
    OWNMINUTES_SUPPORT_EMAIL: "support@staging.ownminutes.app",
    OWNMINUTES_HEALTH_CHECK_URL: `${origin}/api/health`,
  };
}

function curl(url) {
  return run("curl", ["--fail", "--silent", "--show-error", "--max-time", "20", url], {
    env: { ...process.env, ...macProxyEnv() },
  });
}

function waitFor(check, label, timeoutMs = 45000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return;
    sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function isReachable(url, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (curl(url).status === 0) return true;
    if (attempt < attempts) sleep(750);
  }
  return false;
}

function startScreen(name, command) {
  run("screen", ["-dmS", name, "/bin/zsh", "-lc", command], { check: true });
}

function stopPreview() {
  run("node", ["scripts/stop-preview-screen.mjs"], { check: true, stdio: "inherit" });
}

function startPreview(origin) {
  const envPrefix = Object.entries(stagingEnv(origin))
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  const command = `cd ${shellQuote(rootDir)} && ${envPrefix} ./node_modules/.bin/next start --hostname 127.0.0.1 --port 3003 >> ${shellQuote(previewLogPath)} 2>&1`;
  fs.writeFileSync(previewLogPath, "");
  startScreen(previewSession, command);
  waitFor(() => curl(`${localOrigin}/api/health`).status === 0, "local preview");
}

function parseTunnelOrigin() {
  if (!fs.existsSync(tunnelLogPath)) return null;
  return fs.readFileSync(tunnelLogPath, "utf8").match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0] ?? null;
}

function isProductionReady(body) {
  return body?.diagnostics?.productionReady === true || body?.productionReady === true;
}

function readPublicJson(url, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = curl(url);
    if (response.status === 0) {
      try {
        return JSON.parse(response.stdout);
      } catch {}
    }
    if (attempt < attempts) sleep(750);
  }
  return null;
}

function commandUp() {
  for (const command of ["cloudflared", "screen", "curl", "lsof"]) requireCommand(command);
  if (!fs.existsSync(path.join(rootDir, ".next", "BUILD_ID"))) throw new Error("No production build found. Run `npm run build` first.");

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  stopScreen(tunnelSession);
  stopPreview();
  fs.writeFileSync(tunnelLogPath, "");
  startScreen(
    tunnelSession,
    `cd ${shellQuote(rootDir)} && cloudflared tunnel --url ${localOrigin} --no-autoupdate >> ${shellQuote(tunnelLogPath)} 2>&1`,
  );

  let origin = null;
  waitFor(() => {
    origin = parseTunnelOrigin();
    return Boolean(origin);
  }, "Cloudflare quick-tunnel URL");

  startPreview(origin);
  waitFor(() => curl(`${origin}/api/health`).status === 0, "public HTTPS health check", 60000);
  const diagnostics = readPublicJson(`${origin}/api/deployment/diagnostics`, 5);
  if (!isProductionReady(diagnostics)) throw new Error("Public deployment diagnostics did not report productionReady=true.");

  fs.writeFileSync(
    statePath,
    `${JSON.stringify({ origin, startedAt: new Date().toISOString(), tunnelSession, previewSession }, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(`OwnMinutes temporary HTTPS staging is running at ${origin}/`);
  console.log("Boundary: this account-less quick tunnel has no uptime guarantee and is not production hosting.");
}

function statusSummary() {
  const state = readState();
  const origin = state?.origin ?? parseTunnelOrigin();
  const localHealthy = isReachable(`${localOrigin}/api/health`);
  const publicHealthy = origin ? isReachable(`${origin}/api/health`) : false;
  let productionReady = false;
  if (publicHealthy) {
    productionReady = isProductionReady(readPublicJson(`${origin}/api/deployment/diagnostics`));
  }
  return {
    origin,
    startedAt: state?.startedAt ?? null,
    tunnelScreen: screenRunning(tunnelSession),
    previewScreen: screenRunning(previewSession),
    localHealthy,
    publicHealthy,
    productionReady,
    temporaryOnly: true,
  };
}

function commandStatus() {
  const summary = statusSummary();
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.origin || !summary.tunnelScreen || !summary.previewScreen || !summary.localHealthy || !summary.publicHealthy || !summary.productionReady) process.exitCode = 1;
}

function macProxyEnv() {
  if (process.platform !== "darwin") return {};
  const text = run("scutil", ["--proxy"]).stdout;
  const host = text.match(/HTTPProxy\s*:\s*(\S+)/)?.[1];
  const port = text.match(/HTTPPort\s*:\s*(\d+)/)?.[1];
  if (!/HTTPEnable\s*:\s*1/.test(text) || !host || !port) return {};
  const proxyUrl = `http://${host}:${port}`;
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    NO_PROXY: "127.0.0.1,localhost",
    NODE_OPTIONS: [process.env.NODE_OPTIONS, "--use-env-proxy"].filter(Boolean).join(" "),
  };
}

function commandVerify() {
  const state = readState();
  if (!state?.origin) throw new Error("No HTTPS staging state found. Run `npm run staging:https:up` first.");
  const env = { ...process.env, ...stagingEnv(state.origin), ...macProxyEnv() };
  for (const script of ["deployment:preflight", "deployment:verify", "mobile:testflight:preflight"]) {
    console.log(`\n> npm run ${script}`);
    run("npm", ["run", script], { check: true, stdio: "inherit", env });
  }
  console.log(`\nTemporary HTTPS staging verified: ${state.origin}/`);
  console.log("This verifies the network path only; it does not clear remaining release-readiness blockers.");
}

function commandDown() {
  stopScreen(tunnelSession);
  stopPreview();
  fs.rmSync(statePath, { force: true });
  run("npm", ["run", "preview:screen"], { check: true, stdio: "inherit" });
  console.log("Temporary HTTPS staging stopped. Normal local preview was restored at http://127.0.0.1:3003/.");
}

try {
  const command = process.argv[2];
  if (command === "up") commandUp();
  else if (command === "status") commandStatus();
  else if (command === "verify") commandVerify();
  else if (command === "down") commandDown();
  else throw new Error("Usage: node scripts/https-staging.mjs <up|status|verify|down>");
} catch (error) {
  console.error(`HTTPS staging failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
