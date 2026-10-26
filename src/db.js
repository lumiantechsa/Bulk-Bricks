// Database access. Production uses PostgreSQL through DATABASE_URL (Railway
// Postgres, Supabase or any other Postgres). Without it, an embedded Postgres
// (PGlite) keeps the data in a local folder, which is handy for development;
// tests run it in memory. Both speak the same SQL, so there is one code path.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(here, "..", "migrations");
const CHANNEL = "app_events";

/**
 * @param {{url?: string, dir?: string | null}} options  `url` for Postgres; otherwise `dir`
 *   for an embedded database (null or omitted = in memory).
 */
export async function openDatabase({ url, dir } = {}) {
  const db = url ? await openPostgres(url) : await openPglite(dir);
  await migrate(db);
  return db;
}

async function openPostgres(url) {
  const { default: pg } = await import("pg");
  const local = /localhost|127\.0\.0\.1|\.railway\.internal/.test(url);
  const ssl = /sslmode=disable/.test(url) || local ? false : { rejectUnauthorized: false };
  const pool = new pg.Pool({ connectionString: url, ssl, max: 10 });
  // An idle connection dropped by the server must not crash the process.
  pool.on("error", (err) => console.error("Database connection error", err.message));
  const listeners = new Set();
  let listener = null;
  let closed = false;

  // One dedicated connection listens for changes made by any server instance.
  const startListening = async () => {
    listener = new pg.Client({ connectionString: url, ssl });
    listener.on("notification", (msg) => {
      for (const fn of listeners) fn(msg.payload);
    });
    listener.on("error", (err) => {
      listener = null;
      if (closed) return;
      console.error("Database listener lost, reconnecting", err.message);
      setTimeout(() => startListening().catch((e) => console.error("Reconnect failed", e.message)), 2000);
    });
    await listener.connect();
    await listener.query(`LISTEN ${CHANNEL}`);
  };

  return {
    kind: "postgres",
    query: (sql, params) => pool.query(sql, params),
    exec: (sql) => pool.query(sql),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({ query: (sql, params) => client.query(sql, params) });
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async onEvent(fn) {
      listeners.add(fn);
      if (!listener) await startListening();
    },
    notify: (payload) => pool.query("SELECT pg_notify($1, $2)", [CHANNEL, JSON.stringify(payload)]),
    async close() {
      closed = true;
      await listener?.end().catch(() => {});
      await pool.end();
    },
  };
}

async function openPglite(dir) {
  const { PGlite } = await import("@electric-sql/pglite");
  if (dir) fs.mkdirSync(dir, { recursive: true });
  const pglite = dir ? new PGlite(dir) : new PGlite();
  await pglite.waitReady;
  return {
    kind: "pglite",
    query: (sql, params) => pglite.query(sql, params),
    exec: (sql) => pglite.exec(sql),
    transaction: (fn) => pglite.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
    onEvent: (fn) => pglite.listen(CHANNEL, fn),
    notify: (payload) => pglite.query("SELECT pg_notify($1, $2)", [CHANNEL, JSON.stringify(payload)]),
    close: () => pglite.close(),
  };
}

/**
 * One in-memory database that holds many isolated schemas: the demo sandboxes.
 * Created on demand, so a server without demo visitors doesn't pay for it.
 */
export async function openSandboxHost() {
  const { PGlite } = await import("@electric-sql/pglite");
  const pglite = new PGlite();
  await pglite.waitReady;
  return pglite;
}

/**
 * A database confined to its own schema on the sandbox host. Every query runs
 * in a transaction that sets the search path to that schema first, so it can
 * only see its own tables. Same interface as openDatabase(); close() drops it.
 */
export async function openSchemaDatabase(pglite, schema) {
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(schema)) throw new Error(`Invalid schema name: ${schema}`);
  await pglite.exec(`CREATE SCHEMA ${schema}`);
  const scoped = (fn) =>
    pglite.transaction(async (tx) => {
      await tx.query(`SET LOCAL search_path TO ${schema}`);
      return fn(tx);
    });
  const channel = `app_events_${schema}`;
  const unlisten = [];
  const db = {
    kind: "sandbox",
    query: (sql, params) => scoped((tx) => tx.query(sql, params)),
    exec: (sql) => scoped((tx) => tx.exec(sql)),
    transaction: (fn) => scoped((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
    async onEvent(fn) {
      unlisten.push(await pglite.listen(channel, fn));
    },
    notify: (payload) => pglite.query("SELECT pg_notify($1, $2)", [channel, JSON.stringify(payload)]),
    async close() {
      for (const stop of unlisten.splice(0)) await stop();
      await pglite.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    },
  };
  await migrate(db);
  return db;
}

/** Applies every migrations/*.sql file that hasn't run yet, in name order. */
async function migrate(db) {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    await db.transaction(async (tx) => {
      // Several instances may start together; the lock makes one of them migrate.
      await tx.query("SELECT pg_advisory_xact_lock(424242)");
      const again = await tx.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
      if (again.rows.length) return;
      for (const statement of splitSql(sql)) await tx.query(statement);
      await tx.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    });
  }
}

// Migrations are plain statements separated by semicolons at the end of a line.
const splitSql = (sql) =>
  sql
    .replace(/--.*$/gm, "")
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
