export function isProviderAccessibleAsrAudioUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== "https:" || url.username || url.password || url.hash) return false;
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname || (hostname !== "::1" && !hostname.includes(".") && !hostname.includes(":"))) return false;
  if (hostname === "localhost") return false;
  if ([".local", ".internal", ".localhost", ".lan", ".home", ".test", ".invalid"].some((suffix) => hostname.endsWith(suffix))) {
    return false;
  }

  const ipv4 = parseIpv4(hostname.startsWith("::ffff:") ? hostname.slice(7) : hostname);
  if (ipv4) return !isPrivateOrReservedIpv4(ipv4);
  if (hostname.includes(":")) return !isPrivateIpv6(hostname);
  return true;
}

function parseIpv4(hostname: string) {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function isPrivateOrReservedIpv4([first, second]: number[]) {
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19))
  );
}

function isPrivateIpv6(hostname: string) {
  return hostname === "::" || hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || /^fe[89ab]/.test(hostname);
}
