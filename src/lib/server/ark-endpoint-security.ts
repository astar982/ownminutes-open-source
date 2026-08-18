import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import net, { type LookupFunction } from "node:net";

const DEFAULT_ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const OFFICIAL_ARK_HOSTS = new Set(["ark.cn-beijing.volces.com"]);
const MAX_ARK_REQUEST_BYTES = 8 * 1024 * 1024;

export class ArkEndpointSecurityError extends Error {
  readonly code:
    | "ark_dns_resolution_failed"
    | "ark_endpoint_forbidden"
    | "ark_endpoint_redirect_forbidden"
    | "ark_private_address_forbidden"
    | "ark_response_too_large";

  constructor(code: ArkEndpointSecurityError["code"], message: string) {
    super(message);
    this.name = "ArkEndpointSecurityError";
    this.code = code;
  }
}

export type ArkHttpResult = {
  bodyText: string;
  ok: boolean;
  status: number;
};

export function getDefaultArkBaseUrl() {
  return DEFAULT_ARK_BASE_URL;
}

export function validateArkBaseUrlStructure(input?: string) {
  const candidate = (input || DEFAULT_ARK_BASE_URL).trim();
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false as const, reason: "Ark Base URL 格式无效。" };
  }

  const authority = candidate.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]+)/i)?.[1]?.toLowerCase() ?? "";
  const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
  const official =
    url.protocol === "https:" &&
    OFFICIAL_ARK_HOSTS.has(url.hostname.toLowerCase()) &&
    authority === url.hostname.toLowerCase() &&
    !url.username &&
    !url.password &&
    !url.port &&
    !url.search &&
    !url.hash &&
    normalizedPath === "/api/v3";
  if (official) {
    return {
      ok: true as const,
      url: new URL(`https://${url.hostname.toLowerCase()}/api/v3`),
      testOnly: false,
    };
  }

  if (isExplicitLoopbackTestAllowed(url, authority)) {
    return {
      ok: true as const,
      url: new URL(`${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}${normalizedPath}`),
      testOnly: true,
    };
  }

  return {
    ok: false as const,
    reason: "Ark Base URL 只允许官方 HTTPS API 地址，且不得包含凭据、端口、查询或片段。",
  };
}

export async function postArkJson(input: {
  apiKey: string;
  baseUrl?: string;
  body: unknown;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}) {
  const validated = validateArkBaseUrlStructure(input.baseUrl);
  if (!validated.ok) {
    throw new ArkEndpointSecurityError("ark_endpoint_forbidden", validated.reason);
  }

  const addresses = await resolveAndValidateAddresses(validated.url.hostname, validated.testOnly);
  const endpoint = new URL(`${validated.url.toString().replace(/\/$/, "")}/chat/completions`);
  const body = Buffer.from(JSON.stringify(input.body), "utf8");
  if (body.byteLength > MAX_ARK_REQUEST_BYTES) {
    throw new ArkEndpointSecurityError("ark_endpoint_forbidden", "Ark 请求体超过安全上限。");
  }
  return requestPinnedJson({
    addresses,
    apiKey: input.apiKey,
    body,
    endpoint,
    maxResponseBytes: boundedMaxResponseBytes(input.maxResponseBytes),
    signal: input.signal,
  });
}

