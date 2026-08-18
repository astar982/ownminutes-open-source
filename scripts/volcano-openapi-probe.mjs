import crypto from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

loadDotEnvLocal();

const ak = process.env.VOLCANO_ACCESS_KEY_ID;
const sk = process.env.VOLCANO_SECRET_ACCESS_KEY;
const shouldIssueArkKey = process.argv.includes("--issue-ark-key");
const shouldCreateArkEndpoint = process.argv.includes("--create-ark-endpoint");

if (!ak || !sk) {
  console.error("VOLCANO_ACCESS_KEY_ID or VOLCANO_SECRET_ACCESS_KEY is missing.");
  process.exit(1);
}

const probes = [
  {
    name: "iam:GetCallerIdentity",
    service: "iam",
    region: "cn-beijing",
    host: "iam.volcengineapi.com",
    action: "GetCallerIdentity",
    version: "2018-01-01",
  },
  {
    name: "iam:ListAccessKeys",
    service: "iam",
    region: "cn-beijing",
    host: "iam.volcengineapi.com",
    action: "ListAccessKeys",
    version: "2018-01-01",
  },
  {
    name: "iam:GetAccountSummary",
    service: "iam",
    region: "cn-beijing",
    host: "iam.volcengineapi.com",
    action: "GetAccountSummary",
    version: "2018-01-01",
  },
  {
    name: "ark:ListEndpoints",
    service: "ark",
    region: "cn-beijing",
    host: "ark.cn-beijing.volcengineapi.com",
    action: "ListEndpoints",
    version: "2024-01-01",
    method: "POST",
    body: {},
  },
  {
    name: "ark:ListFoundationModels",
    service: "ark",
    region: "cn-beijing",
    host: "ark.cn-beijing.volcengineapi.com",
    action: "ListFoundationModels",
    version: "2024-01-01",
    method: "POST",
    body: {},
  },
  {
    name: "ark:ListFoundationModelVersions:deepseek-v4-flash",
    service: "ark",
    region: "cn-beijing",
    host: "ark.cn-beijing.volcengineapi.com",
    action: "ListFoundationModelVersions",
    version: "2024-01-01",
    method: "POST",
    body: { FoundationModelName: "deepseek-v4-flash" },
  },
  {
    name: "ark:GetApiKey",
    service: "ark",
    region: "cn-beijing",
    host: "ark.cn-beijing.volcengineapi.com",
    action: "GetApiKey",
    version: "2024-01-01",
    method: "POST",
    body: { DurationSeconds: 86400 },
    sensitiveResult: true,
  },
  {
    name: "ark:GetApiKey:endpoint-no-resource-id",
    service: "ark",
    region: "cn-beijing",
    host: "ark.cn-beijing.volcengineapi.com",
    action: "GetApiKey",
    version: "2024-01-01",
    method: "POST",
    body: { DurationSeconds: 86400, ResourceType: "endpoint" },
    sensitiveResult: true,
  },
  {
    name: "ark:CreateEndpoint:empty-body",
    service: "ark",
    region: "cn-beijing",
    host: "ark.cn-beijing.volcengineapi.com",
    action: "CreateEndpoint",
    version: "2024-01-01",
    method: "POST",
    body: {},
  },
  {
    name: "ark:CreateEndpoint:name-only",
    service: "ark",
    region: "cn-beijing",
    host: "ark.cn-beijing.volcengineapi.com",
    action: "CreateEndpoint",
    version: "2024-01-01",
    method: "POST",
    body: { Name: "ownminutes-probe" },
  },
  {
    name: "ark:CreateEndpoint:model-reference-empty",
    service: "ark",
    region: "cn-beijing",
    host: "ark.cn-beijing.volcengineapi.com",
    action: "CreateEndpoint",
    version: "2024-01-01",
    method: "POST",
    body: { Name: "ownminutes-probe", ModelReference: {} },
  },
  {
    name: "ark:CreateEndpoint:dry-run-deepseek-v4-flash",
    service: "ark",
    region: "cn-beijing",
    host: "ark.cn-beijing.volcengineapi.com",
    action: "CreateEndpoint",
    version: "2024-01-01",
    method: "POST",
    body: {
      Name: "ownminutes-summary-probe",
      ModelReference: {
        FoundationModel: {
          Name: "deepseek-v4-flash",
          ModelVersion: "260425",
        },
      },
      DryRun: true,
    },
  },
  {
    name: "ark:CreateEndpoint:dry-run-model-id",
    service: "ark",
    region: "cn-beijing",
    host: "ark.cn-beijing.volcengineapi.com",
    action: "CreateEndpoint",
    version: "2024-01-01",
    method: "POST",
    body: {
      Name: "ownminutes-summary-probe",
      ModelReference: {
        ModelId: "deepseek-v4-flash-260425",
      },
      DryRun: true,
    },
  },
  {
    name: "ark:CreateEndpoint:dry-run-model-reference-string",
    service: "ark",
    region: "cn-beijing",
    host: "ark.cn-beijing.volcengineapi.com",
    action: "CreateEndpoint",
    version: "2024-01-01",
    method: "POST",
    body: {
      Name: "ownminutes-summary-probe",
      ModelReference: "deepseek-v4-flash-260425",
      DryRun: true,
    },
  },
  {
    name: "ark:CreateEndpoint:dry-run-nested-foundation-model",
    service: "ark",
    region: "cn-beijing",
    host: "ark.cn-beijing.volcengineapi.com",
    action: "CreateEndpoint",
    version: "2024-01-01",
    method: "POST",
    body: {
      Name: "ownminutes-summary-probe",
      ModelReference: {
        FoundationModel: {
          Name: "deepseek-v4-flash",
          ModelVersion: "260425",
        },
      },
      DryRun: true,
    },
  },
];

