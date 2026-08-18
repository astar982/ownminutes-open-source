#!/usr/bin/env node

const host = required("OWNMINUTES_DATABASE_HOST");
const port = process.env.OWNMINUTES_DATABASE_PORT || "5432";
const database = required("OWNMINUTES_DATABASE_NAME");
const bootstrapRole = roleName(process.env.OWNMINUTES_DATABASE_BOOTSTRAP_ROLE || "postgres");
const legacyBootstrapRole = roleName(
  process.env.OWNMINUTES_DATABASE_LEGACY_BOOTSTRAP_ROLE || "ownminutes_app",
);
const ownerRole = roleName(process.env.OWNMINUTES_DATABASE_OWNER_ROLE || "ownminutes_owner");
const migratorRole = roleName(process.env.OWNMINUTES_DATABASE_MIGRATOR_ROLE || "ownminutes_migrator");
const appRole = roleName(process.env.OWNMINUTES_DATABASE_APP_ROLE || "ownminutes_runtime");
const bootstrapPassword = required("POSTGRES_OWNER_PASSWORD");
const migratorPassword = required("POSTGRES_MIGRATOR_PASSWORD");
const appPassword = required("POSTGRES_APP_PASSWORD");

const { Client } = await import("pg");
const candidates = [
  { password: bootstrapPassword, user: bootstrapRole },
  { password: bootstrapPassword, user: legacyBootstrapRole },
];

let client;
for (const candidate of candidates) {
  const probe = new Client({
    database,
    host,
    password: candidate.password,
    port: Number(port),
    user: candidate.user,
  });
  try {
    await probe.connect();
    client = probe;
    break;
  } catch {
    await probe.end().catch(() => {});
  }
}

if (!client) {
  throw new Error("Unable to authenticate PostgreSQL role bootstrap with the cluster bootstrap or legacy application role.");
}

const lockKey = [1836021357, 1919907699];
let sessionRole = "";

try {
  await client.query("select pg_advisory_lock($1, $2)", lockKey);
  const session = await client.query(
    "select current_user as role, rolsuper from pg_roles where rolname = current_user",
  );
  sessionRole = String(session.rows[0]?.role || "");
  if (![legacyBootstrapRole, bootstrapRole].includes(sessionRole) || session.rows[0]?.rolsuper !== true) {
    throw new Error("PostgreSQL role bootstrap requires the isolated cluster bootstrap superuser.");
  }

  await client.query("begin");
  if (!(await existsRole(client, bootstrapRole))) {
    await client.query(
      `create role ${identifier(bootstrapRole)} login superuser password ${literal(bootstrapPassword)}`,
    );
  } else {
    await client.query(
      `alter role ${identifier(bootstrapRole)} login superuser password ${literal(bootstrapPassword)}`,
    );
  }

  if (!(await existsRole(client, ownerRole))) {
    await client.query(
      `create role ${identifier(ownerRole)} nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls`,
    );
  } else {
    await client.query(
      `alter role ${identifier(ownerRole)} nologin nocreatedb nocreaterole noinherit noreplication nobypassrls nosuperuser`,
    );
  }

  const databaseOwner = await client.query(
    "select pg_get_userbyid(datdba) as owner from pg_database where datname = $1",
    [database],
  );
  const approvedLegacyOwners = new Set([
    databaseOwner.rows[0]?.owner,
    bootstrapRole,
    legacyBootstrapRole,
  ]);
  for (const previousOwner of approvedLegacyOwners) {
    await transferPublicObjects(client, previousOwner, ownerRole);
  }
  if (databaseOwner.rows[0]?.owner !== ownerRole) {
    await client.query(`alter database ${identifier(database)} owner to ${identifier(ownerRole)}`);
  }
  await client.query(`alter schema public owner to ${identifier(ownerRole)}`);

  await ensureLoginRole(client, migratorRole, migratorPassword);
  await ensureLoginRole(client, appRole, appPassword);
  await client.query(`revoke ${identifier(migratorRole)} from ${identifier(ownerRole)}`);
  await client.query(`revoke ${identifier(ownerRole)} from ${identifier(appRole)}`);
  await client.query(
    `grant ${identifier(ownerRole)} to ${identifier(migratorRole)} with inherit false, set true`,
  );

  await client.query(`revoke all on database ${identifier(database)} from public`);
  await client.query(
    `grant connect on database ${identifier(database)} to ${identifier(migratorRole)}, ${identifier(appRole)}`,
  );
  await client.query("revoke create on schema public from public");
  await client.query(`grant usage on schema public to ${identifier(migratorRole)}, ${identifier(appRole)}`);

  await client.query(
    `alter role ${identifier(migratorRole)} login nocreatedb nocreaterole noinherit noreplication nobypassrls nosuperuser password ${literal(migratorPassword)}`,
  );
  await client.query(
    `alter role ${identifier(appRole)} login nocreatedb nocreaterole noinherit noreplication nobypassrls nosuperuser password ${literal(appPassword)}`,
  );
  if (sessionRole === legacyBootstrapRole && legacyBootstrapRole !== appRole) {
    await client.query(`alter role ${identifier(legacyBootstrapRole)} nologin`);
  }
  await client.query("commit");

  const roles = await client.query(
    "select rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls from pg_roles where rolname = any($1::text[]) order by rolname",
    [[ownerRole, migratorRole, appRole]],
  );
  const owner = roles.rows.find((role) => role.rolname === ownerRole);
  const app = roles.rows.find((role) => role.rolname === appRole);
  const migrator = roles.rows.find((role) => role.rolname === migratorRole);
  if (
    !owner ||
    owner.rolcanlogin ||
    hasClusterPrivilege(owner) ||
    !app?.rolcanlogin ||
    hasClusterPrivilege(app) ||
    !migrator?.rolcanlogin ||
    hasClusterPrivilege(migrator)
  ) {
    throw new Error("PostgreSQL owner, migrator, or runtime role retained elevated cluster privileges.");
  }
  if (!(await hasMembership(client, migratorRole, ownerRole))) {
    throw new Error("The PostgreSQL migrator is missing SET membership in the database owner role.");
  }

  console.log(
    JSON.stringify(
      {
        appRole,
        bootstrapRole,
        database,
        migratorRole,
        ok: true,
        ownerRole,
        upgradedLegacyVolume: sessionRole === legacyBootstrapRole,
      },
      null,
      2,
    ),
  );
} catch (error) {
  await client.query("rollback").catch(() => {});
  throw error;
} finally {
  await client.query("select pg_advisory_unlock($1, $2)", lockKey).catch(() => {});
  await client.end();
}

