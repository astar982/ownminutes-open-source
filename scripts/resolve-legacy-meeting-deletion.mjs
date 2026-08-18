#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const inputPath = path.resolve(process.env.OWNMINUTES_LEGACY_CLEANUP_INPUT_FILE || "");
const confirmation = process.env.OWNMINUTES_LEGACY_CLEANUP_CONFIRM || "";
const approvedBy = process.env.OWNMINUTES_LEGACY_CLEANUP_OPERATOR || "";

if (!process.env.OWNMINUTES_LEGACY_CLEANUP_INPUT_FILE || !fs.existsSync(inputPath)) {
  throw new Error("Set OWNMINUTES_LEGACY_CLEANUP_INPUT_FILE to a private 0600 JSON review file.");
}
if ((fs.statSync(inputPath).mode & 0o077) !== 0) {
  throw new Error("Legacy cleanup review input must not be group/world readable.");
}
if (confirmation !== "DELETE_EXACT_OWNER_VERIFIED_PREFIX") {
  throw new Error("Set OWNMINUTES_LEGACY_CLEANUP_CONFIRM=DELETE_EXACT_OWNER_VERIFIED_PREFIX after completing the runbook review.");
}
if (!/^[A-Za-z0-9_.@ -]{3,80}$/.test(approvedBy)) {
  throw new Error("Set a bounded OWNMINUTES_LEGACY_CLEANUP_OPERATOR label for the audit record.");
}

const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const jiti = require("jiti")(path.join(process.cwd(), "scripts", "legacy-deletion-resolver-loader.cjs"), {
  interopDefault: true,
  alias: { "@": path.join(process.cwd(), "src") },
});
const { resolveLegacyMeetingDeletionCleanup } = jiti("../src/lib/server/legacy-deletion-cleanup.ts");

try {
  const result = await resolveLegacyMeetingDeletionCleanup({
    approvedBy,
    meetingId: String(input?.meetingId || ""),
    ownerUserId: String(input?.ownerUserId || ""),
  });
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  process.exit(0);
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : "Legacy cleanup resolution failed.",
  }, null, 2));
  process.exit(1);
}
