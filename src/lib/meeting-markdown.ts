export type MeetingMarkdownMetadata = {
  participants: string[];
  project?: string;
  tags: string[];
  title?: string;
};

export function applyMeetingMetadataToMarkdown(markdown: string, metadata: MeetingMarkdownMetadata) {
  const project = metadata.project?.trim();
  const title = metadata.title?.replace(/\s+/g, " ").trim();
  const participants = metadata.participants.map((participant) => participant.replace(/\s+/g, " ").trim()).filter(Boolean);
  const customTags = metadata.tags.map((tag) => tag.trim().replace(/^#/, "")).filter(Boolean);
  const tags = Array.from(new Set(["meeting", ...customTags]));
  let nextMarkdown = markdown.trim();

  if (title) {
    nextMarkdown = nextMarkdown.replace(/^# .*$/m, `# ${title}`);
  }

  if (project) {
    nextMarkdown = replaceFrontmatterField(nextMarkdown, "project", project);
  }

  if (tags.length) {
    nextMarkdown = replaceFrontmatterBlock(nextMarkdown, "tags", tags.map((tag) => `  - ${tag}`).join("\n"));
  }

  if (participants.length) {
    nextMarkdown = replaceFrontmatterBlock(nextMarkdown, "participants", participants.map((participant) => `  - ${participant}`).join("\n"));
  }

  nextMarkdown = replaceMeetingInfoLine(nextMarkdown, "项目", project || "未分类");
  nextMarkdown = replaceMeetingInfoLine(nextMarkdown, "参会人", participants.join("、") || "未填写");

  return `${nextMarkdown}\n`;
}

function replaceMeetingInfoLine(markdown: string, label: string, value: string) {
  const line = `${label}：${value}`;
  const linePattern = new RegExp(`^${label}：.*$`, "m");
  if (linePattern.test(markdown)) return markdown.replace(linePattern, line);

  return markdown.replace(/^(# .*\n)/m, `$1\n${line}\n`);
}

function replaceFrontmatterField(markdown: string, field: string, value: string) {
  const escapedValue = value.replace(/\n/g, " ").trim();
  const fieldPattern = new RegExp(`^${field}:.*$`, "m");
  if (fieldPattern.test(markdown)) {
    return markdown.replace(fieldPattern, `${field}: ${escapedValue}`);
  }

  return markdown.replace(/^---\n/, `---\n${field}: ${escapedValue}\n`);
}

function replaceFrontmatterBlock(markdown: string, field: string, value: string) {
  const blockPattern = new RegExp(`^${field}:\\n(?:  - .*\\n?)*`, "m");
  if (blockPattern.test(markdown)) {
    return markdown.replace(blockPattern, `${field}:\n${value}\n`);
  }

  return markdown.replace(/^---\n/, `---\n${field}:\n${value}\n`);
}
