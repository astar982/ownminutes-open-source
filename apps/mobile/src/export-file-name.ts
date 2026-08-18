export function buildMarkdownExportFileName(title: string, meetingId: string) {
  const normalizedTitle = title
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/g, "");
  const fallbackId = meetingId.replace(/[^a-zA-Z0-9_-]/g, "").slice(-24) || "meeting";
  return `${normalizedTitle || `OwnMinutes-${fallbackId}`}.md`;
}
