#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const inputPath = path.resolve(process.env.OWNMINUTES_ACCOUNT_CLEANUP_REPLAY_INPUT_FILE || "");
const confirmation = process.env.OWNMINUTES_ACCOUNT_CLEANUP_REPLAY_CONFIRM || "";
const approvedBy = process.env.OWNMINUTES_ACCOUNT_CLEANUP_REPLAY_OPERATOR || "";

if (!process.env.OWNMINUTES_ACCOUNT_CLEANUP_REPLAY_INPUT_FILE || !fs.existsSync(inputPath)) {
  throw new Error("Set OWNMINUTES_ACCOUNT_CLEANUP_REPLAY_INPUT_FILE to a private 0600 JSON review file.");
}
if ((fs.statSync(inputPath).mode & 0o077) !== 0) {
  throw new Error("Account cleanup replay input must not be group/world readable.");
}
if (confirmation !== "RETRY_DEAD_LETTERED_ACCOUNT_CLEANUP") {
  throw new Error("Set OWNMINUTES_ACCOUNT_CLEANUP_REPLAY_CONFIRM=RETRY_DEAD_LETTERED_ACCOUNT_CLEANUP after completing the runbook review.");
}
if (!/^[A-Za-z0-9_.@ -]{3,80}$/.test(approvedBy)) {
  throw new Error("Set a bounded OWNMINUTES_ACCOUNT_CLEANUP_REPLAY_OPERATOR label for the audit record.");
}

const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const jiti = require("jiti")(path.join(process.cwd(), "scripts", "account-deletion-replay-loader.cjs"), {
  interopDefault: true,
  alias: { "@": path.join(process.cwd(), "src") },
});
const { replayDeadLetteredAccountDeletionCleanup } = jiti("../src/lib/server/account-deletion-cleanup-worker.ts");

try {
  const result = await replayDeadLetteredAccountDeletionCleanup({
    approvedBy,
    userId: String(input?.userId || ""),
  });
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  process.exit(0);
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : "Account cleanup replay failed.",
  }, null, 2));
  process.exit(1);
}