export function isPublicArkAddress(address: string) {
  const family = net.isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

async function resolveAndValidateAddresses(hostname: string, testOnly: boolean) {
  if (net.isIP(hostname)) {
    if (testOnly && isLoopbackAddress(hostname)) {
      return [{ address: hostname, family: net.isIP(hostname) as 4 | 6 }];
    }
    if (!isPublicArkAddress(hostname)) {
      throw new ArkEndpointSecurityError("ark_private_address_forbidden", "Ark endpoint 不能解析到私网或保留地址。");
    }
    return [{ address: hostname, family: net.isIP(hostname) as 4 | 6 }];
  }

  let records: Array<{ address: string; family: 4 | 6 }>;
  try {
    records = await lookup(hostname, { all: true, verbatim: true }) as Array<{ address: string; family: 4 | 6 }>;
  } catch {
    throw new ArkEndpointSecurityError("ark_dns_resolution_failed", "Ark 官方域名解析失败。");
  }
  if (records.length === 0) {
    throw new ArkEndpointSecurityError("ark_dns_resolution_failed", "Ark 官方域名没有可用地址。");
  }
  if (records.some((record) => !isPublicArkAddress(record.address))) {
    throw new ArkEndpointSecurityError("ark_private_address_forbidden", "Ark endpoint 不能解析到私网或保留地址。");
  }
  return records;
}

function requestPinnedJson(input: {
  addresses: Array<{ address: string; family: number }>;
  apiKey: string;
  body: Buffer;
  endpoint: URL;
  maxResponseBytes: number;
  signal?: AbortSignal;
}): Promise<ArkHttpResult> {
  const lookupPinned: LookupFunction = (_hostname, options, callback) => {
    const family = options.family === 4 || options.family === 6 ? options.family : 0;
    const addresses = family ? input.addresses.filter((item) => item.family === family) : input.addresses;
    if (addresses.length === 0) {
      const error = new Error("No validated Ark address matches the requested family.") as NodeJS.ErrnoException;
      error.code = "ENOTFOUND";
      callback(error, "", family || undefined);
      return;
    }
    if (options.all) {
      callback(null, addresses);
      return;
    }
    callback(null, addresses[0].address, addresses[0].family);
  };
  const requestOptions = {
    protocol: input.endpoint.protocol,
    hostname: input.endpoint.hostname,
    port: input.endpoint.protocol === "https:" ? 443 : Number(input.endpoint.port || 80),
    method: "POST",
    path: `${input.endpoint.pathname}${input.endpoint.search}`,
    lookup: lookupPinned,
    signal: input.signal,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Length": String(input.body.byteLength),
      "Content-Type": "application/json",
      "User-Agent": "OwnMinutes/ark-client",
    },
  };

  return new Promise((resolve, reject) => {
    const request = input.endpoint.protocol === "https:"
      ? httpsRequest({ ...requestOptions, servername: input.endpoint.hostname }, handleResponse)
      : httpRequest(requestOptions, handleResponse);
    request.once("error", reject);
    request.end(input.body);

    function handleResponse(response: import("node:http").IncomingMessage) {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        response.resume();
        reject(
          new ArkEndpointSecurityError(
            "ark_endpoint_redirect_forbidden",
            "Ark endpoint 返回了重定向，已按安全策略拒绝。",
          ),
        );
        return;
      }
      const declaredLength = Number(response.headers["content-length"] || 0);
      if (Number.isFinite(declaredLength) && declaredLength > input.maxResponseBytes) {
        response.destroy();
        reject(new ArkEndpointSecurityError("ark_response_too_large", "Ark 响应超过安全上限。"));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > input.maxResponseBytes) {
          response.destroy(new ArkEndpointSecurityError("ark_response_too_large", "Ark 响应超过安全上限。"));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.once("error", reject);
      response.once("end", () => {
        resolve({
          bodyText: Buffer.concat(chunks, bytes).toString("utf8"),
          ok: status >= 200 && status < 300,
          status,
        });
      });
    }
  });
}

function isExplicitLoopbackTestAllowed(url: URL, authority: string) {
  if (process.env.NODE_ENV === "production" || process.env.OWNMINUTES_ALLOW_UNSAFE_ARK_LOOPBACK_TEST !== "1") {
    return false;
  }
  const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    isLoopbackAddress(url.hostname) &&
    authority === `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}` &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    normalizedPath.length <= 120
  );
}

function isLoopbackAddress(address: string) {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}

function isPublicIpv4(address: string) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function isPublicIpv6(address: string) {
  const normalized = address.toLowerCase().split("%")[0];
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isPublicIpv4(mapped);
  if (normalized === "::" || normalized === "::1") return false;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return false;
  if (/^fe[89ab]/.test(normalized)) return false;
  if (normalized.startsWith("ff")) return false;
  if (normalized.startsWith("2001:db8:")) return false;
  if (normalized.startsWith("2001:10:") || normalized.startsWith("2001:2:")) return false;
  return /^[23][0-9a-f]{3}:/.test(normalized);
}

function boundedMaxResponseBytes(value?: number) {
  if (!Number.isFinite(value)) return 2 * 1024 * 1024;
  return Math.max(1024, Math.min(4 * 1024 * 1024, Math.round(value!)));
}
