import crypto from "crypto";
import fs from "fs";
import path from "path";
import {
  getPostgresDatabaseUrl,
  getPostgresRuntimePool,
  type PgClient,
} from "@/lib/server/postgres-runtime";

const DATA_DIR = process.env.OWNMINUTES_AUTH_DATA_DIR
  ? path.resolve(process.env.OWNMINUTES_AUTH_DATA_DIR)
  : path.join(process.cwd(), ".data", "auth");
const RATE_LIMIT_PATH = path.join(DATA_DIR, "auth-rate-limit.json");
const LOGIN_MAX_FAILURES = 5;
const LOGIN_EMAIL_MAX_FAILURES = 10;
const LOGIN_IP_MAX_FAILURES = 50;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RESERVATION_LEASE_MS = LOGIN_WINDOW_MS;
const LOGIN_RESERVATION_RETENTION_MS = LOGIN_WINDOW_MS;
const LOGIN_ADMISSION_LOCK_TIMEOUT_MS = 2_000;
const LOGIN_ADMISSION_STATEMENT_TIMEOUT_MS = 5_000;
const REGISTER_MAX_ATTEMPTS = 5;
const REGISTER_WINDOW_MS = 60 * 60 * 1000;
const PASSWORD_RESET_MAX_ATTEMPTS = 5;
const PASSWORD_RESET_WINDOW_MS = 60 * 60 * 1000;
const EMAIL_VERIFICATION_MAX_ATTEMPTS = 5;
const EMAIL_VERIFICATION_WINDOW_MS = 60 * 60 * 1000;
const PERSISTENT_CLEANUP_BATCH_SIZE = 1_000;
const PERSISTENT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const PERSISTENT_CLEANUP_BACKLOG_RETRY_MS = 10 * 1000;
const PERSISTENT_CLEANUP_FAILURE_RETRY_MS = 60 * 1000;
const persistentCleanupStateKey = Symbol.for("ownminutes.auth-rate-limit-cleanup");
const globalPersistentCleanupState = globalThis as typeof globalThis & {
  [persistentCleanupStateKey]?: {
    inFlight?: Promise<void>;
    nextAttemptAt: number;
  };
};

export type AuthRateLimitScope = {
  identifier: string;
  maxAttempts: number;
  scope: "pair" | "email" | "ip";
};

type LoginRateLimitEntry = {
  count: number;
  firstFailedAt: string;
  lastFailedAt: string;
};

type LoginRateLimitReservationEntry = {
  expiresAt: string;
  identifierHashes: string[];
};

type LoginRateLimitStore = {
  emailVerificationEntries: Record<string, LoginRateLimitEntry>;
  loginEntries: Record<string, LoginRateLimitEntry>;
  loginReservations: Record<string, LoginRateLimitReservationEntry>;
  passwordResetEntries: Record<string, LoginRateLimitEntry>;
  registerEntries: Record<string, LoginRateLimitEntry>;
};

export async function getEmailVerificationRateLimitState(
  identifier: string,
  maxAttempts = EMAIL_VERIFICATION_MAX_ATTEMPTS,
): Promise<LoginRateLimitState> {
  if (shouldUsePostgresRateLimits()) {
    return getPersistentRateLimitState("email_verification", identifier, maxAttempts);
  }
  const store = readStore();
  const entry = store.emailVerificationEntries[keyForIdentifier(identifier)];
  if (!entry || isExpired(entry, EMAIL_VERIFICATION_WINDOW_MS)) return allowedState(0, maxAttempts);
  return {
    blocked: entry.count >= maxAttempts,
    remainingAttempts: Math.max(0, maxAttempts - entry.count),
    retryAfterSeconds: retryAfterSeconds(entry, EMAIL_VERIFICATION_WINDOW_MS),
  };
}

export async function recordEmailVerificationAttempt(
  identifier: string,
  maxAttempts = EMAIL_VERIFICATION_MAX_ATTEMPTS,
): Promise<LoginRateLimitState> {
  if (shouldUsePostgresRateLimits()) {
    return recordPersistentRateLimitAttempt(
      "email_verification",
      identifier,
      EMAIL_VERIFICATION_WINDOW_MS,
      maxAttempts,
    );
  }
  const store = readStore();
  const key = keyForIdentifier(identifier);
  const now = new Date().toISOString();
  const current = store.emailVerificationEntries[key];
  store.emailVerificationEntries[key] =
    current && !isExpired(current, EMAIL_VERIFICATION_WINDOW_MS)
      ? { count: current.count + 1, firstFailedAt: current.firstFailedAt, lastFailedAt: now }
      : { count: 1, firstFailedAt: now, lastFailedAt: now };
  pruneExpired(store);
  writeStore(store);
  return localRateLimitState(
    store.emailVerificationEntries[key],
    EMAIL_VERIFICATION_WINDOW_MS,
    maxAttempts,
  );
}

export async function clearEmailVerificationAttempts(identifier: string) {
  if (shouldUsePostgresRateLimits()) {
    await clearPersistentRateLimit("email_verification", identifier);
    return;
  }
  const store = readStore();
  delete store.emailVerificationEntries[keyForIdentifier(identifier)];
  pruneExpired(store);
  writeStore(store);
}

export function buildEmailVerificationRateLimitIdentifier(input: { email: string; ip: string }) {
  return `${input.email.trim().toLowerCase()}|${input.ip.trim() || "unknown"}`;
}

export function buildEmailVerificationRateLimitScopes(input: {
  action: "confirm" | "request";
  email: string;
  ip: string;
}): AuthRateLimitScope[] {
  const email = input.email.trim().toLowerCase() || "unknown";
  const ip = input.ip.trim() || "unknown";
  const prefix = `email-verification:${input.action}`;
  return [
    { identifier: `${prefix}:pair:${email}|${ip}`, maxAttempts: 5, scope: "pair" },
    { identifier: `${prefix}:email:${email}`, maxAttempts: 5, scope: "email" },
    { identifier: `${prefix}:ip:${ip}`, maxAttempts: input.action === "request" ? 30 : 50, scope: "ip" },
  ];
}

