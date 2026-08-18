#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { inspectIosAppBundle } from "./lib/ios-appstore-compliance.mjs";

const directAppPath = process.env.OWNMINUTES_IOS_COMPLIANCE_APP_PATH?.trim();
const ipaPath = process.env.OWNMINUTES_IOS_COMPLIANCE_IPA_PATH?.trim();
const evidencePath = resolve(process.env.OWNMINUTES_IOS_COMPLIANCE_EVIDENCE_PATH || ".data/acceptance/ios-appstore-compliance-latest.json");
const extractRoot = join(tmpdir(), "ownminutes-ios-compliance");
let appPath;
let source;
let artifact = null;

try {
  if (directAppPath) {
    appPath = resolve(directAppPath);
    source = "app-bundle";
    if (!existsSync(appPath) || !appPath.endsWith(".app")) throw new Error("OWNMINUTES_IOS_COMPLIANCE_APP_PATH must point to an existing .app bundle");
  } else {
    if (!ipaPath) throw new Error("Set OWNMINUTES_IOS_COMPLIANCE_IPA_PATH to a private IPA, or OWNMINUTES_IOS_COMPLIANCE_APP_PATH to a local .app bundle");
    const absoluteIpa = resolve(ipaPath);
    if (!existsSync(absoluteIpa) || !absoluteIpa.endsWith(".ipa")) throw new Error("OWNMINUTES_IOS_COMPLIANCE_IPA_PATH must point to an existing IPA");
    if ((statSync(absoluteIpa).mode & 0o077) !== 0) throw new Error("the compliance IPA must be private mode 0600");
    rmSync(extractRoot, { recursive: true, force: true });
    mkdirSync(extractRoot, { recursive: true });
    const unzip = spawnSync("unzip", ["-qq", absoluteIpa, "-d", extractRoot], { encoding: "utf8" });
    if (unzip.status !== 0) throw new Error("could not extract the IPA");
    const payload = join(extractRoot, "Payload");
    const appName = readdirSync(payload).find((entry) => entry.endsWith(".app"));
    if (!appName) throw new Error("IPA Payload does not contain an app bundle");
    appPath = join(payload, appName);
    source = "ipa";
    const file = readFileSync(absoluteIpa);
    artifact = { name: basename(absoluteIpa), bytes: file.byteLength, sha256: createHash("sha256").update(file).digest("hex") };
  }

  const inspection = inspectIosAppBundle(appPath, { expectedBundleId: "app.ownminutes.mobile" });
  const summary = { checkedAt: new Date().toISOString(), source, artifact, ...inspection };
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  chmodSync(evidencePath, 0o600);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ready) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  rmSync(extractRoot, { recursive: true, force: true });
}
