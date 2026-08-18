import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type MeetingObjectStoreProvider = "local" | "s3" | "r2" | "volcano-tos";

export const meetingObjectStoreContractVersion = "meeting-object-store-contract:v3";

export type MeetingObjectStore = {
  provider: MeetingObjectStoreProvider;
  putBuffer(key: string, value: Buffer): Promise<void>;
  putFile(key: string, filePath: string): Promise<void>;
  putText(key: string, value: string): Promise<void>;
  createPresignedGetUrl(key: string, expiresSeconds: number): Promise<string | null>;
  getBuffer(key: string): Promise<Buffer>;
  getFile(key: string, filePath: string): Promise<number>;
  getText(key: string): Promise<string>;
  deletePrefix(prefix: string, options?: { signal?: AbortSignal }): Promise<void>;
  listTopLevelPrefixes(): Promise<string[]>;
};

export class MeetingObjectStoreHttpError extends Error {
  readonly method: "DELETE" | "GET" | "PUT";
  readonly status: number;

  constructor(
    method: "DELETE" | "GET" | "PUT",
    status: number,
    responseBody: string,
  ) {
    const detail = responseBody.trim().slice(0, 500);
    super(`Object store ${method} failed: ${status}${detail ? ` ${detail}` : ""}`);
    this.name = "MeetingObjectStoreHttpError";
    this.method = method;
    this.status = status;
  }
}

export type MeetingObjectStoreContract = {
  version: typeof meetingObjectStoreContractVersion;
  objectModel: {
    meetingPrefix: "{{meetingId}}/";
    manifest: "{{meetingId}}/manifest.json";
    chunk: "{{meetingId}}/chunks/{{fileName}}";
    asrInput: "{{meetingId}}/transient/asr/{{fileName}}";
    result: "{{meetingId}}/result.json";
    obsidianMarkdown: "{{meetingId}}/obsidian.md";
    processing: "{{meetingId}}/processing.json";
    processingCheckpoint: "{{meetingId}}/processing-checkpoints/{{operationHash}}.json";
  };
  operations: Array<"putBuffer" | "putFile" | "putText" | "createPresignedGetUrl" | "getBuffer" | "getFile" | "getText" | "deletePrefix" | "listTopLevelPrefixes">;
  providers: MeetingObjectStoreProvider[];
};

const localMeetingsRoot = path.join(process.cwd(), ".data", "meetings");

export function getMeetingObjectStore(): MeetingObjectStore {
  const remoteStore = getRemoteObjectStore();
  if (remoteStore) return remoteStore;
  return localMeetingObjectStore;
}