export async function getEmailVerificationRateLimitStateForScopes(scopes: AuthRateLimitScope[]) {
  return aggregateRateLimitStates(
    await Promise.all(
      scopes.map((scope) => getEmailVerificationRateLimitState(scope.identifier, scope.maxAttempts)),
    ),
  );
}

export async function recordEmailVerificationAttemptForScopes(scopes: AuthRateLimitScope[]) {
  return aggregateRateLimitStates(
    await Promise.all(
      scopes.map((scope) => recordEmailVerificationAttempt(scope.identifier, scope.maxAttempts)),
    ),
  );
}

export async function clearEmailVerificationAttemptsForScopes(scopes: AuthRateLimitScope[]) {
  await Promise.all(scopes.map((scope) => clearEmailVerificationAttempts(scope.identifier)));
}

export type LoginRateLimitState = {
  blocked: boolean;
  remainingAttempts: number;
  retryAfterSeconds: number;
};

export class AuthRateLimitBackendError extends Error {
  readonly code = "auth_rate_limit_backend_unavailable";

  constructor() {
    super("账号安全保护服务暂时不可用，请稍后重试。");
    this.name = "AuthRateLimitBackendError";
  }
}

export type LoginRateLimitedVerifierResult<T> =
  | {
      admitted: false;
      rateLimit: LoginRateLimitState;
    }
  | {
      admitted: true;
      value: T;
      verified: true;
    }
  | {
      admitted: true;
      error: unknown;
      rateLimit: LoginRateLimitState;
      verified: false;
    };

type LoginRateLimitReservation = {
  identifierHashes: string[];
  scopes: AuthRateLimitScope[];
  tokenHash: string;
};

type LoginRateLimitAdmission =
  | {
      admitted: false;
      rateLimit: LoginRateLimitState;
    }
  | {
      admitted: true;
      reservation: LoginRateLimitReservation;
    };

export async function getLoginRateLimitState(
  identifier: string,
  maxAttempts = LOGIN_MAX_FAILURES,
): Promise<LoginRateLimitState> {
  if (shouldUsePostgresRateLimits()) {
    return getPersistentRateLimitState("login", identifier, maxAttempts);
  }
  const store = readStore();
  const key = keyForIdentifier(identifier);
  const entry = store.loginEntries[key];
  if (!entry || isExpired(entry, LOGIN_WINDOW_MS)) return allowedState(0, maxAttempts);

  return {
    blocked: entry.count >= maxAttempts,
    remainingAttempts: Math.max(0, maxAttempts - entry.count),
    retryAfterSeconds: retryAfterSeconds(entry, LOGIN_WINDOW_MS),
  };
}

export async function recordLoginFailure(
  identifier: string,
  maxAttempts = LOGIN_MAX_FAILURES,
): Promise<LoginRateLimitState> {
  if (shouldUsePostgresRateLimits()) {
    return recordPersistentRateLimitAttempt("login", identifier, LOGIN_WINDOW_MS, maxAttempts);
  }
  const store = readStore();
  const key = keyForIdentifier(identifier);
  const now = new Date().toISOString();
  const current = store.loginEntries[key];
  const entry =
    current && !isExpired(current, LOGIN_WINDOW_MS)
      ? {
          count: current.count + 1,
          firstFailedAt: current.firstFailedAt,
          lastFailedAt: now,
        }
      : {
          count: 1,
          firstFailedAt: now,
          lastFailedAt: now,
        };

  store.loginEntries[key] = entry;
  pruneExpired(store);
  writeStore(store);
  return localRateLimitState(entry, LOGIN_WINDOW_MS, maxAttempts);
}

export async function clearLoginFailures(identifier: string) {
  if (shouldUsePostgresRateLimits()) {
    await clearPersistentRateLimit("login", identifier);
    return;
  }
  const store = readStore();
  delete store.loginEntries[keyForIdentifier(identifier)];
  pruneExpired(store);
  writeStore(store);
}

export function buildLoginRateLimitIdentifier(input: { email: string; ip: string }) {
  return buildLoginRateLimitScopes(input)[0].identifier;
}

export function buildLoginRateLimitScopes(input: { email: string; ip: string }): AuthRateLimitScope[] {
  const email = input.email.trim().toLowerCase() || "unknown";
  const ip = input.ip.trim() || "unknown";
  return [
    {
      identifier: `login:pair:${email}|${ip}`,
      maxAttempts: LOGIN_MAX_FAILURES,
      scope: "pair",
    },
    {
      identifier: `login:email:${email}`,
      maxAttempts: LOGIN_EMAIL_MAX_FAILURES,
      scope: "email",
    },
    {
      identifier: `login:ip:${ip}`,
      maxAttempts: LOGIN_IP_MAX_FAILURES,
      scope: "ip",
    },
  ];
}

export async function runLoginRateLimitedVerifier<T>(
  scopes: AuthRateLimitScope[],
  verifier: () => Promise<T> | T,
  isCredentialFailure: (error: unknown) => boolean,
): Promise<LoginRateLimitedVerifierResult<T>> {
  const admission = await reserveLoginRateLimitCapacity(scopes);
  if (!admission.admitted) return admission;

  try {
    const value = await verifier();
    await settleLoginRateLimitReservation(admission.reservation, "release");
    return { admitted: true, value, verified: true };
  } catch (error) {
    if (isCredentialFailure(error)) {
      const rateLimit = await settleLoginRateLimitReservation(
        admission.reservation,
        "failure",
      );
      return {
        admitted: true,
        error,
        rateLimit,
        verified: false,
      };
    }
    await settleLoginRateLimitReservation(admission.reservation, "release");
    throw error;
  }
}

