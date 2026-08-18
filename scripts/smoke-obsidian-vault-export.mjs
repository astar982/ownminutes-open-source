#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { buildSilentWav } from "./lib/audio-fixtures.mjs";

const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const meetingId = `obsidian-vault-smoke-${timestamp}`;
const email = `obsidian-vault-${timestamp}@ownminutes.local`;
const password = `OwnMinutes-${timestamp}`;
const testIp = `198.51.${Math.floor(Math.random() * 200) + 1}.${Math.floor(Math.random() * 200) + 1}`;
const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "ownminutes-obsidian-vault-"));
const authPath = fs.mkdtempSync(path.join(os.tmpdir(), "ownminutes-obsidian-auth-"));

async function main() {
  const appPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const app = startNextPreview(appPort);

  try {
    await waitForApp(baseUrl, app);
    const unauthenticatedSave = await fetch(`${baseUrl}/api/meetings/${meetingId}/obsidian`, { method: "POST" });
    const unauthenticatedAcceptanceSave = await fetch(`${baseUrl}/api/checkup/acceptance/obsidian`, { method: "POST" });
    const register = await postJson(
      `${baseUrl}/api/auth/register`,
      {
        name: "Obsidian Vault Smoke",
        email,
        password,
      },
      null,
      "POST",
      { "x-forwarded-for": testIp },
    );
    const cookie = extractCookie(register.response);

    const upload = await uploadChunk(baseUrl, cookie, meetingId);
    const final = await postJson(
      `${baseUrl}/api/meetings/${meetingId}/finalize`,
      {
        title: "OwnMinutes Obsidian Vault 烟测",
        expectedLastSequence: upload.totalChunks,
        totalBytes: upload.totalBytes,
      },
      cookie,
    );
    const metadata = await postJson(
      `${baseUrl}/api/meetings/${meetingId}`,
      {
        project: "OwnMinutes Vault Smoke",
        tags: ["obsidian", "vault"],
      },
      cookie,
      "PATCH",
    );
    const save = await postJson(`${baseUrl}/api/meetings/${meetingId}/obsidian`, {}, cookie);
    const savedPath = save.saved?.relativePath ? path.join(vaultPath, save.saved.relativePath) : "";
    const savedMarkdown = savedPath && fs.existsSync(savedPath) ? fs.readFileSync(savedPath, "utf8") : "";
    const saveAgain = await postJson(`${baseUrl}/api/meetings/${meetingId}/obsidian`, {}, cookie);
    const acceptanceSave = await postJson(`${baseUrl}/api/checkup/acceptance/obsidian`, {}, cookie);
    const acceptanceSaveAgain = await postJson(`${baseUrl}/api/checkup/acceptance/obsidian`, {}, cookie);
    const acceptanceSavedPath = acceptanceSave.saved?.relativePath ? path.join(vaultPath, acceptanceSave.saved.relativePath) : "";
    const acceptanceMarkdown = acceptanceSavedPath && fs.existsSync(acceptanceSavedPath) ? fs.readFileSync(acceptanceSavedPath, "utf8") : "";
    const deleteAccount = await fetch(`${baseUrl}/api/auth/delete`, {
      method: "DELETE",
      headers: {
        Cookie: cookie,
        Origin: browserOriginFor(baseUrl),
        "Sec-Fetch-Site": "same-origin",
      },
    });
    const deleteAccountPayload = await readJsonResponse(deleteAccount, `${baseUrl}/api/auth/delete`);

    const summary = {
      unauthenticatedBlocked: unauthenticatedSave.status === 401,
      unauthenticatedAcceptanceBlocked: unauthenticatedAcceptanceSave.status === 401,
      registerOk: register.ok === true,
      finalizeOk: final.ok === true,
      metadataOk: metadata.ok === true,
      saveOk: save.ok === true,
      saveAgainOk: saveAgain.ok === true,
      acceptanceSaveOk: acceptanceSave.ok === true,
      acceptanceSaveAgainOk: acceptanceSaveAgain.ok === true,
      fileName: save.saved?.fileName,
      relativePath: save.saved?.relativePath,
      acceptanceFileName: acceptanceSave.saved?.fileName,
      acceptanceRelativePath: acceptanceSave.saved?.relativePath,
      returnedAbsolutePath: Boolean(save.saved?.absolutePath),
      acceptanceReturnedAbsolutePath: Boolean(acceptanceSave.saved?.absolutePath),
      savedFileExists: Boolean(savedPath && fs.existsSync(savedPath)),
      acceptanceFileExists: Boolean(acceptanceSavedPath && fs.existsSync(acceptanceSavedPath)),
      savedUnderProjectDirectory: save.saved?.relativePath?.startsWith("OwnMinutes/OwnMinutes Vault Smoke/") === true,
      acceptanceSavedUnderDirectory: acceptanceSave.saved?.relativePath?.startsWith("OwnMinutes/验收记录/") === true,
      savedHasTitle: savedMarkdown.includes("# OwnMinutes Obsidian Vault 烟测"),
      savedHasProject: savedMarkdown.includes("project: OwnMinutes Vault Smoke"),
      savedHasTags: savedMarkdown.includes("  - obsidian") && savedMarkdown.includes("  - vault"),
      savedHasSummary: savedMarkdown.includes("## 会议摘要"),
      savedHasTranscript: savedMarkdown.includes("## 逐字稿"),
      savedHasQualityWarning:
        savedMarkdown.includes("质量提示") &&
        savedMarkdown.includes("尚未通过正式识别验收") &&
        savedMarkdown.includes("请勿作为正式会议事实归档"),
      acceptanceHasTitle: acceptanceMarkdown.includes("# OwnMinutes MVP 验收单"),
      acceptanceHasManualScript:
        acceptanceMarkdown.includes("## 人工验收脚本") &&
        acceptanceMarkdown.includes("验收 iPhone / TestFlight 长录音") &&
        acceptanceMarkdown.includes("5、30、90 分钟录音") &&
        acceptanceMarkdown.includes("录制真人多人会议"),
      acceptanceHasEvidenceFields:
        acceptanceMarkdown.includes("验收人：") &&
        acceptanceMarkdown.includes("验收设备：") &&
        acceptanceMarkdown.includes("证据建议：") &&
        acceptanceMarkdown.includes("证据链接或截图："),
      acceptanceHasBlockers: acceptanceMarkdown.includes("## 关键上线阻塞") && acceptanceMarkdown.includes("Critical Blocked"),
      acceptanceHasBlockerEvidence:
        acceptanceMarkdown.includes("验收证据：") &&
        acceptanceMarkdown.includes("ASR 小音频测试达到 transcribed") &&
        acceptanceMarkdown.includes("真实 PostgreSQL 执行 migration"),
      acceptanceLeaksSecrets: leaksSecrets(acceptanceMarkdown),
      saveIsIdempotent: save.saved?.relativePath === saveAgain.saved?.relativePath,
      acceptanceSaveIsIdempotent: acceptanceSave.saved?.relativePath === acceptanceSaveAgain.saved?.relativePath,
      deleteAccountOk: deleteAccountPayload.ok === true,
      leaksServerPath: JSON.stringify(save).includes(vaultPath) || JSON.stringify(acceptanceSave).includes(vaultPath),
    };

    console.log(JSON.stringify(summary, null, 2));

    if (
      !summary.unauthenticatedBlocked ||
      !summary.unauthenticatedAcceptanceBlocked ||
      !summary.registerOk ||
      !summary.finalizeOk ||
      !summary.metadataOk ||
      !summary.saveOk ||
      !summary.saveAgainOk ||
      !summary.acceptanceSaveOk ||
      !summary.acceptanceSaveAgainOk ||
      !summary.fileName?.endsWith(".md") ||
      !summary.acceptanceFileName?.endsWith(".md") ||
      summary.returnedAbsolutePath ||
      summary.acceptanceReturnedAbsolutePath ||
      !summary.savedFileExists ||
      !summary.acceptanceFileExists ||
      !summary.savedUnderProjectDirectory ||
      !summary.acceptanceSavedUnderDirectory ||
      !summary.savedHasTitle ||
      !summary.savedHasProject ||
      !summary.savedHasTags ||
      !summary.savedHasSummary ||
      !summary.savedHasTranscript ||
      !summary.savedHasQualityWarning ||
      !summary.acceptanceHasTitle ||
      !summary.acceptanceHasManualScript ||
      !summary.acceptanceHasEvidenceFields ||
      !summary.acceptanceHasBlockers ||
      !summary.acceptanceHasBlockerEvidence ||
      summary.acceptanceLeaksSecrets ||
      !summary.saveIsIdempotent ||
      !summary.acceptanceSaveIsIdempotent ||
      !summary.deleteAccountOk ||
      summary.leaksServerPath
    ) {
      process.exitCode = 1;
    }
  } finally {
    app.kill("SIGTERM");
    fs.rmSync(vaultPath, { force: true, recursive: true });
    fs.rmSync(authPath, { force: true, recursive: true });
  }
}