export function isMissingMeetingObjectError(error: unknown) {
  if (error instanceof MeetingObjectStoreHttpError) {
    return error.method === "GET" && error.status === 404;
  }

  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function readOptionalMeetingObject<T>(reader: () => Promise<T>): Promise<T | null> {
  try {
    return await reader();
  } catch (error) {
    if (isMissingMeetingObjectError(error)) return null;
    throw error;
  }
}

export function getMeetingObjectStoreInfo() {
  const contract = getMeetingObjectStoreContract();
  const remoteStore = getRemoteObjectStore();
  if (remoteStore) {
    return {
      contractVersion: contract.version,
      provider: remoteStore.provider,
      localRoot: "",
      supportsFilePut: true,
      supportsPresignedGet: true,
      supportsDeletePrefix: true,
      supportsTopLevelPrefixListing: true,
    };
  }

  return {
    contractVersion: contract.version,
    provider: localMeetingObjectStore.provider,
    localRoot: ".data/meetings",
    supportsFilePut: true,
    supportsPresignedGet: false,
    supportsDeletePrefix: true,
    supportsTopLevelPrefixListing: true,
  };
}

export async function probeMeetingObjectStoreReadiness() {
  const config = getRemoteObjectStoreConfig();
  if (!config) {
    try {
      const workspace = await stat(process.cwd());
      const allowed = process.env.NODE_ENV !== "production" && workspace.isDirectory();
      return {
        ok: allowed,
        provider: "local" as const,
        durable: false,
        detail: allowed
          ? "本地开发文件系统可访问；该模式不计入生产对象存储就绪。"
          : "生产环境未配置可验证的远端对象存储。",
      };
    } catch {
      return {
        ok: false,
        provider: "local" as const,
        durable: false,
        detail: "本地文件系统不可访问，且未配置远端对象存储。",
      };
    }
  }

  try {
    const query = new URLSearchParams({
      "list-type": "2",
      "max-keys": "1",
    });
    if (config.keyPrefix) query.set("prefix", `${config.keyPrefix.replace(/\/$/, "")}/`);
    const request = await signedRequest(config, {
      key: "",
      method: "GET",
      query,
    });
    const body = (await readResponseBody(request, { allowEmpty: true, maxBytes: 64 * 1024 })).toString("utf8");
    const validResponse = /<ListBucketResult(?:\s|>)/.test(body);
    return {
      ok: validResponse,
      provider: config.provider,
      durable: true,
      detail: validResponse
        ? "对象存储凭据、Bucket 与只读列表请求可用。"
        : "对象存储返回了非预期的列表响应。",
    };
  } catch (error) {
    return {
      ok: false,
      provider: config.provider,
      durable: true,
      detail: sanitizeReadinessError(error, "对象存储只读探针失败。"),
    };
  }
}

export function getMeetingObjectStoreContract(): MeetingObjectStoreContract {
  return {
    version: meetingObjectStoreContractVersion,
    objectModel: {
      meetingPrefix: "{{meetingId}}/",
      manifest: "{{meetingId}}/manifest.json",
      chunk: "{{meetingId}}/chunks/{{fileName}}",
      asrInput: "{{meetingId}}/transient/asr/{{fileName}}",
      result: "{{meetingId}}/result.json",
      obsidianMarkdown: "{{meetingId}}/obsidian.md",
      processing: "{{meetingId}}/processing.json",
      processingCheckpoint: "{{meetingId}}/processing-checkpoints/{{operationHash}}.json",
    },
    operations: ["putBuffer", "putFile", "putText", "createPresignedGetUrl", "getBuffer", "getFile", "getText", "deletePrefix", "listTopLevelPrefixes"],
    providers: ["local", "s3", "r2", "volcano-tos"],
  };
}

export function buildMeetingObjectKey(
  meetingId: string,
  kind: "manifest" | "result" | "obsidianMarkdown" | "processing" | "prefix",
): string;
export function buildMeetingObjectKey(meetingId: string, kind: "chunk", fileName: string): string;
export function buildMeetingObjectKey(meetingId: string, kind: "asrInput", fileName: string): string;
export function buildMeetingObjectKey(
  meetingId: string,
  kind: "asrInput" | "chunk" | "manifest" | "obsidianMarkdown" | "processing" | "prefix" | "result",
  fileName?: string,
) {
  const meetingKey = normalizeObjectKey(meetingId);
  if (kind === "prefix") return meetingKey;
  if (kind === "manifest") return `${meetingKey}/manifest.json`;
  if (kind === "result") return `${meetingKey}/result.json`;
  if (kind === "obsidianMarkdown") return `${meetingKey}/obsidian.md`;
  if (kind === "processing") return `${meetingKey}/processing.json`;
  if (kind === "asrInput") {
    if (!fileName) throw new Error("Missing meeting ASR input file name.");
    return `${meetingKey}/transient/asr/${normalizeObjectKey(fileName)}`;
  }
  if (!fileName) throw new Error("Missing meeting chunk file name.");
  return `${meetingKey}/chunks/${normalizeObjectKey(fileName)}`;
}

function getRemoteObjectStore(): MeetingObjectStore | null {
  const config = getRemoteObjectStoreConfig();
  if (!config) return null;
  return createS3CompatibleObjectStore(config);
}

type S3CompatibleConfig = {
  accessKeyId: string;
  bucket: string;
  endpoint: string;
  keyPrefix: string;
  provider: Exclude<MeetingObjectStoreProvider, "local">;
  region: string;
  secretAccessKey: string;
  service: string;
};

function getRemoteObjectStoreConfig(): S3CompatibleConfig | null {
  if (hasAnyEnv(["R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ENDPOINT"])) {
    const config = {
      provider: "r2" as const,
      bucket: getEnv("R2_BUCKET"),
      endpoint: getEnv("R2_ENDPOINT"),
      accessKeyId: getEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: getEnv("R2_SECRET_ACCESS_KEY"),
      keyPrefix: getStorageKeyPrefix(),
      region: getEnv("R2_REGION") || "auto",
      service: "s3",
    };
    return isRemoteConfigComplete(config) ? config : null;
  }

  if (hasAnyEnv(["VOLCANO_TOS_BUCKET", "TOS_BUCKET", "VOLCANO_TOS_ENDPOINT", "TOS_ENDPOINT"])) {
    const config = {
      provider: "volcano-tos" as const,
      bucket: getEnv("VOLCANO_TOS_BUCKET", "TOS_BUCKET"),
      endpoint: getEnv("VOLCANO_TOS_ENDPOINT", "TOS_ENDPOINT"),
      accessKeyId: getEnv("VOLCANO_TOS_ACCESS_KEY_ID", "TOS_ACCESS_KEY_ID", "VOLCANO_ACCESS_KEY_ID"),
      secretAccessKey: getEnv("VOLCANO_TOS_SECRET_ACCESS_KEY", "TOS_SECRET_ACCESS_KEY", "VOLCANO_SECRET_ACCESS_KEY"),
      keyPrefix: getStorageKeyPrefix(),
      region: getEnv("VOLCANO_TOS_REGION", "TOS_REGION", "VOLCANO_REGION") || "cn-beijing",
      service: "tos",
    };
    return isRemoteConfigComplete(config) ? config : null;
  }

  if (hasAnyEnv(["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_ENDPOINT"])) {
    const config = {
      provider: "s3" as const,
      bucket: getEnv("S3_BUCKET"),
      endpoint: getEnv("S3_ENDPOINT"),
      accessKeyId: getEnv("S3_ACCESS_KEY_ID"),
      secretAccessKey: getEnv("S3_SECRET_ACCESS_KEY"),
      keyPrefix: getStorageKeyPrefix(),
      region: getEnv("S3_REGION") || "us-east-1",
      service: "s3",
    };
    return isRemoteConfigComplete(config) ? config : null;
  }

  return null;
}

function createS3CompatibleObjectStore(config: S3CompatibleConfig): MeetingObjectStore {
  return {
    provider: config.provider,
    async putBuffer(key, value) {
      await signedRequest(config, {
        key: scopeObjectKey(config, key),
        method: "PUT",
        body: value,
        largeResponse: value.byteLength > 1024 * 1024,
        headers: {
          "content-type": "application/octet-stream",
        },
      });
    },
    async putFile(key, filePath) {
      const file = await stat(filePath);
      if (!file.isFile() || file.size <= 0) throw new Error("Meeting object file is empty or unavailable.");
      await signedRequest(config, {
        key: scopeObjectKey(config, key),
        method: "PUT",
        bodyFile: {
          filePath,
          payloadHash: await sha256File(filePath),
          size: file.size,
        },
        headers: {
          "content-type": "application/octet-stream",
        },
      });
    },
    async putText(key, value) {
      await signedRequest(config, {
        key: scopeObjectKey(config, key),
        method: "PUT",
        body: Buffer.from(value, "utf8"),
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
      });
    },
    async createPresignedGetUrl(key, expiresSeconds) {
      return presignAwsV4Get(config, scopeObjectKey(config, key), expiresSeconds);
    },
    async getBuffer(key) {
      const request = await signedRequest(config, { key: scopeObjectKey(config, key), method: "GET" });
      return readResponseBody(request);
    },
    async getFile(key, filePath) {
      const request = await signedRequest(config, { key: scopeObjectKey(config, key), method: "GET", largeResponse: true });
      return writeResponseBodyToFile(request, filePath);
    },
    async getText(key) {
      const request = await signedRequest(config, { key: scopeObjectKey(config, key), method: "GET" });
      return (await readResponseBody(request)).toString("utf8");
    },
    async deletePrefix(prefix, options) {
      const scopedPrefix = scopeObjectKey(config, prefix);
      const keys = await listObjectKeys(config, scopedPrefix, options?.signal);
      await runWithConcurrency(
        keys,
        getObjectStoreDeleteConcurrency(),
        (key) => signedRequest(config, { key, method: "DELETE", signal: options?.signal }).then(() => undefined),
      );

      // A normal DELETE against a versioned bucket only creates a delete marker. Account and
      // meeting deletion must also remove every retained version (including delete markers),
      // otherwise private audio remains recoverable and the prefix keeps resurfacing in inventory.
      // R2 currently has no bucket versioning/ListObjectVersions API, so its strongly-consistent
      // current-object deletion is verified through ListObjectsV2 without calling an unsupported API.
      const versionAware = config.provider !== "r2";
      if (versionAware) {
        const versions = await listObjectVersions(config, scopedPrefix, options?.signal);
        await runWithConcurrency(
          versions,
          getObjectStoreDeleteConcurrency(),
          (version) => signedRequest(config, {
            key: version.key,
            method: "DELETE",
            query: new URLSearchParams({ versionId: version.versionId }),
            signal: options?.signal,
          }).then(() => undefined),
        );
      }

      const [remainingKeys, remainingVersions] = await Promise.all([
        listObjectKeys(config, scopedPrefix, options?.signal),
        versionAware ? listObjectVersions(config, scopedPrefix, options?.signal) : Promise.resolve([]),
      ]);
      if (remainingKeys.length > 0 || remainingVersions.length > 0) {
        throw new Error(
          `Object store prefix deletion left ${remainingKeys.length} current object(s) and ${remainingVersions.length} retained version(s).`,
        );
      }
    },
    async listTopLevelPrefixes() {
      const rootPrefix = config.keyPrefix ? `${config.keyPrefix}/` : "";
      const prefixes = await listObjectPrefixes(config, rootPrefix);
      return prefixes.map((prefix) => prefix.slice(rootPrefix.length).replace(/\/$/, "")).filter(Boolean);
    },
  };
}

const localMeetingObjectStore: MeetingObjectStore = {
  provider: "local",
  async putBuffer(key, value) {
    const filePath = resolveLocalObjectPath(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, value);
  },
  async putFile(key, sourcePath) {
    const filePath = resolveLocalObjectPath(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    await copyFile(sourcePath, filePath);
  },
  async putText(key, value) {
    const filePath = resolveLocalObjectPath(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, value, "utf8");
  },
  async createPresignedGetUrl() {
    return null;
  },
  async getBuffer(key) {
    return readFile(resolveLocalObjectPath(key));
  },
  async getFile(key, destinationPath) {
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await copyFile(resolveLocalObjectPath(key), destinationPath);
    await chmod(destinationPath, 0o600);
    return (await stat(destinationPath)).size;
  },
  async getText(key) {
    return readFile(resolveLocalObjectPath(key), "utf8");
  },
  async deletePrefix(prefix, options) {
    throwIfAborted(options?.signal);
    await rm(resolveLocalObjectPath(prefix), { recursive: true, force: true });
    throwIfAborted(options?.signal);
  },
  async listTopLevelPrefixes() {
    await mkdir(localMeetingsRoot, { recursive: true });
    const entries = await readdir(localMeetingsRoot, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  },
};

function resolveLocalObjectPath(key: string) {
  const safeKey = normalizeObjectKey(key);
  const resolved = path.resolve(localMeetingsRoot, safeKey);
  const root = path.resolve(localMeetingsRoot);

  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Invalid meeting object key.");
  }

  return resolved;
}

function normalizeObjectKey(key: string) {
  const normalized = key
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");

  if (!normalized || normalized.includes("..")) {
    throw new Error("Invalid meeting object key.");
  }

  return normalized;
}

async function listObjectKeys(config: S3CompatibleConfig, prefix: string, signal?: AbortSignal) {
  const keys: string[] = [];
  let continuationToken = "";
  const seenTokens = new Set<string>();
  let pages = 0;

  do {
    pages += 1;
    if (pages > 10_000) throw new Error("Object store listing exceeded the pagination limit.");
    const query = new URLSearchParams({
      "list-type": "2",
      prefix: `${prefix.replace(/\/$/, "")}/`,
    });
    if (continuationToken) query.set("continuation-token", continuationToken);

    const response = await signedRequest(config, {
      key: "",
      method: "GET",
      query,
      signal,
    });
    const xml = (await readResponseBody(response)).toString("utf8");
    if (!/<ListBucketResult(?:\s|>)/.test(xml)) throw new Error("Object store returned an invalid object listing response.");
    keys.push(...extractXmlValues(xml, "Key"));
    const truncated = extractXmlValues(xml, "IsTruncated")[0]?.trim().toLowerCase() === "true";
    if (!truncated) break;
    continuationToken = extractXmlValues(xml, "NextContinuationToken")[0] || "";
    if (!continuationToken) throw new Error("Object store listing omitted its continuation token.");
    if (continuationToken && seenTokens.has(continuationToken)) {
      throw new Error("Object store listing pagination did not make progress.");
    }
    if (continuationToken) seenTokens.add(continuationToken);
  } while (true);

  return keys;
}

type StoredObjectVersion = {
  key: string;
  versionId: string;
};

async function listObjectVersions(config: S3CompatibleConfig, prefix: string, signal?: AbortSignal) {
  const versions: StoredObjectVersion[] = [];
  let keyMarker = "";
  let versionIdMarker = "";
  const seenMarkers = new Set<string>();
  let pages = 0;

  do {
    pages += 1;
    if (pages > 10_000) throw new Error("Object store version listing exceeded the pagination limit.");
    const query = new URLSearchParams({
      prefix: `${prefix.replace(/\/$/, "")}/`,
      versions: "",
    });
    if (keyMarker) query.set("key-marker", keyMarker);
    if (versionIdMarker) query.set("version-id-marker", versionIdMarker);

    const response = await signedRequest(config, {
      key: "",
      method: "GET",
      query,
      signal,
    });
    const xml = (await readResponseBody(response)).toString("utf8");
    if (!/<ListVersionsResult(?:\s|>)/.test(xml)) {
      throw new Error("Object store returned an invalid version listing response.");
    }
    versions.push(...extractObjectVersions(xml));

    const truncated = extractXmlValues(xml, "IsTruncated")[0]?.trim().toLowerCase() === "true";
    if (!truncated) break;
    keyMarker = extractXmlValues(xml, "NextKeyMarker")[0] || "";
    versionIdMarker = extractXmlValues(xml, "NextVersionIdMarker")[0] || "";
    if (!keyMarker) throw new Error("Object store version listing omitted its next key marker.");
    const marker = `${keyMarker}\u0000${versionIdMarker}`;
    if (seenMarkers.has(marker)) throw new Error("Object store version listing pagination did not make progress.");
    seenMarkers.add(marker);
  } while (true);

  return versions;
}

async function listObjectPrefixes(config: S3CompatibleConfig, rootPrefix: string) {
  const prefixes: string[] = [];
  let continuationToken = "";
  const seenTokens = new Set<string>();
  let pages = 0;

  do {
    pages += 1;
    if (pages > 10_000) throw new Error("Object store prefix listing exceeded the pagination limit.");
    const query = new URLSearchParams({
      delimiter: "/",
      "list-type": "2",
    });
    if (rootPrefix) query.set("prefix", rootPrefix);
    if (continuationToken) query.set("continuation-token", continuationToken);

    const response = await signedRequest(config, {
      key: "",
      method: "GET",
      query,
    });
    const xml = (await readResponseBody(response)).toString("utf8");
    if (!/<ListBucketResult(?:\s|>)/.test(xml)) {
      throw new Error("Object store returned an invalid prefix listing response.");
    }
    prefixes.push(...extractCommonPrefixValues(xml));
    const truncated = extractXmlValues(xml, "IsTruncated")[0]?.trim().toLowerCase() === "true";
    if (!truncated) break;
    continuationToken = extractXmlValues(xml, "NextContinuationToken")[0] || "";
    if (!continuationToken) throw new Error("Object store prefix listing omitted its continuation token.");
    if (continuationToken && seenTokens.has(continuationToken)) {
      throw new Error("Object store prefix listing pagination did not make progress.");
    }
    if (continuationToken) seenTokens.add(continuationToken);
  } while (true);

  return [...new Set(prefixes)];
}

function getStorageKeyPrefix() {
  const configured = getEnv("OWNMINUTES_STORAGE_PREFIX").trim();
  return configured ? normalizeObjectKey(configured) : "";
}

function scopeObjectKey(config: S3CompatibleConfig, key: string) {
  const normalized = normalizeObjectKey(key);
  return config.keyPrefix ? `${config.keyPrefix}/${normalized}` : normalized;
}

async function signedRequest(
  config: S3CompatibleConfig,
  input: {
    body?: Buffer;
    bodyFile?: {
      filePath: string;
      payloadHash: string;
      size: number;
    };
    headers?: Record<string, string>;
    key: string;
    method: "DELETE" | "GET" | "PUT";
    query?: URLSearchParams;
    signal?: AbortSignal;
    largeResponse?: boolean;
  },
) {
  const key = input.key ? normalizeObjectKey(input.key) : "";
  const url = buildObjectUrl(config, key, input.query);
  const body = input.body;
  const bodyFile = input.bodyFile;
  if (body && bodyFile) throw new Error("Object store request cannot use both a buffer and a file body.");
  const requestHeaders = { ...input.headers };
  if (bodyFile) requestHeaders["content-length"] = String(bodyFile.size);
  const headers = signAwsV4({
    accessKeyId: config.accessKeyId,
    body,
    headers: requestHeaders,
    method: input.method,
    payloadHash: bodyFile?.payloadHash,
    region: config.region,
    secretAccessKey: config.secretAccessKey,
    service: config.service,
    url,
  });
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(input.signal?.reason ?? new Error("Object store request was cancelled."));
  if (input.signal?.aborted) abortFromCaller();
  else input.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const headerTimer = setTimeout(
    () => controller.abort(new Error("Object store response headers timed out.")),
    getObjectStoreHeaderTimeoutMs(),
  );
  headerTimer.unref?.();
  const totalTimer = setTimeout(
    () => controller.abort(new Error("Object store request exceeded its total duration.")),
    input.largeResponse || Boolean(bodyFile) ? getObjectStoreLargeTransferTimeoutMs() : getObjectStoreSmallTransferTimeoutMs(),
  );
  totalTimer.unref?.();
  const request: RequestInit & { duplex?: "half" } = {
    method: input.method,
    headers,
    body: body ? new Uint8Array(body) : bodyFile ? (createReadStream(bodyFile.filePath) as unknown as BodyInit) : undefined,
    signal: controller.signal,
  };
  if (bodyFile) request.duplex = "half";
  let response: Response;
  try {
    response = await fetch(url, request);
  } catch (error) {
    clearTimeout(headerTimer);
    clearTimeout(totalTimer);
    input.signal?.removeEventListener("abort", abortFromCaller);
    throw normalizeObjectStoreAbort(error, controller.signal.reason);
  }
  clearTimeout(headerTimer);

  const lifecycle: SignedRequestLifecycle = {
    abort(reason?: unknown) {
      controller.abort(reason ?? new Error("Object store response consumption was cancelled."));
    },
    finish() {
      clearTimeout(totalTimer);
      input.signal?.removeEventListener("abort", abortFromCaller);
    },
    response,
    signal: controller.signal,
  };

  if (!response.ok) {
    let text = "";
    try {
      text = (await readResponseBody(lifecycle, { allowEmpty: true, maxBytes: 16_384 })).toString("utf8");
    } catch (error) {
      lifecycle.finish();
      throw error;
    }
    throw new MeetingObjectStoreHttpError(input.method, response.status, text);
  }

  if (input.method !== "GET") lifecycle.finish();
  return lifecycle;
}

type SignedRequestLifecycle = {
  abort(reason?: unknown): void;
  finish(): void;
  response: Response;
  signal: AbortSignal;
};

async function readResponseBody(
  request: SignedRequestLifecycle,
  options: { allowEmpty?: boolean; maxBytes?: number } = {},
) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  await consumeResponseBody(request, async (chunk) => {
    bytes += chunk.byteLength;
    if (options.maxBytes && bytes > options.maxBytes) {
      throw new Error("Object store response exceeded the allowed in-memory size.");
    }
    chunks.push(chunk);
  });
  if (bytes <= 0 && !options.allowEmpty) throw new Error("Object store GET returned an empty response body.");
  return Buffer.concat(chunks, bytes);
}

async function writeResponseBodyToFile(request: SignedRequestLifecycle, filePath: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const file = await open(filePath, "wx", 0o600);
  let bytes = 0;
  try {
    await consumeResponseBody(request, async (chunk) => {
      await writeAll(file, chunk);
      bytes += chunk.byteLength;
    });
    await file.sync();
    await file.close();
    if (bytes <= 0) throw new Error("Object store GET returned an empty file.");
    return bytes;
  } catch (error) {
    await file.close().catch(() => undefined);
    await rm(filePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function consumeResponseBody(request: SignedRequestLifecycle, consume: (chunk: Buffer) => Promise<void>) {
  const body = request.response.body;
  if (!body) {
    request.finish();
    throw new Error("Object store GET returned an empty response body.");
  }
  const reader = body.getReader();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => request.abort(new Error("Object store response body stalled.")),
      getObjectStoreIdleTimeoutMs(),
    );
    idleTimer.unref?.();
  };
  try {
    armIdleTimer();
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      armIdleTimer();
      await consume(Buffer.from(item.value));
    }
  } catch (error) {
    request.abort(error);
    await reader.cancel().catch(() => undefined);
    throw normalizeObjectStoreAbort(error, request.signal.reason);
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    request.finish();
  }
}

function getObjectStoreHeaderTimeoutMs() {
  return boundedObjectStoreTimeout("OWNMINUTES_OBJECT_STORE_HEADER_TIMEOUT_MS", 2_000, 250, 120_000);
}

function getObjectStoreSmallTransferTimeoutMs() {
  return boundedObjectStoreTimeout("OWNMINUTES_OBJECT_STORE_SMALL_TRANSFER_TIMEOUT_MS", 4_000, 500, 300_000);
}

function getObjectStoreLargeTransferTimeoutMs() {
  return boundedObjectStoreTimeout("OWNMINUTES_OBJECT_STORE_LARGE_TRANSFER_TIMEOUT_MS", 15 * 60_000, 1_000, 60 * 60_000);
}

function getObjectStoreIdleTimeoutMs() {
  return boundedObjectStoreTimeout("OWNMINUTES_OBJECT_STORE_IDLE_TIMEOUT_MS", 30_000, 250, 300_000);
}

function getObjectStoreDeleteConcurrency() {
  return boundedObjectStoreTimeout("OWNMINUTES_OBJECT_STORE_DELETE_CONCURRENCY", 8, 1, 32);
}

function boundedObjectStoreTimeout(name: string, fallback: number, minimum: number, maximum: number) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
) {
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function normalizeObjectStoreAbort(error: unknown, reason: unknown) {
  if (reason instanceof Error) return reason;
  if (error instanceof Error) return error;
  return new Error("Object store request was aborted.");
}

function sanitizeReadinessError(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback;
  return error.message
    .replace(/AKL[A-Za-z0-9]+/g, "[redacted]")
    .replace(/(?:secret|token|password|credential)=[^\s&]+/gi, "$1=[redacted]")
    .slice(0, 240) || fallback;
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Object store operation was cancelled.");
}

async function writeAll(file: Awaited<ReturnType<typeof open>>, buffer: Buffer) {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await file.write(buffer, offset, buffer.byteLength - offset, null);
    if (bytesWritten <= 0) throw new Error("Could not persist the downloaded meeting object.");
    offset += bytesWritten;
  }
}