export async function getLoginRateLimitStateForScopes(scopes: AuthRateLimitScope[]) {
  if (shouldUsePostgresRateLimits()) {
    return getPersistentRateLimitStateForScopes("login", scopes);
  }
  return aggregateRateLimitStates(
    await Promise.all(
      scopes.map((scope) => getLoginRateLimitState(scope.identifier, scope.maxAttempts)),
    ),
  );
}

export async function recordLoginFailureForScopes(scopes: AuthRateLimitScope[]) {
  if (shouldUsePostgresRateLimits()) {
    return recordPersistentRateLimitAttemptsForScopes("login", scopes, LOGIN_WINDOW_MS);
  }
  return aggregateRateLimitStates(
    await Promise.all(
      scopes.map((scope) => recordLoginFailure(scope.identifier, scope.maxAttempts)),
    ),
  );
}

export async function clearLoginFailuresForScopes(scopes: AuthRateLimitScope[]) {
  if (shouldUsePostgresRateLimits()) {
    await clearPersistentRateLimits("login", scopes.map((scope) => scope.identifier));
    return;
  }
  await Promise.all(scopes.map((scope) => clearLoginFailures(scope.identifier)));
}

export async function getRegisterRateLimitState(identifier: string): Promise<LoginRateLimitState> {
  if (shouldUsePostgresRateLimits()) {
    return getPersistentRateLimitState("register", identifier, REGISTER_MAX_ATTEMPTS);
  }
  const store = readStore();
  const key = keyForIdentifier(identifier);
  const entry = store.registerEntries[key];
  if (!entry || isExpired(entry, REGISTER_WINDOW_MS)) return allowedState(0, REGISTER_MAX_ATTEMPTS);

  return {
    blocked: entry.count >= REGISTER_MAX_ATTEMPTS,
    remainingAttempts: Math.max(0, REGISTER_MAX_ATTEMPTS - entry.count),
    retryAfterSeconds: retryAfterSeconds(entry, REGISTER_WINDOW_MS),
  };
}

export async function recordRegisterAttempt(identifier: string): Promise<LoginRateLimitState> {
  if (shouldUsePostgresRateLimits()) {
    return recordPersistentRateLimitAttempt("register", identifier, REGISTER_WINDOW_MS, REGISTER_MAX_ATTEMPTS);
  }
  const store = readStore();
  const key = keyForIdentifier(identifier);
  const now = new Date().toISOString();
  const current = store.registerEntries[key];
  const entry =
    current && !isExpired(current, REGISTER_WINDOW_MS)
      ? {
          count: current.count + 1,
          firstFailedAt: current.firstFailedAt,
          lastFailedAt: now,
        }
      : {
          count: 1,
          firstFailedAt: now,
          lastFailedAt: now,
        };

  store.registerEntries[key] = entry;
  pruneExpired(store);
  writeStore(store);
  return localRateLimitState(entry, REGISTER_WINDOW_MS, REGISTER_MAX_ATTEMPTS);
}

export function buildRegisterRateLimitIdentifier(input: { ip: string }) {
  return input.ip.trim() || "unknown";
}

export async function getPasswordResetRateLimitState(
  identifier: string,
  maxAttempts = PASSWORD_RESET_MAX_ATTEMPTS,
): Promise<LoginRateLimitState> {
  if (shouldUsePostgresRateLimits()) {
    return getPersistentRateLimitState("password_reset", identifier, maxAttempts);
  }
  const store = readStore();
  const key = keyForIdentifier(identifier);
  const entry = store.passwordResetEntries[key];
  if (!entry || isExpired(entry, PASSWORD_RESET_WINDOW_MS)) return allowedState(0, maxAttempts);

  return {
    blocked: entry.count >= maxAttempts,
    remainingAttempts: Math.max(0, maxAttempts - entry.count),
    retryAfterSeconds: retryAfterSeconds(entry, PASSWORD_RESET_WINDOW_MS),
  };
}

export async function recordPasswordResetAttempt(
  identifier: string,
  maxAttempts = PASSWORD_RESET_MAX_ATTEMPTS,
): Promise<LoginRateLimitState> {
  if (shouldUsePostgresRateLimits()) {
    return recordPersistentRateLimitAttempt(
      "password_reset",
      identifier,
      PASSWORD_RESET_WINDOW_MS,
      maxAttempts,
    );
  }
  const store = readStore();
  const key = keyForIdentifier(identifier);
  const now = new Date().toISOString();
  const current = store.passwordResetEntries[key];
  const entry =
    current && !isExpired(current, PASSWORD_RESET_WINDOW_MS)
      ? {
          count: current.count + 1,
          firstFailedAt: current.firstFailedAt,
          lastFailedAt: now,
        }
      : {
          count: 1,
          firstFailedAt: now,
          lastFailedAt: now,
        };

  store.passwordResetEntries[key] = entry;
  pruneExpired(store);
  writeStore(store);
  return localRateLimitState(
    store.passwordResetEntries[key],
    PASSWORD_RESET_WINDOW_MS,
    maxAttempts,
  );
}

export function buildPasswordResetRateLimitIdentifier(input: { email: string; ip: string }) {
  return `${input.email.trim().toLowerCase()}|${input.ip.trim() || "unknown"}`;
}

export function buildPasswordResetRateLimitScopes(input: { email: string; ip: string }): AuthRateLimitScope[] {
  const email = input.email.trim().toLowerCase() || "unknown";
  const ip = input.ip.trim() || "unknown";
  return [
    { identifier: `password-reset:pair:${email}|${ip}`, maxAttempts: 5, scope: "pair" },
    { identifier: `password-reset:email:${email}`, maxAttempts: 5, scope: "email" },
    { identifier: `password-reset:ip:${ip}`, maxAttempts: 30, scope: "ip" },
  ];
}

export async function getPasswordResetRateLimitStateForScopes(scopes: AuthRateLimitScope[]) {
  return aggregateRateLimitStates(
    await Promise.all(
      scopes.map((scope) => getPasswordResetRateLimitState(scope.identifier, scope.maxAttempts)),
    ),
  );
}