const results = [];

for (const probe of probes) {
  try {
    const response = await callOpenApi(probe);
    results.push({
      name: probe.name,
      ok: response.ok,
      httpStatus: response.status,
      requestId: response.body?.ResponseMetadata?.RequestId || null,
      errorCode: response.body?.ResponseMetadata?.Error?.Code || null,
      errorMessage: response.body?.ResponseMetadata?.Error?.Message || null,
      summary: summarizeResult(probe.action, response.body?.Result),
    });
  } catch (error) {
    results.push({
      name: probe.name,
      ok: false,
      errorMessage: error instanceof Error ? error.message : "probe failed",
    });
  }
}

console.log(JSON.stringify({ ok: results.some((item) => item.ok), results }, null, 2));

if (shouldIssueArkKey) {
  await issueArkApiKey();
}

if (shouldCreateArkEndpoint) {
  await createArkEndpointAndIssueKey();
}

async function createArkEndpointAndIssueKey() {
  const endpointName = process.env.ARK_ENDPOINT_NAME || "ownminutes-summary";
  const modelName = process.env.ARK_FOUNDATION_MODEL_NAME || "deepseek-v4-flash";
  const modelVersion = process.env.ARK_FOUNDATION_MODEL_VERSION || "260425";
  let endpointId = await findExistingEndpoint(endpointName);

  if (!endpointId) {
    const createResponse = await callOpenApi({
      name: "ark:CreateEndpoint",
      service: "ark",
      region: "cn-beijing",
      host: "ark.cn-beijing.volcengineapi.com",
      action: "CreateEndpoint",
      version: "2024-01-01",
      method: "POST",
      body: {
        Name: endpointName,
        ModelReference: {
          FoundationModel: {
            Name: modelName,
            ModelVersion: modelVersion,
          },
        },
      },
    });

    if (!createResponse.ok) {
      console.error(
        JSON.stringify(
          {
            ok: false,
            action: "ark:CreateEndpoint",
            httpStatus: createResponse.status,
            requestId: createResponse.body?.ResponseMetadata?.RequestId || null,
            errorCode: createResponse.body?.ResponseMetadata?.Error?.Code || null,
            errorMessage: createResponse.body?.ResponseMetadata?.Error?.Message || "CreateEndpoint failed.",
          },
          null,
          2,
        ),
      );
      process.exitCode = 1;
      return;
    }

    endpointId = findEndpointId(createResponse.body?.Result);
  }

  if (!endpointId) {
    endpointId = await waitForEndpoint(endpointName);
  }

  if (!endpointId) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          action: "ark:CreateEndpoint",
          errorMessage: "Endpoint was created or existed, but no endpoint id could be resolved.",
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  const apiKey = await getArkApiKeyForEndpoint(endpointId);

  if (!apiKey) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          action: "ark:GetApiKey",
          endpointId,
          errorMessage: "No API key-like field found in GetApiKey response.",
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  upsertEnvLocal({
    ARK_API_KEY: apiKey,
    ARK_BASE_URL: process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3",
    ARK_CHAT_MODEL: endpointId,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        action: "ark:create-endpoint-and-issue-key",
        endpointName,
        endpointId,
        wrote: [".env.local:ARK_API_KEY", ".env.local:ARK_CHAT_MODEL"],
        keyValuePrinted: false,
      },
      null,
      2,
    ),
  );
}

