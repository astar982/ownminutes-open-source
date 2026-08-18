import net from "node:net";

export function getAuthRateLimitClientIp(request: Request) {
  if (isRequestFromConfiguredTrustedProxy(request)) {
    return normalizeIp(request.headers.get("x-ownminutes-client-ip")) || "trusted-proxy-unknown";
  }

  if (isExplicitLocalProxyTest(request)) {
    return normalizeIp(request.headers.get("x-forwarded-for")?.split(",")[0]) || "loopback";
  }
  return "untrusted-proxy";
}

export function isRequestFromConfiguredTrustedProxy(request: Request) {
  if (process.env.OWNMINUTES_TRUST_PROXY_HEADERS !== "1") return false;
  const trustedSource = request.headers.get("x-ownminutes-proxy-source")?.trim() || "";
  return Boolean(trustedSource && isConfiguredTrustedProxySource(trustedSource));
}

export function isConfiguredTrustedProxySource(source: string) {
  const configured = (process.env.OWNMINUTES_TRUSTED_PROXY_SOURCES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (configured.length === 0) return false;

  const normalizedSource = normalizeIp(source);
  if (!normalizedSource) {
    return /^[a-zA-Z0-9._-]{1,64}$/.test(source) &&
      configured.some((value) => value.toLowerCase() === source.toLowerCase());
  }

  for (const allowed of configured) {
    if (ipMatchesSource(normalizedSource, allowed)) return true;
  }
  return false;
}

function isExplicitLocalProxyTest(request: Request) {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.OWNMINUTES_TRUST_LOOPBACK_PROXY_HEADERS !== "1"
  ) {
    return false;
  }
  const hostname = normalizeHost(request.headers.get("host") || new URL(request.url).hostname);
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function ipMatchesSource(source: string, allowed: string) {
  const [networkValue, prefixValue] = allowed.split("/", 2);
  const network = normalizeIp(networkValue);
  if (!network) return false;
  if (prefixValue === undefined) return source === network;
  const prefix = Number(prefixValue);
  const family = net.isIP(network);
  const sourceFamily = net.isIP(source);
  const maxPrefix = family === 4 ? 32 : 128;
  if (family !== sourceFamily || !Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) return false;
  try {
    const blockList = new net.BlockList();
    blockList.addSubnet(network, prefix, family === 4 ? "ipv4" : "ipv6");
    return blockList.check(source, family === 4 ? "ipv4" : "ipv6");
  } catch {
    return false;
  }
}

function normalizeHost(value: string) {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith("[")) return trimmed.slice(1, trimmed.indexOf("]"));
  return trimmed.split(":")[0];
}

function normalizeIp(value: string | null | undefined) {
  const candidate = value?.trim().replace(/^\[|\]$/g, "") || "";
  return net.isIP(candidate) ? candidate : "";
}