export async function recordPasswordResetAttemptForScopes(scopes: AuthRateLimitScope[]) {
  return aggregateRateLimitStates(
    await Promise.all(
      scopes.map((scope) => recordPasswordResetAttempt(scope.identifier, scope.maxAttempts)),
    ),
  );
}

function allowedState(count: number, maxAttempts: number): LoginRateLimitState {
  return {
    blocked: false,
    remainingAttempts: Math.max(0, maxAttempts - count),
    retryAfterSeconds: 0,
  };
}

function aggregateRateLimitStates(states: LoginRateLimitState[]): LoginRateLimitState {
  const blockedStates = states.filter((state) => state.blocked);
  return {
    blocked: blockedStates.length > 0,
    remainingAttempts: states.length > 0 ? Math.min(...states.map((state) => state.remainingAttempts)) : 0,
    retryAfterSeconds:
      blockedStates.length > 0 ? Math.max(...blockedStates.map((state) => state.retryAfterSeconds)) : 0,
  };
}

function isExpired(entry: LoginRateLimitEntry, windowMs: number) {
  return Date.now() - new Date(entry.firstFailedAt).getTime() >= windowMs;
}

function retryAfterSeconds(entry: LoginRateLimitEntry, windowMs: number) {
  return Math.max(0, Math.ceil((new Date(entry.firstFailedAt).getTime() + windowMs - Date.now()) / 1000));
}

function localRateLimitState(
  entry: LoginRateLimitEntry,
  windowMs: number,
  maxAttempts: number,
): LoginRateLimitState {
  return {
    blocked: entry.count >= maxAttempts,
    remainingAttempts: Math.max(0, maxAttempts - entry.count),
    retryAfterSeconds: retryAfterSeconds(entry, windowMs),
  };
}

function shouldUsePostgresRateLimits() {
  const production = process.env.NODE_ENV === "production";
  const postgresRepository = process.env.OWNMINUTES_AUTH_REPOSITORY === "postgres";
  if (!production && !postgresRepository) return false;
  const secret = process.env.OWNMINUTES_APP_SECRET || process.env.AUTH_SECRET;
  if (
    !postgresRepository ||
    !getPostgresDatabaseUrl() ||
    (production && (!secret || secret.length < 32))
  ) {
    throw new AuthRateLimitBackendError();
  }
  return true;
}

async function reserveLoginRateLimitCapacity(
  scopes: AuthRateLimitScope[],
): Promise<LoginRateLimitAdmission> {
  const identifierHashes = validateAndHashLoginScopes(scopes);
  if (shouldUsePostgresRateLimits()) {
    return reservePersistentLoginRateLimitCapacity(scopes, identifierHashes);
  }
  return reserveLocalLoginRateLimitCapacity(scopes, identifierHashes);
}

async function settleLoginRateLimitReservation(
  reservation: LoginRateLimitReservation,
  outcome: "failure" | "release",
): Promise<LoginRateLimitState> {
  if (shouldUsePostgresRateLimits()) {
    return settlePersistentLoginRateLimitReservation(reservation, outcome);
  }
  return settleLocalLoginRateLimitReservation(reservation, outcome);
}

function reserveLocalLoginRateLimitCapacity(
  scopes: AuthRateLimitScope[],
  identifierHashes: string[],
): LoginRateLimitAdmission {
  const store = readStore();
  pruneExpired(store);
  const rateLimit = getLocalLoginAdmissionState(store, scopes, identifierHashes);
  if (rateLimit.blocked) return { admitted: false, rateLimit };

  const tokenHash = createLoginReservationTokenHash();
  store.loginReservations[tokenHash] = {
    expiresAt: new Date(Date.now() + LOGIN_RESERVATION_LEASE_MS).toISOString(),
    identifierHashes,
  };
  writeStore(store);
  return {
    admitted: true,
    reservation: {
      identifierHashes,
      scopes,
      tokenHash,
    },
  };
}

function settleLocalLoginRateLimitReservation(
  reservation: LoginRateLimitReservation,
  outcome: "failure" | "release",
) {
  const store = readStore();
  const stored = store.loginReservations[reservation.tokenHash];
  if (
    !stored ||
    !sameStringSet(stored.identifierHashes, reservation.identifierHashes)
  ) {
    throw new AuthRateLimitBackendError();
  }

  delete store.loginReservations[reservation.tokenHash];
  const now = new Date().toISOString();
  if (outcome === "failure") {
    for (const identifierHash of reservation.identifierHashes) {
      const current = store.loginEntries[identifierHash];
      store.loginEntries[identifierHash] =
        current && !isExpired(current, LOGIN_WINDOW_MS)
          ? {
              count: current.count + 1,
              firstFailedAt: current.firstFailedAt,
              lastFailedAt: now,
            }
          : {
              count: 1,
              firstFailedAt: now,
              lastFailedAt: now,
            };
    }
  }
  pruneExpired(store);
  writeStore(store);
  if (outcome === "release") return allowedState(0, 0);
  return aggregateRateLimitStates(
    reservation.scopes.map((scope, index) => {
      const entry = store.loginEntries[reservation.identifierHashes[index]];
      return entry
        ? localRateLimitState(entry, LOGIN_WINDOW_MS, scope.maxAttempts)
        : allowedState(0, scope.maxAttempts);
    }),
  );
}