async function issueArkApiKey() {
  const probe = {
    name: "ark:GetApiKey",
    service: "ark",
    region: "cn-beijing",
    host: "ark.cn-beijing.volcengineapi.com",
    action: "GetApiKey",
    version: "2024-01-01",
    method: "POST",
    body: { DurationSeconds: Number(process.env.ARK_TEMP_KEY_DURATION_SECONDS || 86400) },
  };
  const response = await callOpenApi(probe);
  const apiKey = findApiKey(response.body?.Result);

  if (!response.ok || !apiKey) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          action: "ark:GetApiKey",
          httpStatus: response.status,
          requestId: response.body?.ResponseMetadata?.RequestId || null,
          errorCode: response.body?.ResponseMetadata?.Error?.Code || null,
          errorMessage: response.body?.ResponseMetadata?.Error?.Message || "No API key-like field found in response.",
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  upsertEnvLocal({
    ARK_API_KEY: apiKey,
    ARK_BASE_URL: process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3",
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        action: "ark:GetApiKey",
        wrote: [".env.local:ARK_API_KEY"],
        keyValuePrinted: false,
      },
      null,
      2,
    ),
  );
}

async function findExistingEndpoint(endpointName) {
  const response = await callOpenApi({
    name: "ark:ListEndpoints",
    service: "ark",
    region: "cn-beijing",
    host: "ark.cn-beijing.volcengineapi.com",
    action: "ListEndpoints",
    version: "2024-01-01",
    method: "POST",
    body: {},
  });

  if (!response.ok) return null;

  return findEndpointByName(response.body?.Result, endpointName);
}

async function waitForEndpoint(endpointName) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const endpointId = await findExistingEndpoint(endpointName);
    if (endpointId) return endpointId;
    await wait(3000);
  }

  return null;
}

async function getArkApiKeyForEndpoint(endpointId) {
  const response = await callOpenApi({
    name: "ark:GetApiKey",
    service: "ark",
    region: "cn-beijing",
    host: "ark.cn-beijing.volcengineapi.com",
    action: "GetApiKey",
    version: "2024-01-01",
    method: "POST",
    body: {
      DurationSeconds: Number(process.env.ARK_TEMP_KEY_DURATION_SECONDS || 86400),
      ResourceType: "endpoint",
      ResourceIds: [endpointId],
    },
  });

  return response.ok ? findApiKey(response.body?.Result) : null;
}

async function callOpenApi(probe) {
  const now = new Date();
  const xDate = toAmzDate(now);
  const shortDate = xDate.slice(0, 8);
  const query = new URLSearchParams({
    Action: probe.action,
    Version: probe.version,
  });
  const path = "/";
  const canonicalQuery = query.toString();
  const method = probe.method || "GET";
  const payload = probe.body ? JSON.stringify(probe.body) : "";
  const contentType = method === "POST" ? "application/json; charset=utf-8" : null;
  const canonicalHeaders = contentType
    ? `content-type:${contentType}\nhost:${probe.host}\nx-date:${xDate}\n`
    : `host:${probe.host}\nx-date:${xDate}\n`;
  const signedHeaders = contentType ? "content-type;host;x-date" : "host;x-date";
  const payloadHash = sha256Hex(payload);
  const canonicalRequest = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${shortDate}/${probe.region}/${probe.service}/request`;
  const stringToSign = ["HMAC-SHA256", xDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = getSigningKey(sk, shortDate, probe.region, probe.service);
  const signature = hmacHex(signingKey, stringToSign);
  const authorization = `HMAC-SHA256 Credential=${ak}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response = await fetch(`https://${probe.host}/?${canonicalQuery}`, {
    method,
    headers: {
      Host: probe.host,
      "X-Date": xDate,
      Authorization: authorization,
      ...(contentType ? { "Content-Type": contentType } : {}),
    },
    body: method === "POST" ? payload : undefined,
  });
  const text = await response.text();
  let body = null;

  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { text: text.slice(0, 500) };
  }

  return { ok: response.ok && !body?.ResponseMetadata?.Error, status: response.status, body };
}

