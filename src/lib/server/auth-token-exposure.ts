export function canExposeLocalAuthToken(request: Request) {
  const host = request.headers.get("host") || "";
  const explicitlyEnabled = process.env.OWNMINUTES_ALLOW_LOCAL_AUTH_TOKEN_RESPONSE === "1";
  return explicitlyEnabled && (host.startsWith("127.0.0.1") || host.startsWith("localhost") || host.startsWith("[::1]"));
}
