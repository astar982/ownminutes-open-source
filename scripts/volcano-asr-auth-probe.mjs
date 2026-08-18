import { existsSync, readFileSync } from "node:fs";
import crypto from "node:crypto";

loadDotEnvLocal();

const accountAccessKey = process.env.VOLCANO_ACCESS_KEY_ID;
const accountSecretKey = process.env.VOLCANO_SECRET_ACCESS_KEY;
const speechApiKey = process.env.VOLCANO_ASR_API_KEY;
const endpoint = process.env.VOLCANO_ASR_RECOGNIZE_URL || "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";
const resourceId = process.env.VOLCANO_ASR_RESOURCE_ID || "volc.bigasr.auc_turbo";

if (!accountAccessKey || !accountSecretKey) {
  console.error("VOLCANO_ACCESS_KEY_ID or VOLCANO_SECRET_ACCESS_KEY is missing.");
  process.exit(1);
}

const attempts = [
  ...(speechApiKey
    ? [{
        name: "speech-api-key",
        headers: { "X-Api-Key": speechApiKey },
      }]
    : []),
  {
    name: "account-ak-as-x-api-key",
    headers: {
      "X-Api-Key": accountAccessKey,
    },
  },
  {
    name: "account-ak-sk-as-app-access-pair",
    headers: {
      "X-Api-App-Key": accountAccessKey,
      "X-Api-Access-Key": accountSecretKey,
    },
  },
];

const results = [];

for (const attempt of attempts) {
  const requestId = `ownminutes-auth-probe-${crypto.randomUUID()}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Resource-Id": resourceId,
      "X-Api-Request-Id": requestId,
      "X-Api-Sequence": "-1",
      ...attempt.headers,
    },
    body: JSON.stringify({
      user: {
        uid: "ownminutes-auth-probe",
      },
      audio: {
        data: createSilentWav().toString("base64"),
        format: "wav",
      },
      request: {
        model_name: "bigmodel",
        enable_punc: true,
        show_utterances: true,
      },
    }),
  });

  const bodyText = await response.text();
  let body = null;

  try {
    body = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    body = bodyText ? { text: bodyText.slice(0, 500) } : null;
  }

  const statusCode = response.headers.get("x-api-status-code");
  const message = response.headers.get("x-api-message");

  results.push({
    name: attempt.name,
    httpStatus: response.status,
    xApiStatusCode: statusCode,
    xApiMessage: message,
    authenticatedLikely: inferAuth(statusCode, message, body),
    bodySummary: summarizeBody(body),
  });
}

console.log(JSON.stringify({ ok: true, results }, null, 2));

function inferAuth(statusCode, message, body) {
  const combined = `${statusCode || ""} ${message || ""} ${JSON.stringify(body || {})}`.toLowerCase();

  if (/auth|token|key|permission|forbidden|unauthorized|signature|invalid.*access|invalid.*key/.test(combined)) {
    return false;
  }

  if (/audio|format|decode|invalid.*request|bad.*request|silent|静音|20000003/.test(combined)) {
    return true;
  }

  return null;
}

function createSilentWav() {
  const sampleRate = 16000;
  const dataBytes = sampleRate;
  const output = Buffer.alloc(44 + dataBytes);
  output.write("RIFF", 0);
  output.writeUInt32LE(36 + dataBytes, 4);
  output.write("WAVEfmt ", 8);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36);
  output.writeUInt32LE(dataBytes, 40);
  return output;
}

function summarizeBody(body) {
  if (!body || typeof body !== "object") return null;
  return {
    keys: Object.keys(body).sort(),
    code: body.code || body.Code || null,
    message: body.message || body.Message || null,
  };
}

function loadDotEnvLocal() {
  if (!existsSync(".env.local")) return;

  const contents = readFileSync(".env.local", "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex < 0) continue;
    const key = trimmed.slice(0, separatorIndex);
    const value = trimmed.slice(separatorIndex + 1);
    process.env[key] = value;
  }
}
