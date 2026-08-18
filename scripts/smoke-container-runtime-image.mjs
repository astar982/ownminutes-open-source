#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sortedScopedPackages(scope, prefix) {
  return readdirSync(`/app/node_modules/${scope}`)
    .filter((name) => name.startsWith(prefix))
    .sort();
}

assert(process.platform === "linux", `Expected linux runtime image, received ${process.platform}`);
assert(["arm64", "x64"].includes(process.arch), `Unsupported runtime architecture: ${process.arch}`);

const expectedSwcPackage = `swc-linux-${process.arch}-gnu`;
const expectedSharpPackages = [`sharp-libvips-linux-${process.arch}`, `sharp-linux-${process.arch}`].sort();
const installedSwcPackages = sortedScopedPackages("@next", "swc-");
const installedSharpPackages = sortedScopedPackages("@img", "sharp-");
const npmVersion = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();

assert(npmVersion === "11.8.0", `Expected npm 11.8.0, received ${npmVersion}`);
assert(
  JSON.stringify(installedSwcPackages) === JSON.stringify([expectedSwcPackage]),
  `Unexpected SWC platform packages: ${installedSwcPackages.join(", ")}`,
);
assert(
  JSON.stringify(installedSharpPackages) === JSON.stringify(expectedSharpPackages),
  `Unexpected Sharp platform packages: ${installedSharpPackages.join(", ")}`,
);

const requiredSharp = require("sharp");
const importedSharp = (await import("sharp")).default;

assert(requiredSharp.versions.sharp === "0.35.3", `Expected sharp 0.35.3, received ${requiredSharp.versions.sharp}`);
assert(importedSharp.versions.sharp === "0.35.3", "Dynamic sharp import did not load version 0.35.3");

const rawPixels = Buffer.from([
  255, 0, 0, 255,
  0, 255, 0, 255,
  0, 0, 255, 255,
  255, 255, 255, 255,
]);
const png = await importedSharp(rawPixels, {
  raw: { width: 2, height: 2, channels: 4 },
})
  .png()
  .toBuffer();
const pngMetadata = await importedSharp(png).metadata();

assert(png.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", "Sharp did not encode a valid PNG");
assert(pngMetadata.format === "png" && pngMetadata.width === 2 && pngMetadata.height === 2, "Sharp PNG metadata mismatch");

const nextImageOptimizer = require("next/dist/server/image-optimizer");
const nextSharp = nextImageOptimizer.getSharp(null);
assert(nextSharp.versions.sharp === "0.35.3", `Next loaded unexpected sharp version ${nextSharp.versions.sharp}`);

const optimizedPng = await nextImageOptimizer.optimizeImage({
  buffer: png,
  contentType: "image/png",
  quality: 75,
  width: 1,
  concurrency: null,
  limitInputPixels: 1_000,
  sequentialRead: true,
  timeoutInSeconds: 7,
});
const optimizedMetadata = await nextSharp(optimizedPng).metadata();
const optimizedContentType = await nextImageOptimizer.detectContentType(optimizedPng);

assert(optimizedContentType === "image/png", `Next returned unexpected content type ${optimizedContentType}`);
assert(
  optimizedMetadata.format === "png" && optimizedMetadata.width === 1 && optimizedMetadata.height === 1,
  "Next image optimizer output mismatch",
);

let auditOutput;
try {
  auditOutput = execFileSync(
    "npm",
    [
      "audit",
      "--omit=dev",
      "--audit-level=high",
      "--json",
      "--registry=https://registry.npmjs.org",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        NPM_CONFIG_REGISTRY: "https://registry.npmjs.org",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
} catch (error) {
  const stdout = typeof error?.stdout === "string" ? error.stdout : error?.stdout?.toString();
  const stderr = typeof error?.stderr === "string" ? error.stderr : error?.stderr?.toString();
  throw new Error(`Production dependency audit failed: ${stdout || stderr || error.message}`);
}

const audit = JSON.parse(auditOutput);
const auditVulnerabilities = audit.metadata?.vulnerabilities;
assert(auditVulnerabilities?.total === 0, `Expected zero production vulnerabilities: ${JSON.stringify(auditVulnerabilities)}`);

console.log(
  JSON.stringify(
    {
      runtime: `${process.platform}/${process.arch}`,
      npm: npmVersion,
      next: require("next/package.json").version,
      sharp: requiredSharp.versions.sharp,
      libvips: requiredSharp.versions.vips,
      nativePackages: {
        swc: installedSwcPackages,
        sharp: installedSharpPackages,
      },
      png: {
        encodedBytes: png.length,
        width: pngMetadata.width,
        height: pngMetadata.height,
      },
      nextImageOptimizer: {
        contentType: optimizedContentType,
        encodedBytes: optimizedPng.length,
        width: optimizedMetadata.width,
        height: optimizedMetadata.height,
      },
      productionAudit: auditVulnerabilities,
    },
    null,
    2,
  ),
);