function getLocalLoginAdmissionState(
  store: LoginRateLimitStore,
  scopes: AuthRateLimitScope[],
  identifierHashes: string[],
) {
  const activeReservationExpirations = new Map<string, number[]>();
  const now = Date.now();
  for (const reservation of Object.values(store.loginReservations)) {
    const expiresAt = new Date(reservation.expiresAt).getTime();
    if (!Number.isFinite(expiresAt) || expiresAt <= now) continue;
    for (const identifierHash of reservation.identifierHashes) {
      const expirations = activeReservationExpirations.get(identifierHash) ?? [];
      expirations.push(expiresAt);
      activeReservationExpirations.set(identifierHash, expirations);
    }
  }

  return aggregateRateLimitStates(
    scopes.map((scope, index) => {
      const entry = store.loginEntries[identifierHashes[index]];
      return admissionRateLimitState({
        failureCount: entry?.count ?? 0,
        failureExpiresAt: entry
          ? new Date(entry.firstFailedAt).getTime() + LOGIN_WINDOW_MS
          : undefined,
        maxAttempts: scope.maxAttempts,
        now,
        reservationExpiresAt:
          activeReservationExpirations.get(identifierHashes[index]) ?? [],
      });
    }),
  );
}

async function reservePersistentLoginRateLimitCapacity(
  scopes: AuthRateLimitScope[],
  identifierHashes: string[],
): Promise<LoginRateLimitAdmission> {
  const admission = await withPersistentLoginScopeTransaction(
    identifierHashes,
    async (client) => {
      const rateLimit = await getPersistentLoginAdmissionState(
        client,
        scopes,
        identifierHashes,
      );
      if (rateLimit.blocked) return { admitted: false, rateLimit } as const;

      const tokenHash = createLoginReservationTokenHash();
      const result = await client.query(
        `insert into auth_login_rate_limit_reservations (
           reservation_token_hash, identifier_hash, created_at, expires_at
         )
         select
           $1,
           scope.identifier_hash,
           now(),
           now() + ($3::bigint * interval '1 millisecond')
         from unnest($2::text[]) as scope(identifier_hash)`,
        [tokenHash, identifierHashes, LOGIN_RESERVATION_LEASE_MS],
      );
      if ((result.rowCount ?? 0) !== identifierHashes.length) {
        throw new AuthRateLimitBackendError();
      }
      return {
        admitted: true,
        reservation: {
          identifierHashes,
          scopes,
          tokenHash,
        },
      } as const;
    },
  );
  void maybePrunePersistentRateLimitEntries();
  return admission;
}

async function settlePersistentLoginRateLimitReservation(
  reservation: LoginRateLimitReservation,
  outcome: "failure" | "release",
) {
  const rateLimit = await withPersistentLoginScopeTransaction(
    reservation.identifierHashes,
    async (client) => {
      const deleted = await client.query<{ identifier_hash: string }>(
        `delete from auth_login_rate_limit_reservations
         where reservation_token_hash = $1
           and identifier_hash = any($2::text[])
         returning identifier_hash`,
        [reservation.tokenHash, reservation.identifierHashes],
      );
      if (
        !sameStringSet(
          deleted.rows.map((row) => row.identifier_hash),
          reservation.identifierHashes,
        )
      ) {
        throw new AuthRateLimitBackendError();
      }
      if (outcome === "release") return allowedState(0, 0);
      return upsertPersistentLoginFailures(
        client,
        reservation.scopes,
        reservation.identifierHashes,
      );
    },
  );
  void maybePrunePersistentRateLimitEntries();
  return rateLimit;
}

async function getPersistentLoginAdmissionState(
  client: PgClient,
  scopes: AuthRateLimitScope[],
  identifierHashes: string[],
) {
  const entries = await client.query<{
    attempt_count: number | string;
    expires_at: Date | string;
    identifier_hash: string;
  }>(
    `select identifier_hash, attempt_count, expires_at
     from auth_rate_limit_entries
     where bucket = 'login'
       and identifier_hash = any($1::text[])
       and expires_at > now()`,
    [identifierHashes],
  );
  const reservations = await client.query<{
    expires_at: Date | string;
    identifier_hash: string;
  }>(
    `select identifier_hash, expires_at
     from auth_login_rate_limit_reservations
     where identifier_hash = any($1::text[])
       and expires_at > now()`,
    [identifierHashes],
  );
  const entriesByHash = new Map(
    entries.rows.map((row) => [row.identifier_hash, row]),
  );
  const reservationExpirationsByHash = new Map<string, number[]>();
  for (const row of reservations.rows) {
    const expirations =
      reservationExpirationsByHash.get(row.identifier_hash) ?? [];
    expirations.push(new Date(row.expires_at).getTime());
    reservationExpirationsByHash.set(row.identifier_hash, expirations);
  }
  const now = Date.now();
  return aggregateRateLimitStates(
    scopes.map((scope, index) => {
      const row = entriesByHash.get(identifierHashes[index]);
      return admissionRateLimitState({
        failureCount: Math.max(0, Number(row?.attempt_count ?? 0)),
        failureExpiresAt: row
          ? new Date(row.expires_at).getTime()
          : undefined,
        maxAttempts: scope.maxAttempts,
        now,
        reservationExpiresAt:
          reservationExpirationsByHash.get(identifierHashes[index]) ?? [],
      });
    }),
  );
}

async function upsertPersistentLoginFailures(
  client: PgClient,
  scopes: AuthRateLimitScope[],
  identifierHashes: string[],
) {
  const result = await client.query<{
    attempt_count: number | string;
    expires_at: Date | string;
    identifier_hash: string;
  }>(
    `insert into auth_rate_limit_entries (
       bucket, identifier_hash, attempt_count, first_attempt_at, last_attempt_at, expires_at
     )
     select
       'login',
       scope.identifier_hash,
       1,
       now(),
       now(),
       now() + ($2::bigint * interval '1 millisecond')
     from unnest($1::text[]) as scope(identifier_hash)
     on conflict (bucket, identifier_hash) do update
     set attempt_count = case
           when auth_rate_limit_entries.expires_at <= now() then 1
           else auth_rate_limit_entries.attempt_count + 1
         end,
         first_attempt_at = case
           when auth_rate_limit_entries.expires_at <= now() then now()
           else auth_rate_limit_entries.first_attempt_at
         end,
         last_attempt_at = now(),
         expires_at = case
           when auth_rate_limit_entries.expires_at <= now()
             then now() + ($2::bigint * interval '1 millisecond')
           else auth_rate_limit_entries.expires_at
         end
     returning identifier_hash, attempt_count, expires_at`,
    [identifierHashes, LOGIN_WINDOW_MS],
  );
  const rowsByHash = new Map(
    result.rows.map((row) => [row.identifier_hash, row]),
  );
  if (!sameStringSet([...rowsByHash.keys()], identifierHashes)) {
    throw new AuthRateLimitBackendError();
  }
  return aggregateRateLimitStates(
    scopes.map((scope, index) => {
      const row = rowsByHash.get(identifierHashes[index]);
      if (!row) throw new AuthRateLimitBackendError();
      return persistentRateLimitState(row, scope.maxAttempts);
    }),
  );
}