function buildObjectUrl(config: S3CompatibleConfig, key: string, query?: URLSearchParams) {
  const endpoint = config.endpoint.replace(/\/$/, "");
  const keyPath = key ? `/${encodeObjectKey(key)}` : "";
  const url = new URL(`${endpoint}/${encodeURIComponent(config.bucket)}${keyPath}`);
  if (query) {
    for (const [name, value] of query.entries()) {
      url.searchParams.set(name, value);
    }
  }
  return url;
}

function presignAwsV4Get(config: S3CompatibleConfig, key: string, expiresSeconds: number) {
  const expires = Math.min(3_600, Math.max(60, Math.round(expiresSeconds)));
  const now = new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${config.region}/${config.service}/aws4_request`;
  const url = buildObjectUrl(config, key);
  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  url.searchParams.set("X-Amz-Credential", `${config.accessKeyId}/${credentialScope}`);
  url.searchParams.set("X-Amz-Date", amzDate);
  url.searchParams.set("X-Amz-Expires", String(expires));
  url.searchParams.set("X-Amz-SignedHeaders", "host");

  const canonicalRequest = [
    "GET",
    url.pathname,
    canonicalizeSearchParams(url.searchParams),
    `host:${url.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(Buffer.from(canonicalRequest, "utf8")),
  ].join("\n");
  const signingKey = getAwsV4SigningKey(config.secretAccessKey, dateStamp, config.region, config.service);
  url.searchParams.set("X-Amz-Signature", crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex"));
  return url.toString();
}

function signAwsV4(input: {
  accessKeyId: string;
  body?: Buffer;
  headers: Record<string, string>;
  method: string;
  payloadHash?: string;
  region: string;
  secretAccessKey: string;
  service: string;
  url: URL;
}) {
  const now = new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = input.payloadHash ?? sha256Hex(input.body ?? Buffer.alloc(0));
  const headers = new Headers(input.headers);

  headers.set("host", input.url.host);
  headers.set("x-amz-content-sha256", payloadHash);
  headers.set("x-amz-date", amzDate);

  const signedHeaderNames = [...headers.keys()].map((name) => name.toLowerCase()).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers.get(name)?.trim() ?? ""}\n`).join("");
  const canonicalQuery = canonicalizeSearchParams(input.url.searchParams);
  const canonicalRequest = [
    input.method.toUpperCase(),
    input.url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaderNames.join(";"),
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(Buffer.from(canonicalRequest, "utf8")),
  ].join("\n");
  const signingKey = getAwsV4SigningKey(input.secretAccessKey, dateStamp, input.region, input.service);
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  headers.set(
    "authorization",
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaderNames.join(";")}, Signature=${signature}`,
  );

  return headers;
}

