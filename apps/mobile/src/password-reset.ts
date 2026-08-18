export function extractPasswordResetToken(value: string) {
  const trimmed = value.trim();
  if (/^[A-Za-z0-9_-]{24,128}$/.test(trimmed)) return trimmed;

  try {
    const parsed = new URL(trimmed);
    if (parsed.pathname.replace(/^\/+|\/+$/g, "") !== "reset-password") return null;
    const fragmentParams = new URLSearchParams(parsed.hash.replace(/^#/, ""));
    const token = (fragmentParams.get("token") || parsed.searchParams.get("token") || "").trim();
    return /^[A-Za-z0-9_-]{24,128}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}