async function withPersistentLoginScopeTransaction<T>(
  identifierHashes: string[],
  operation: (client: PgClient) => Promise<T>,
) {
  let client: PgClient | undefined;
  try {
    client = await getPostgresRuntimePool(
      "Persistent login rate limiting",
    ).connect();
    await client.query("begin");
    await client.query(
      `select
         set_config('lock_timeout', $1, true),
         set_config('statement_timeout', $2, true)`,
      [
        `${LOGIN_ADMISSION_LOCK_TIMEOUT_MS}ms`,
        `${LOGIN_ADMISSION_STATEMENT_TIMEOUT_MS}ms`,
      ],
    );
    for (const identifierHash of [...new Set(identifierHashes)].sort()) {
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`ownminutes-auth-login-admission:v1:${identifierHash}`],
      );
    }
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    if (client) await client.query("rollback").catch(() => {});
    if (error instanceof AuthRateLimitBackendError) throw error;
    throw new AuthRateLimitBackendError();
  } finally {
    client?.release();
  }
}

function admissionRateLimitState(input: {
  failureCount: number;
  failureExpiresAt?: number;
  maxAttempts: number;
  now: number;
  reservationExpiresAt: number[];
}): LoginRateLimitState {
  const failureCount = Math.max(0, input.failureCount);
  const activeReservationExpirations = input.reservationExpiresAt
    .filter((expiresAt) => Number.isFinite(expiresAt) && expiresAt > input.now)
    .sort((left, right) => left - right);
  let effectiveCount = failureCount + activeReservationExpirations.length;
  if (effectiveCount < input.maxAttempts) {
    return allowedState(effectiveCount, input.maxAttempts);
  }

  const events = new Map<number, number>();
  for (const expiresAt of activeReservationExpirations) {
    events.set(expiresAt, (events.get(expiresAt) ?? 0) - 1);
  }
  if (
    failureCount > 0 &&
    input.failureExpiresAt &&
    input.failureExpiresAt > input.now
  ) {
    events.set(
      input.failureExpiresAt,
      (events.get(input.failureExpiresAt) ?? 0) - failureCount,
    );
  }
  let retryAfterSeconds = 1;
  for (const [expiresAt, delta] of [...events.entries()].sort(
    ([left], [right]) => left - right,
  )) {
    effectiveCount += delta;
    if (effectiveCount < input.maxAttempts) {
      retryAfterSeconds = Math.max(
        1,
        Math.ceil((expiresAt - input.now) / 1000),
      );
      break;
    }
  }
  return {
    blocked: true,
    remainingAttempts: 0,
    retryAfterSeconds,
  };
}

function validateAndHashLoginScopes(scopes: AuthRateLimitScope[]) {
  if (
    scopes.length === 0 ||
    scopes.some(
      (scope) =>
        !scope.identifier ||
        !Number.isSafeInteger(scope.maxAttempts) ||
        scope.maxAttempts < 1,
    )
  ) {
    throw new AuthRateLimitBackendError();
  }
  const identifierHashes = scopes.map((scope) =>
    keyForIdentifier(scope.identifier),
  );
  if (new Set(identifierHashes).size !== identifierHashes.length) {
    throw new AuthRateLimitBackendError();
  }
  return identifierHashes;
}

function createLoginReservationTokenHash() {
  return crypto
    .createHash("sha256")
    .update(crypto.randomBytes(32))
    .digest("base64url");
}

function sameStringSet(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((value) => right.includes(value))
  );
}

async function getPersistentRateLimitState(
  bucket: PersistentRateLimitBucket,
  identifier: string,
  maxAttempts: number,
) {
  try {
    const result = await getPostgresRuntimePool("Persistent auth rate limiting").query<{
      attempt_count: number | string;
      expires_at: Date | string;
    }>(
      `select attempt_count, expires_at
       from auth_rate_limit_entries
       where bucket = $1 and identifier_hash = $2 and expires_at > now()`,
      [bucket, keyForIdentifier(identifier)],
    );
    await maybePrunePersistentRateLimitEntries();
    const row = result.rows[0];
    if (!row) return allowedState(0, maxAttempts);
    return persistentRateLimitState(row, maxAttempts);
  } catch (error) {
    if (error instanceof AuthRateLimitBackendError) throw error;
    throw new AuthRateLimitBackendError();
  }
}

async function getPersistentRateLimitStateForScopes(
  bucket: PersistentRateLimitBucket,
  scopes: AuthRateLimitScope[],
) {
  if (scopes.length === 0) return aggregateRateLimitStates([]);
  try {
    const scopeHashes = scopes.map((scope) => keyForIdentifier(scope.identifier));
    const result = await getPostgresRuntimePool("Persistent auth rate limiting").query<{
      attempt_count: number | string;
      expires_at: Date | string;
      identifier_hash: string;
    }>(
      `select identifier_hash, attempt_count, expires_at
       from auth_rate_limit_entries
       where bucket = $1
         and identifier_hash = any($2::text[])
         and expires_at > now()`,
      [bucket, scopeHashes],
    );
    await maybePrunePersistentRateLimitEntries();
    const rowsByHash = new Map(result.rows.map((row) => [row.identifier_hash, row]));
    return aggregateRateLimitStates(
      scopes.map((scope, index) => {
        const row = rowsByHash.get(scopeHashes[index]);
        return row
          ? persistentRateLimitState(row, scope.maxAttempts)
          : allowedState(0, scope.maxAttempts);
      }),
    );
  } catch (error) {
    if (error instanceof AuthRateLimitBackendError) throw error;
    throw new AuthRateLimitBackendError();
  }
}