function getAwsV4SigningKey(secretAccessKey: string, dateStamp: string, region: string, service: string) {
  const dateKey = hmac(Buffer.from(`AWS4${secretAccessKey}`, "utf8"), dateStamp);
  const dateRegionKey = hmac(dateKey, region);
  const dateRegionServiceKey = hmac(dateRegionKey, service);
  return hmac(dateRegionServiceKey, "aws4_request");
}

function canonicalizeSearchParams(params: URLSearchParams) {
  return [...params.entries()]
    .sort(([leftName, leftValue], [rightName, rightValue]) => {
      const byName = leftName.localeCompare(rightName);
      return byName || leftValue.localeCompare(rightValue);
    })
    .map(([name, value]) => `${encodeRfc3986(name)}=${encodeRfc3986(value)}`)
    .join("&");
}

function encodeObjectKey(key: string) {
  return key.split("/").map(encodeRfc3986).join("/");
}

function encodeRfc3986(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function extractXmlValues(xml: string, tagName: string) {
  const values: string[] = [];
  const pattern = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "g");
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(xml))) {
    values.push(decodeXml(match[1] ?? ""));
  }

  return values;
}

function extractCommonPrefixValues(xml: string) {
  const values: string[] = [];
  const blockPattern = /<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = blockPattern.exec(xml))) {
    values.push(...extractXmlValues(blockMatch[1] ?? "", "Prefix"));
  }

  return values;
}

