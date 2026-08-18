#!/usr/bin/env node

import fs from "fs";
import path from "path";

const repoPath = path.join(process.cwd(), "src", "lib", "server", "auth-repository.ts");
const rateLimitPath = path.join(process.cwd(), "src", "lib", "server", "auth-rate-limit.ts");
const postgresRuntimePath = path.join(process.cwd(), "src", "lib", "server", "postgres-runtime.ts");
const sourceRoot = path.join(process.cwd(), "src");
const repositorySource = fs.existsSync(repoPath) ? fs.readFileSync(repoPath, "utf8") : "";
const rateLimitSource = fs.existsSync(rateLimitPath) ? fs.readFileSync(rateLimitPath, "utf8") : "";
const postgresRuntimeSource = fs.existsSync(postgresRuntimePath) ? fs.readFileSync(postgresRuntimePath, "utf8") : "";
const passwordResetFunctionStart = repositorySource.indexOf("async function postgresResetPasswordWithToken");
const passwordResetFunctionEnd = repositorySource.indexOf("\nasync function postgresCreateSession", passwordResetFunctionStart);
const passwordResetFunctionSource =
  passwordResetFunctionStart >= 0 && passwordResetFunctionEnd > passwordResetFunctionStart
    ? repositorySource.slice(passwordResetFunctionStart, passwordResetFunctionEnd)
    : "";
const requiredExports = [
  "changePassword",
  "createSession",
  "deleteAccount",
  "deleteProviderCredential",
  "destroySession",
  "getAdminCommercialMetrics",
  "getAdminFunnel",
  "getAdminGrowthMetrics",
  "getAdminMetrics",
  "getProviderRuntimeConfig",
  "getUserBySessionToken",
  "getUserUsage",
  "listAdminUsers",
  "listProviderCredentials",
  "loginUser",
  "requestPasswordReset",
  "resetPasswordWithToken",
  "recordMeetingFinalizeUsage",
  "reserveMeetingFinalizationQuota",
  "reserveMeetingRealtimeQuota",
  "registerUser",
  "saveProviderCredential",
  "updateUserPlan",
];

const sourceFiles = listFiles(sourceRoot, [".ts", ".tsx"]);
const authStoreImportsOutsideRepository = sourceFiles.filter((filePath) => {
  if (filePath === repoPath) return false;
  return fs.readFileSync(filePath, "utf8").includes("@/lib/server/auth-store");
});

