#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const repository = argument("--repository") || process.env.OWNMINUTES_AUTH_REPOSITORY || "local-file";
const email = (argument("--email") || process.env.OWNMINUTES_ADMIN_EMAIL || "").trim().toLowerCase();
const name = (argument("--name") || process.env.OWNMINUTES_ADMIN_NAME || "OwnMinutes Admin").trim();
const passwordFile = path.resolve(argument("--password-file") || process.env.OWNMINUTES_ADMIN_PASSWORD_FILE || "");
const passwordFromEnvironment = process.env.OWNMINUTES_ADMIN_PASSWORD || "";
const storePath = path.resolve(argument("--store-path") || path.join(process.cwd(), ".data", "auth", "store.json"));

await main();

async function main() {
  validateIdentity();
  const password = passwordFromEnvironment || readPasswordFile();
  validatePassword(password);
  const passwordRecord = hashPassword(password);
  const result = repository === "postgres" ? await bootstrapPostgres(passwordRecord) : bootstrapLocal(passwordRecord);
  console.log(
    JSON.stringify(
      {
        ok: true,
        repository,
        action: result.action,
        userId: result.userId,
        emailFingerprint: crypto.createHash("sha256").update(email).digest("hex").slice(0, 12),
        passwordReset: result.action === "created",
        nextAction: result.action === "created" ? "Sign in once and change the bootstrap password immediately." : "Existing administrator was preserved; password was not changed.",
        leaksSecrets: false,
      },
      null,
      2,
    ),
  );
}

function validateIdentity() {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("OWNMINUTES_ADMIN_EMAIL must be a valid email address.");
  if (name.length < 2 || name.length > 80) throw new Error("OWNMINUTES_ADMIN_NAME must contain 2-80 characters.");
  if (!passwordFromEnvironment && (!passwordFile || passwordFile === path.parse(passwordFile).root)) {
    throw new Error("Provide OWNMINUTES_ADMIN_PASSWORD, OWNMINUTES_ADMIN_PASSWORD_FILE or --password-file.");
  }
  if (!['local-file', 'postgres'].includes(repository)) throw new Error("Admin bootstrap repository must be local-file or postgres.");
}

function readPasswordFile() {
  const stats = fs.statSync(passwordFile);
  if (!stats.isFile()) throw new Error("Admin bootstrap password path must be a regular file.");
  const isDockerSecret = passwordFile.startsWith("/run/secrets/") && (stats.mode & 0o222) === 0;
  if (!isDockerSecret && (stats.mode & 0o077) !== 0) throw new Error("Admin bootstrap password file must use owner-only permissions (0600).");
  const password = fs.readFileSync(passwordFile, "utf8").trim();
  return password;
}

function validatePassword(password) {
  if (password.length < 16 || password.length > 256 || /[\r\n\0]/.test(password)) {
    throw new Error("Admin bootstrap password must contain 16-256 characters on one line.");
  }
}

function bootstrapLocal(passwordRecord) {
  if (!fs.existsSync(storePath)) throw new Error("Local auth store does not exist; initialize the app store before bootstrapping an administrator.");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  const users = Array.isArray(store.users) ? store.users : [];
  const activeAdmin = users.find((user) => !user.deletedAt && user.role === "admin");
  if (activeAdmin) return { action: "already-configured", userId: activeAdmin.id };
  if (users.length > 0) throw new Error("Refusing automatic admin creation because the local auth store already contains users but no active admin.");

  const now = new Date().toISOString();
  const userId = createId("user");
  users.push({
    id: userId,
    email,
    name,
    role: "admin",
    plan: "free",
    freeTrialMinutesTotal: 60,
    freeTrialMinutesUsed: 0,
    freeTrialGrantedAt: now,
    officialMinutesTotal: 60,
    officialMinutesUsed: 0,
    officialMinutesPeriodStartAt: now,
    officialMinutesPeriodSource: "free_trial",
    createdAt: now,
    emailVerifiedAt: now,
    passwordSalt: passwordRecord.salt,
    passwordHash: passwordRecord.hash,
  });
  store.users = users;
  store.usageEvents = Array.isArray(store.usageEvents) ? store.usageEvents : [];
  store.growthEvents = Array.isArray(store.growthEvents) ? store.growthEvents : [];
  store.usageEvents.push({ id: createId("usage"), userId, type: "register_bonus", minutes: 60, createdAt: now, note: "Free plan official trial quota" });
  store.growthEvents.push({ id: createId("growth"), userId, type: "register", source: "direct", createdAt: now });
  atomicWriteJson(storePath, store);
  return { action: "created", userId };
}

async function bootstrapPostgres(passwordRecord) {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required for PostgreSQL admin bootstrap.");
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", ["ownminutes-admin-bootstrap-v1"]);
    const adminResult = await client.query("select id from users where role = 'admin' and deleted_at is null order by created_at asc limit 1");
    if (adminResult.rows[0]) {
      await client.query("commit");
      return { action: "already-configured", userId: adminResult.rows[0].id };
    }
    const userCount = Number((await client.query("select count(*)::int as value from users")).rows[0]?.value || 0);
    if (userCount > 0) throw new Error("Refusing automatic admin creation because PostgreSQL already contains users but no active admin.");

    const now = new Date().toISOString();
    const userId = createId("user");
    await client.query(
      `insert into users
        (id, email, name, role, plan, free_trial_minutes_total, free_trial_minutes_used, free_trial_granted_at,
         official_minutes_total, official_minutes_used, official_minutes_period_start_at, official_minutes_period_source,
         password_salt, password_hash, created_at, email_verified_at)
       values ($1,$2,$3,'admin','free',60,0,$6,60,0,$6,'free_trial',$4,$5,$6,$6)`,
      [userId, email, name, passwordRecord.salt, passwordRecord.hash, now],
    );
    await client.query("insert into usage_events (id, user_id, type, minutes, created_at, note) values ($1,$2,'register_bonus',60,$3,$4)", [
      createId("usage"),
      userId,
      now,
      "Free plan official trial quota",
    ]);
    await client.query("insert into growth_events (id, user_id, type, source, created_at) values ($1,$2,'register',$3,$4)", [
      createId("growth"),
      userId,
      "direct",
      now,
    ]);
    await client.query("commit");
    return { action: "created", userId };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const hash = crypto.scryptSync(password, salt, 64).toString("base64url");
  return { salt, hash };
}

function createId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("base64url")}`;
}

function atomicWriteJson(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || "" : "";
}
