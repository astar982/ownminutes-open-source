#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const routePaths = [
  "src/app/api/auth/register/route.ts",
  "src/app/api/auth/login/route.ts",
  "src/app/api/auth/password-reset/request/route.ts",
  "src/app/api/auth/email-verification/request/route.ts",
];
const routeSources = routePaths.map((file) => readFileSync(file, "utf8"));
const summary = {
  loopbackIgnoresForwardedIpByDefault:
    probe({ host: "127.0.0.1:3003", xff: "203.0.113.15" }) === "untrusted-proxy",
  loopbackTestTrustRequiresExplicitFlag:
    probe(
      { host: "127.0.0.1:3003", xff: "203.0.113.15" },
      { OWNMINUTES_TRUST_LOOPBACK_PROXY_HEADERS: "1" },
    ) === "203.0.113.15",
  publicDirectRequestIgnoresSpoofedForwardedIp:
    probe({ host: "talk.example.com", xff: "203.0.113.16" }) === "untrusted-proxy",
  trustedProxyUsesDedicatedHeader:
    probe(
      { host: "talk.example.com", ownminutesIp: "198.51.100.20", proxySource: "caddy-primary", xff: "203.0.113.17" },
      { OWNMINUTES_TRUST_PROXY_HEADERS: "1", OWNMINUTES_TRUSTED_PROXY_SOURCES: "caddy-primary" },
    ) === "198.51.100.20",
  trustedProxyRejectsUnconfiguredSource:
    probe(
      { host: "talk.example.com", ownminutesIp: "198.51.100.20", proxySource: "attacker" },
      { OWNMINUTES_TRUST_PROXY_HEADERS: "1", OWNMINUTES_TRUSTED_PROXY_SOURCES: "caddy-primary" },
    ) === "untrusted-proxy",
  trustedProxyAcceptsConfiguredCidr:
    probe(
      { host: "talk.example.com", ownminutesIp: "2001:db8::9", proxySource: "10.42.0.8" },
      { OWNMINUTES_TRUST_PROXY_HEADERS: "1", OWNMINUTES_TRUSTED_PROXY_SOURCES: "10.42.0.0/16" },
    ) === "2001:db8::9",
  allAuthRoutesUseSharedIdentity:
    routeSources.every((source) => source.includes("getAuthRateLimitClientIp(request)") && !source.includes("function getClientIp")),
};

console.log(JSON.stringify(summary, null, 2));
if (Object.values(summary).some((value) => value !== true)) process.exitCode = 1;

function probe(input, env = {}) {
  const headers = { host: input.host };
  if (input.xff) headers["x-forwarded-for"] = input.xff;
  if (input.ownminutesIp) headers["x-ownminutes-client-ip"] = input.ownminutesIp;
  if (input.proxySource) headers["x-ownminutes-proxy-source"] = input.proxySource;
  const source = [
    "import { getAuthRateLimitClientIp } from './src/lib/server/auth-client-identity.ts';",
    `const request = new Request('https://${input.host}/api/auth/login', { headers: ${JSON.stringify(headers)} });`,
    "process.stdout.write(getAuthRateLimitClientIp(request));",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "test",
      OWNMINUTES_TRUST_PROXY_HEADERS: "0",
      OWNMINUTES_TRUSTED_PROXY_SOURCES: "",
      OWNMINUTES_TRUST_LOOPBACK_PROXY_HEADERS: "0",
      ...env,
    },
  });
  if (result.status !== 0) throw new Error(result.stderr || "Unable to probe auth client identity.");
  return result.stdout.trim();
}