async function recordPersistentRateLimitAttempt(
  bucket: PersistentRateLimitBucket,
  identifier: string,
  windowMs: number,
  maxAttempts: number,
) {
  try {
    const result = await getPostgresRuntimePool("Persistent auth rate limiting").query<{
      attempt_count: number | string;
      expires_at: Date | string;
    }>(
      `insert into auth_rate_limit_entries (
         bucket, identifier_hash, attempt_count, first_attempt_at, last_attempt_at, expires_at
       )
       values ($1, $2, 1, now(), now(), now() + ($3::bigint * interval '1 millisecond'))
       on conflict (bucket, identifier_hash) do update
       set attempt_count = case
             when auth_rate_limit_entries.expires_at <= now() then 1
             else auth_rate_limit_entries.attempt_count + 1
           end,
           first_attempt_at = case
             when auth_rate_limit_entries.expires_at <= now() then now()
             else auth_rate_limit_entries.first_attempt_at
           end,
           last_attempt_at = now(),
           expires_at = case
             when auth_rate_limit_entries.expires_at <= now()
               then now() + ($3::bigint * interval '1 millisecond')
             else auth_rate_limit_entries.expires_at
           end
       returning attempt_count, expires_at`,
      [bucket, keyForIdentifier(identifier), windowMs],
    );
    await maybePrunePersistentRateLimitEntries();
    const row = result.rows[0];
    if (!row) throw new AuthRateLimitBackendError();
    return persistentRateLimitState(row, maxAttempts);
  } catch (error) {
    if (error instanceof AuthRateLimitBackendError) throw error;
    throw new AuthRateLimitBackendError();
  }
}

async function recordPersistentRateLimitAttemptsForScopes(
  bucket: PersistentRateLimitBucket,
  scopes: AuthRateLimitScope[],
  windowMs: number,
) {
  if (scopes.length === 0) return aggregateRateLimitStates([]);
  try {
    const scopeHashes = scopes.map((scope) => keyForIdentifier(scope.identifier));
    const result = await getPostgresRuntimePool("Persistent auth rate limiting").query<{
      attempt_count: number | string;
      expires_at: Date | string;
      identifier_hash: string;
    }>(
      `insert into auth_rate_limit_entries (
         bucket, identifier_hash, attempt_count, first_attempt_at, last_attempt_at, expires_at
       )
       select
         $1,
         scope.identifier_hash,
         1,
         now(),
         now(),
         now() + ($3::bigint * interval '1 millisecond')
       from unnest($2::text[]) as scope(identifier_hash)
       on conflict (bucket, identifier_hash) do update
       set attempt_count = case
             when auth_rate_limit_entries.expires_at <= now() then 1
             else auth_rate_limit_entries.attempt_count + 1
           end,
           first_attempt_at = case
             when auth_rate_limit_entries.expires_at <= now() then now()
             else auth_rate_limit_entries.first_attempt_at
           end,
           last_attempt_at = now(),
           expires_at = case
             when auth_rate_limit_entries.expires_at <= now()
               then now() + ($3::bigint * interval '1 millisecond')
             else auth_rate_limit_entries.expires_at
           end
       returning identifier_hash, attempt_count, expires_at`,
      [bucket, scopeHashes, windowMs],
    );
    await maybePrunePersistentRateLimitEntries();
    const rowsByHash = new Map(result.rows.map((row) => [row.identifier_hash, row]));
    if (rowsByHash.size !== new Set(scopeHashes).size) throw new AuthRateLimitBackendError();
    return aggregateRateLimitStates(
      scopes.map((scope, index) => {
        const row = rowsByHash.get(scopeHashes[index]);
        if (!row) throw new AuthRateLimitBackendError();
        return persistentRateLimitState(row, scope.maxAttempts);
      }),
    );
  } catch (error) {
    if (error instanceof AuthRateLimitBackendError) throw error;
    throw new AuthRateLimitBackendError();
  }
}

async function clearPersistentRateLimit(bucket: PersistentRateLimitBucket, identifier: string) {
  try {
    await getPostgresRuntimePool("Persistent auth rate limiting").query(
      "delete from auth_rate_limit_entries where bucket = $1 and identifier_hash = $2",
      [bucket, keyForIdentifier(identifier)],
    );
  } catch {
    throw new AuthRateLimitBackendError();
  }
}

async function clearPersistentRateLimits(
  bucket: PersistentRateLimitBucket,
  identifiers: string[],
) {
  if (identifiers.length === 0) return;
  try {
    await getPostgresRuntimePool("Persistent auth rate limiting").query(
      `delete from auth_rate_limit_entries
       where bucket = $1 and identifier_hash = any($2::text[])`,
      [bucket, identifiers.map((identifier) => keyForIdentifier(identifier))],
    );
  } catch {
    throw new AuthRateLimitBackendError();
  }
}