function startNextPreview(appPort) {
  const child = spawn("./node_modules/.bin/next", ["dev", "--hostname", "127.0.0.1", "--port", String(appPort)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OWNMINUTES_ALLOW_FIRST_USER_ADMIN: "1",
      OWNMINUTES_AUTH_DATA_DIR: authPath,
      OWNMINUTES_AUTH_REPOSITORY: "local-file",
      OWNMINUTES_OBSIDIAN_VAULT_PATH: vaultPath,
      OWNMINUTES_TRUST_LOOPBACK_PROXY_HEADERS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (data) => {
    if (process.env.SMOKE_VERBOSE) process.stdout.write(data);
  });
  child.stderr.on("data", (data) => {
    if (process.env.SMOKE_VERBOSE) process.stderr.write(data);
  });

  return child;
}

async function uploadChunk(baseUrl, cookie, targetMeetingId) {
  const audio = new Blob([buildSilentWav()], {
    type: "audio/wav",
  });
  const form = new FormData();
  form.append("sequence", "1");
  form.append("mimeType", "audio/wav");
  form.append("recordedAt", String(Date.now()));
  form.append("durationMs", "1000");
  form.append("chunk", audio, "chunk-000001.wav");

  const response = await fetch(`${baseUrl}/api/meetings/${targetMeetingId}/chunks`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: browserOriginFor(baseUrl),
      "Sec-Fetch-Site": "same-origin",
    },
    body: form,
  });
  return readJsonResponse(response, `${baseUrl}/api/meetings/${targetMeetingId}/chunks`);
}

async function waitForApp(baseUrl, app) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    if (app.exitCode !== null) {
      throw new Error(`Next preview exited early with code ${app.exitCode}.`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("Timed out waiting for Next preview.");
}

async function postJson(url, body, cookie, method = "POST", extraHeaders = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: browserOriginFor(url),
      "Sec-Fetch-Site": "same-origin",
      ...(cookie ? { Cookie: cookie } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const payload = await readJsonResponse(response, url);
  return { response, ...payload };
}

function browserOriginFor(url) {
  const origin = new URL(url);
  origin.hostname = "localhost";
  return origin.origin;
}

async function readJsonResponse(response, url) {
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON from ${url}: ${error.message}\n${text.slice(0, 500)}`);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${JSON.stringify(payload)}`);
  }

  return payload;
}

function extractCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("Register response did not set a session cookie.");
  return setCookie.split(";")[0];
}

function leaksSecrets(value) {
  return value.includes("AKL") || value.includes("Secret Access Key") || value.includes("sk-proj") || value.includes("WVRC");
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
