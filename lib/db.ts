import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve, isAbsolute } from "node:path";

// SQLite wrapper for self-hosted state. Two tables today:
//   - jobs: one row per create-flow invocation (pending / running /
//     succeeded / failed), carries the full payload + created IDs for
//     the worker to resume or roll back.
//   - idempotency_keys: replaces the in-memory Set from the Vercel era.
//     Survives restarts, de-dupes by row-insert + TTL cleanup.

const DEFAULT_DATA_DIR = "./data";

export type JobStatus = "pending" | "running" | "succeeded" | "failed";

export type JobRow = {
  id: string;
  user_email: string | null;
  status: JobStatus;
  phase: string | null;
  payload_json: string;
  created_json: string;
  tracked_ids_json: string;
  error: string | null;
  raw_status: string | null;
  code: string | null;
  kept_json: string | null;
  created_at: string;
  updated_at: string;
};

let _db: Database.Database | null = null;

function dataDir(): string {
  const raw = process.env.DATA_DIR && process.env.DATA_DIR.length > 0
    ? process.env.DATA_DIR
    : DEFAULT_DATA_DIR;
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

export function dbPath(): string {
  return resolve(dataDir(), "hsselfservice.db");
}

export function getDb(): Database.Database {
  if (_db) return _db;
  const path = dbPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  _db = db;
  return db;
}

// Tiny migration runner. Keeps schema versioning explicit and survives
// restarts; each migration runs at most once. Order matters: never
// reorder or mutate a past entry — add new ones at the bottom.
const MIGRATIONS: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: "init_jobs_and_idempotency",
    sql: `
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        user_email TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed')),
        phase TEXT,
        payload_json TEXT NOT NULL,
        created_json TEXT NOT NULL DEFAULT '[]',
        tracked_ids_json TEXT NOT NULL DEFAULT '[]',
        error TEXT,
        raw_status TEXT,
        code TEXT,
        kept_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_status_created
        ON jobs(status, created_at);

      CREATE TABLE IF NOT EXISTS idempotency_keys (
        key TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    id: 2,
    name: "webhook_events",
    sql: `
      CREATE TABLE IF NOT EXISTS webhook_events (
        event_id TEXT PRIMARY KEY,
        subscription_type TEXT NOT NULL,
        object_id TEXT NOT NULL,
        property_name TEXT,
        property_value TEXT,
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL DEFAULT (datetime('now')),
        raw_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_webhook_events_object_property
        ON webhook_events(object_id, property_name, occurred_at);
    `,
  },
];

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const applied = new Set(
    db.prepare("SELECT id FROM schema_migrations").all().map((r: any) => r.id)
  );
  const insert = db.prepare(
    "INSERT INTO schema_migrations (id, name) VALUES (?, ?)"
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      insert.run(m.id, m.name);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

// For tests only — wipes connection state so a fresh `getDb()` reopens
// against whatever DATA_DIR points to.
export function _resetForTests(): void {
  if (_db) _db.close();
  _db = null;
}

// Idempotency helper. Returns true if the key is newly recorded; false
// if it was already seen within the TTL window. TTL swept lazily on
// insert (prune keys older than 30s) to keep the table bounded without
// needing a background task.
export function claimIdempotencyKey(key: string, ttlSeconds = 30): boolean {
  const db = getDb();
  // Prune first.
  db.prepare(
    `DELETE FROM idempotency_keys WHERE created_at < datetime('now', ? )`
  ).run(`-${ttlSeconds} seconds`);
  // Then try to claim.
  try {
    db.prepare("INSERT INTO idempotency_keys (key) VALUES (?)").run(key);
    return true;
  } catch (e: any) {
    if (typeof e?.message === "string" && e.message.includes("UNIQUE")) {
      return false;
    }
    throw e;
  }
}

// ─── webhook_events helpers ────────────────────────────────────────────

export type WebhookEventRow = {
  event_id: string;
  subscription_type: string;
  object_id: string;
  property_name: string | null;
  property_value: string | null;
  occurred_at: string;
  received_at: string;
  raw_json: string;
};

export type WebhookEventInput = {
  eventId: string;
  subscriptionType: string;
  objectId: string;
  propertyName?: string | null;
  propertyValue?: string | null;
  occurredAt: string;
  rawJson: string;
};

const WEBHOOK_EVENT_RETENTION_DAYS = 30;

// Insert if new. Returns true if persisted, false if a row with the same
// event_id already existed (HubSpot retry). Lazy-prunes events older
// than the retention window on each insert to keep the table bounded.
export function recordWebhookEvent(e: WebhookEventInput): boolean {
  const db = getDb();
  db.prepare(
    `DELETE FROM webhook_events WHERE received_at < datetime('now', ? )`
  ).run(`-${WEBHOOK_EVENT_RETENTION_DAYS} days`);
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO webhook_events
        (event_id, subscription_type, object_id, property_name, property_value, occurred_at, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      e.eventId,
      e.subscriptionType,
      e.objectId,
      e.propertyName ?? null,
      e.propertyValue ?? null,
      e.occurredAt,
      e.rawJson
    );
  return res.changes === 1;
}

// Returns the most recent webhook events for the given object+property,
// in time-descending order. Used by the worker's "did the event already
// arrive before I started waiting?" check.
export function recentEventsForObject(
  objectId: string,
  propertyName: string,
  sinceIso?: string,
  limit = 10
): WebhookEventRow[] {
  const db = getDb();
  if (sinceIso) {
    return db
      .prepare(
        `SELECT * FROM webhook_events
         WHERE object_id = ? AND property_name = ? AND occurred_at >= ?
         ORDER BY occurred_at DESC
         LIMIT ?`
      )
      .all(objectId, propertyName, sinceIso, limit) as WebhookEventRow[];
  }
  return db
    .prepare(
      `SELECT * FROM webhook_events
       WHERE object_id = ? AND property_name = ?
       ORDER BY occurred_at DESC
       LIMIT ?`
    )
    .all(objectId, propertyName, limit) as WebhookEventRow[];
}
