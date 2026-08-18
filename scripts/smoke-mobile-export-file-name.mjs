#!/usr/bin/env node

const { buildMarkdownExportFileName } = await import("../apps/mobile/src/export-file-name.ts");

const chineseTitle = buildMarkdownExportFileName("产品周会", "meeting-1");
const unsafeTitle = buildMarkdownExportFileName('  路线图 / Q3: "发布"?  ', "meeting-2");
const traversalTitle = buildMarkdownExportFileName("../../客户访谈", "meeting-3");
const emptyTitle = buildMarkdownExportFileName("...   ", "meeting-abc-123");
const longTitle = buildMarkdownExportFileName("长".repeat(120), "meeting-4");

const checks = {
  preservesReadableChineseTitle: chineseTitle === "产品周会.md",
  replacesFileSystemReservedCharacters: unsafeTitle === "路线图 - Q3- -发布--.md",
  preventsPathTraversal: !traversalTitle.includes("../") && !traversalTitle.includes("/"),
  usesStableFallback: emptyTitle === "OwnMinutes-meeting-abc-123.md",
  boundsFileNameLength: [...longTitle.replace(/\.md$/, "")].length === 80 && longTitle.endsWith(".md"),
};

console.log(JSON.stringify(checks, null, 2));

if (Object.values(checks).some((value) => !value)) process.exitCode = 1;
