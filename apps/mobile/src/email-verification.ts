export function extractEmailVerificationToken(value: string) {
  const trimmed = value.trim();
  if (/^[A-Za-z0-9_-]{24,128}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.pathname !== "/verify-email") return "";
    const fragmentParams = new URLSearchParams(url.hash.replace(/^#/, ""));
    const token = fragmentParams.get("token") || url.searchParams.get("token") || "";
    return /^[A-Za-z0-9_-]{24,128}$/.test(token) ? token : "";
  } catch {
    return "";
  }
}