async function ensureLoginRole(connection, role, password) {
  if (await existsRole(connection, role)) {
    await connection.query(`alter role ${identifier(role)} login password ${literal(password)}`);
    return;
  }
  await connection.query(
    `create role ${identifier(role)} login password ${literal(password)} nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls`,
  );
}

async function existsRole(connection, role) {
  const result = await connection.query("select 1 from pg_roles where rolname = $1", [role]);
  return Boolean(result.rowCount);
}

async function hasMembership(connection, member, grantedRole) {
  const result = await connection.query("select pg_has_role($1, $2, 'member') as allowed", [
    member,
    grantedRole,
  ]);
  return result.rows[0]?.allowed === true;
}

async function transferPublicObjects(connection, previousOwner, nextOwner) {
  if (!previousOwner || previousOwner === nextOwner) return;
  const relations = await connection.query(
    `select c.relkind, c.relname
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_roles r on r.oid = c.relowner
      where n.nspname = 'public'
        and r.rolname = $1
        and c.relkind = any($2::"char"[])
      order by c.relkind, c.relname`,
    [previousOwner, ["r", "p", "v", "m", "S", "f"]],
  );
  const commands = {
    f: "foreign table",
    m: "materialized view",
    p: "table",
    r: "table",
    S: "sequence",
    v: "view",
  };
  for (const relation of relations.rows) {
    await connection.query(
      `alter ${commands[relation.relkind]} public.${identifier(relation.relname)} owner to ${identifier(nextOwner)}`,
    );
  }

  const functions = await connection.query(
    `select p.proname, pg_get_function_identity_arguments(p.oid) as arguments
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       join pg_roles r on r.oid = p.proowner
      where n.nspname = 'public' and r.rolname = $1
      order by p.proname, arguments`,
    [previousOwner],
  );
  for (const fn of functions.rows) {
    await connection.query(
      `alter function public.${identifier(fn.proname)}(${fn.arguments}) owner to ${identifier(nextOwner)}`,
    );
  }
}

function hasClusterPrivilege(role) {
  return Boolean(
    role.rolsuper ||
      role.rolcreatedb ||
      role.rolcreaterole ||
      role.rolreplication ||
      role.rolbypassrls,
  );
}

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value || /[\0\r\n]/.test(value)) {
    throw new Error(`${name} is required and must be single-line text.`);
  }
  return value;
}

function roleName(value) {
  if (!/^[a-z][a-z0-9_]{2,62}$/.test(value)) {
    throw new Error("PostgreSQL role names must use lowercase letters, numbers, and underscores.");
  }
  return value;
}

function identifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function literal(value) {
  return `'${value.replaceAll("'", "''")}'`;
}