function summarizeResult(action, result) {
  if (!result || typeof result !== "object") return null;

  if (action === "ListAccessKeys") {
    const keys = Array.isArray(result.AccessKeyMetadata) ? result.AccessKeyMetadata : [];
    return {
      accessKeyCount: keys.length,
      keys: keys.map((item) => ({
        accessKeyIdPrefix: typeof item.AccessKeyId === "string" ? `${item.AccessKeyId.slice(0, 8)}...` : null,
        userName: item.UserName || null,
        status: item.Status || null,
        createDate: item.CreateDate || null,
      })),
    };
  }

  if (action === "GetCallerIdentity") {
    return {
      accountId: maskValue(result.AccountId),
      userId: maskValue(result.UserId),
      trn: maskTrn(result.Trn),
    };
  }

  if (action === "GetAccountSummary") {
    return {
      keys: Object.keys(result).sort(),
    };
  }

  if (action === "ListEndpoints") {
    const endpoints = Array.isArray(result.Items) ? result.Items : Array.isArray(result.Endpoints) ? result.Endpoints : [];
    return {
      endpointCount: endpoints.length,
      endpoints: endpoints.slice(0, 10).map((item) => ({
        id: item.Id || item.EndpointId || item.endpoint_id || null,
        name: item.Name || item.EndpointName || item.endpoint_name || null,
        status: item.Status || item.StatusText || item.status || null,
        model: item.Model || item.FoundationModel || item.ModelName || item.model || null,
      })),
    };
  }

  if (action === "ListFoundationModels") {
    const models = Array.isArray(result.Items) ? result.Items : Array.isArray(result.Models) ? result.Models : [];
    return {
      modelCount: models.length,
      models: models.slice(0, 20).map((item) => ({
        keys: Object.keys(item).sort(),
        name: item.Name || item.ModelName || item.model_name || null,
        displayName: item.DisplayName || item.ModelDisplayName || item.display_name || null,
        type: item.Type || item.ModelType || item.type || null,
        modelReference: item.ModelReference || item.Reference || null,
        id: item.Id || item.ModelId || null,
      })),
    };
  }

  if (action === "ListFoundationModelVersions") {
    const versions = Array.isArray(result.Items) ? result.Items : Array.isArray(result.Versions) ? result.Versions : [];
    return {
      versionCount: versions.length,
      versions: versions.slice(0, 20).map((item) => ({
        keys: Object.keys(item).sort(),
        name: item.Name || item.Version || item.ModelVersion || null,
        displayName: item.DisplayName || item.display_name || null,
        id: item.Id || item.ModelVersionId || null,
        modelId: item.ModelId || null,
        foundationModelName: item.FoundationModelName || null,
        modelVersion: item.ModelVersion || null,
        status: item.Status || item.status || null,
      })),
    };
  }

  if (action === "GetApiKey") {
    return {
      returnedFields: Object.keys(result).sort(),
      containsApiKeyLikeField: Object.keys(result).some((key) => /key|token|secret/i.test(key)),
    };
  }

  return null;
}

function maskValue(value) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  if (text.length <= 6) return "***";
  return `${text.slice(0, 3)}...${text.slice(-3)}`;
}

function maskTrn(value) {
  if (!value) return null;
  return String(value).replace(/::([^:]+):/, (_, account) => `::${maskValue(account)}:`);
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

function upsertEnvLocal(updates) {
  const lines = existsSync(".env.local") ? readFileSync(".env.local", "utf8").split(/\r?\n/) : [];
  const seen = new Set();
  const nextLines = lines.map((line) => {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex < 0 || line.trim().startsWith("#")) return line;

    const key = line.slice(0, separatorIndex);
    if (!(key in updates)) return line;

    seen.add(key);
    return `${key}=${updates[key]}`;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) nextLines.push(`${key}=${value}`);
  }

  writeSecureEnv(nextLines.filter((line, index, all) => line || index < all.length - 1).join("\n"));
}

function writeSecureEnv(contents) {
  writeFileSync(".env.local", `${contents.replace(/\n*$/, "")}\n`, { mode: 0o600 });
  chmodSync(".env.local", 0o600);
}

function findApiKey(value) {
  if (!value || typeof value !== "object") return null;

  for (const [key, nested] of Object.entries(value)) {
    if (/^(api[-_]?key|apikey|key|token|access[-_]?key)$/i.test(key) && typeof nested === "string" && nested.length > 20) {
      return nested;
    }
  }

  for (const nested of Object.values(value)) {
    const found = findApiKey(nested);
    if (found) return found;
  }

  return null;
}

function findEndpointId(result) {
  if (!result || typeof result !== "object") return null;

  for (const [key, value] of Object.entries(result)) {
    if (/^(id|endpointid|endpoint_id)$/i.test(key) && typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  for (const value of Object.values(result)) {
    if (value && typeof value === "object") {
      const found = findEndpointId(value);
      if (found) return found;
    }
  }

  return null;
}

function findEndpointByName(result, endpointName) {
  if (!result || typeof result !== "object") return null;

  const endpoints = Array.isArray(result.Items) ? result.Items : Array.isArray(result.Endpoints) ? result.Endpoints : [];

  for (const item of endpoints) {
    if (!item || typeof item !== "object") continue;

    const name = item.Name || item.EndpointName || item.endpoint_name;
    if (name !== endpointName) continue;

    return item.Id || item.EndpointId || item.endpoint_id || null;
  }

  return null;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toAmzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key, value) {
  return crypto.createHmac("sha256", key).update(value, "utf8").digest();
}

function hmacHex(key, value) {
  return crypto.createHmac("sha256", key).update(value, "utf8").digest("hex");
}

function getSigningKey(secretKey, date, region, service) {
  const kDate = hmac(Buffer.from(secretKey, "utf8"), date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "request");
}
