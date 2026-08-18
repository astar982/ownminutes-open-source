import { isRequestFromConfiguredTrustedProxy } from "@/lib/server/auth-client-identity";

export function getSafeRequestOrigin(request: Request) {
  const url = new URL(request.url);
  if (!isRequestFromConfiguredTrustedProxy(request)) return url.origin;

  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host")?.trim() || url.host;
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProto === "https" || forwardedProto === "http"
    ? forwardedProto
    : url.protocol.replace(":", "");
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return url.origin;
  }
}

export function buildSafeSameOriginUrl(request: Request, pathname: string) {
  return new URL(pathname, getSafeRequestOrigin(request));
}

export function isSafeExternalHttps(request: Request) {
  return new URL(getSafeRequestOrigin(request)).protocol === "https:";
}