async function maybePrunePersistentRateLimitEntries() {
  const state = globalPersistentCleanupState[persistentCleanupStateKey] ?? {
    nextAttemptAt: 0,
  };
  globalPersistentCleanupState[persistentCleanupStateKey] = state;
  if (state.inFlight) return state.inFlight;
  if (state.nextAttemptAt > Date.now()) return;

  state.nextAttemptAt = Date.now() + PERSISTENT_CLEANUP_INTERVAL_MS;
  const operation = (async () => {
    try {
      const pool = getPostgresRuntimePool(
        "Persistent auth rate limiting cleanup",
      );
      const result = await pool.query(
        `with expired as (
           select bucket, identifier_hash
           from auth_rate_limit_entries
           where expires_at <= now()
           order by expires_at asc
           for update skip locked
           limit $1
         )
         delete from auth_rate_limit_entries entry
         using expired
         where entry.bucket = expired.bucket
           and entry.identifier_hash = expired.identifier_hash`,
        [PERSISTENT_CLEANUP_BATCH_SIZE],
      );
      const reservations = await pool.query(
        `with expired_login_reservations as (
           select reservation_token_hash, identifier_hash
           from auth_login_rate_limit_reservations
           where expires_at <= now() - ($2::bigint * interval '1 millisecond')
           order by expires_at asc
           for update skip locked
           limit $1
         )
         delete from auth_login_rate_limit_reservations reservation
         using expired_login_reservations expired
         where reservation.reservation_token_hash = expired.reservation_token_hash
           and reservation.identifier_hash = expired.identifier_hash`,
        [PERSISTENT_CLEANUP_BATCH_SIZE, LOGIN_RESERVATION_RETENTION_MS],
      );
      state.nextAttemptAt =
        Date.now() +
        ((result.rowCount ?? 0) >= PERSISTENT_CLEANUP_BATCH_SIZE ||
        (reservations.rowCount ?? 0) >= PERSISTENT_CLEANUP_BATCH_SIZE
          ? PERSISTENT_CLEANUP_BACKLOG_RETRY_MS
          : PERSISTENT_CLEANUP_INTERVAL_MS);
    } catch (error) {
      state.nextAttemptAt = Date.now() + PERSISTENT_CLEANUP_FAILURE_RETRY_MS;
      console.error("Auth rate limit cleanup failed.", {
        errorType: error instanceof Error ? error.name : "unknown",
      });
    }
  })().finally(() => {
    if (state.inFlight === operation) state.inFlight = undefined;
  });
  state.inFlight = operation;
  return operation;
}

type PersistentRateLimitBucket =
  | "email_verification"
  | "login"
  | "password_reset"
  | "register";

function persistentRateLimitState(
  row: { attempt_count: number | string; expires_at: Date | string },
  maxAttempts: number,
): LoginRateLimitState {
  const count = Math.max(0, Number(row.attempt_count || 0));
  const expiresAt = new Date(row.expires_at).getTime();
  return {
    blocked: count >= maxAttempts,
    remainingAttempts: Math.max(0, maxAttempts - count),
    retryAfterSeconds: Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)),
  };
}

function pruneExpired(store: LoginRateLimitStore) {
  const reservationRetentionCutoff =
    Date.now() - LOGIN_RESERVATION_RETENTION_MS;
  for (const [key, reservation] of Object.entries(
    store.loginReservations,
  )) {
    const expiresAt = new Date(reservation.expiresAt).getTime();
    if (
      !Number.isFinite(expiresAt) ||
      expiresAt <= reservationRetentionCutoff
    ) {
      delete store.loginReservations[key];
    }
  }
  for (const [key, entry] of Object.entries(store.loginEntries)) {
    if (isExpired(entry, LOGIN_WINDOW_MS)) delete store.loginEntries[key];
  }
  for (const [key, entry] of Object.entries(store.registerEntries)) {
    if (isExpired(entry, REGISTER_WINDOW_MS)) delete store.registerEntries[key];
  }
  for (const [key, entry] of Object.entries(store.passwordResetEntries)) {
    if (isExpired(entry, PASSWORD_RESET_WINDOW_MS)) delete store.passwordResetEntries[key];
  }
  for (const [key, entry] of Object.entries(store.emailVerificationEntries)) {
    if (isExpired(entry, EMAIL_VERIFICATION_WINDOW_MS)) delete store.emailVerificationEntries[key];
  }
}

function keyForIdentifier(identifier: string) {
  const secret = process.env.OWNMINUTES_APP_SECRET || process.env.AUTH_SECRET;
  if (secret && secret.length >= 32) {
    return crypto
      .createHmac("sha256", crypto.createHash("sha256").update(`${secret}:auth-rate-limit`).digest())
      .update(identifier)
      .digest("base64url");
  }
  return crypto
    .createHash("sha256")
    .update("ownminutes-local-auth-rate-limit:v1\u0000")
    .update(identifier)
    .digest("base64url");
}

function readStore(): LoginRateLimitStore {
  try {
    if (!fs.existsSync(RATE_LIMIT_PATH)) {
      return {
        emailVerificationEntries: {},
        loginEntries: {},
        loginReservations: {},
        passwordResetEntries: {},
        registerEntries: {},
      };
    }
    const parsed = JSON.parse(fs.readFileSync(RATE_LIMIT_PATH, "utf8")) as LoginRateLimitStore;
    const legacyEntries = (parsed as unknown as { entries?: Record<string, LoginRateLimitEntry> }).entries;
    return {
      emailVerificationEntries:
        parsed.emailVerificationEntries && typeof parsed.emailVerificationEntries === "object" ? parsed.emailVerificationEntries : {},
      loginEntries: parsed.loginEntries && typeof parsed.loginEntries === "object" ? parsed.loginEntries : legacyEntries || {},
      loginReservations:
        parsed.loginReservations && typeof parsed.loginReservations === "object"
          ? parsed.loginReservations
          : {},
      passwordResetEntries:
        parsed.passwordResetEntries && typeof parsed.passwordResetEntries === "object" ? parsed.passwordResetEntries : {},
      registerEntries: parsed.registerEntries && typeof parsed.registerEntries === "object" ? parsed.registerEntries : {},
    };
  } catch {
    return {
      emailVerificationEntries: {},
      loginEntries: {},
      loginReservations: {},
      passwordResetEntries: {},
      registerEntries: {},
    };
  }
}

function writeStore(store: LoginRateLimitStore) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(RATE_LIMIT_PATH, JSON.stringify(store, null, 2), { mode: 0o600 });
}