function extractObjectVersions(xml: string) {
  const versions: StoredObjectVersion[] = [];
  const blockPattern = /<(?:Version|DeleteMarker)>([\s\S]*?)<\/(?:Version|DeleteMarker)>/g;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = blockPattern.exec(xml))) {
    const block = blockMatch[1] ?? "";
    const key = extractXmlValues(block, "Key")[0] || "";
    const versionId = extractXmlValues(block, "VersionId")[0] || "";
    if (!key || !versionId) throw new Error("Object store version listing contained an incomplete entry.");
    versions.push({ key, versionId });
  }

  return versions;
}

function decodeXml(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    // Decode ampersands last so an encoded entity such as &amp;quot; remains
    // the literal text "&quot;" instead of being decoded twice.
    .replace(/&amp;/g, "&");
}

function isRemoteConfigComplete(config: S3CompatibleConfig) {
  return Boolean(config.bucket && config.endpoint && config.accessKeyId && config.secretAccessKey);
}

function getEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return "";
}

function hasAnyEnv(names: string[]) {
  return names.some((name) => Boolean(process.env[name]));
}

function hmac(key: Buffer, value: string) {
  return crypto.createHmac("sha256", key).update(value).digest();
}

function sha256Hex(value: Buffer) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath: string) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function toAmzDate(date: Date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}