const summary = {
  repositoryExists: Boolean(repositorySource),
  hasProviderEnv: repositorySource.includes("OWNMINUTES_AUTH_REPOSITORY"),
  hasLocalProvider: repositorySource.includes('"local-file"'),
  hasPostgresProvider: repositorySource.includes('"postgres"'),
  hasAwaitableBoundary: repositorySource.includes("type Awaitable<T>"),
  hasPostgresRuntime: repositorySource.includes("const postgresAuthRepository: AuthRepository") && !repositorySource.includes("PostgreSQL auth repository runtime is not implemented yet."),
  usesSharedPgPool:
    repositorySource.includes("getPostgresPool") &&
    postgresRuntimeSource.includes('require("pg")') &&
    postgresRuntimeSource.includes("new Pool"),
  requiresDatabaseUrl: postgresRuntimeSource.includes("requires DATABASE_URL or POSTGRES_URL."),
  implementsTransactions: repositorySource.includes("async function postgresTransaction"),
  implementsQuotaReservations:
    repositorySource.includes("async function postgresReserveMeetingRealtimeQuota") &&
    repositorySource.includes("async function postgresReserveMeetingFinalizationQuota") &&
    repositorySource.includes("select * from users where id = $1 and deleted_at is null for update") &&
    repositorySource.includes("official_quota_insufficient"),
  implementsProviderSecrets:
    repositorySource.includes("async function postgresSaveProviderCredential") &&
    repositorySource.includes("Object.entries(secrets).map(async") &&
    repositorySource.includes("select id from users where id = $1 and deleted_at is null for update") &&
    repositorySource.includes("async function postgresDeleteProviderCredential") &&
    repositorySource.includes("async function postgresGetProviderRuntimeConfig") &&
    repositorySource.includes("decryptSecret") &&
    repositorySource.includes("removeSecretNames") &&
    repositorySource.includes('reason: "provider_auth_switch"'),
  implementsPasswordChange: repositorySource.includes("async function postgresChangePassword") && repositorySource.includes("currentSessionToken"),
  implementsPasswordReset:
    repositorySource.includes("async function postgresRequestPasswordReset") &&
    repositorySource.includes("async function postgresResetPasswordWithToken") &&
    repositorySource.includes("password_reset_tokens") &&
    repositorySource.includes("token_hash"),
  hashesResetPasswordAfterTokenValidation:
    passwordResetFunctionSource.indexOf("const user = userResult.rows[0]") >= 0 &&
    passwordResetFunctionSource.indexOf("const nextPassword = hashPassword(input.newPassword)") >
      passwordResetFunctionSource.indexOf("const user = userResult.rows[0]"),
  implementsPasswordResetRateLimit:
    rateLimitSource.includes("passwordResetEntries") &&
    rateLimitSource.includes("getPasswordResetRateLimitState") &&
    rateLimitSource.includes("recordPasswordResetAttempt") &&
    rateLimitSource.includes("PASSWORD_RESET_WINDOW_MS"),
  implementsGrowthMetrics:
    repositorySource.includes("async function postgresGetAdminGrowthMetrics") &&
    repositorySource.includes("growth_events") &&
    repositorySource.includes("shareAttributedProviderUsers") &&
    repositorySource.includes("topShareRegistrations") &&
    !repositorySource.includes("shareAttributedRegistrations: 0"),
  recordsGrowthEvents:
    repositorySource.includes("insert into growth_events") &&
    repositorySource.includes("normalizeRegisterSource") &&
    repositorySource.includes("normalizeShareAttributionId") &&
    repositorySource.includes("delete from growth_events where user_id = $1"),
  exportsRuntimeFunctions: requiredExports.every((name) => repositorySource.includes(`export function ${name}`)),
  appUsesRepositoryBoundary: authStoreImportsOutsideRepository.length === 0,
  authStoreImportsOutsideRepository,
  leaksSecrets:
    repositorySource.includes("postgres://") ||
    repositorySource.includes("postgresql://") ||
    repositorySource.includes("DATABASE_URL=") ||
    repositorySource.includes("AKL") ||
    repositorySource.includes("sk-proj"),
};

console.log(JSON.stringify(summary, null, 2));

if (
  !summary.repositoryExists ||
  !summary.hasProviderEnv ||
  !summary.hasLocalProvider ||
  !summary.hasPostgresProvider ||
  !summary.hasAwaitableBoundary ||
  !summary.hasPostgresRuntime ||
  !summary.usesSharedPgPool ||
  !summary.requiresDatabaseUrl ||
  !summary.implementsTransactions ||
  !summary.implementsQuotaReservations ||
  !summary.implementsProviderSecrets ||
  !summary.implementsPasswordChange ||
  !summary.implementsPasswordReset ||
  !summary.hashesResetPasswordAfterTokenValidation ||
  !summary.implementsPasswordResetRateLimit ||
  !summary.implementsGrowthMetrics ||
  !summary.recordsGrowthEvents ||
  !summary.exportsRuntimeFunctions ||
  !summary.appUsesRepositoryBoundary ||
  summary.leaksSecrets
) {
  process.exitCode = 1;
}

function listFiles(root, extensions) {
  if (!fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(filePath, extensions));
      continue;
    }

    if (entry.isFile() && extensions.includes(path.extname(entry.name))) {
      files.push(filePath);
    }
  }

  return files;
}
