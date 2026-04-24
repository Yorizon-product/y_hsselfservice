import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point DATA_DIR at a per-test-run temp dir BEFORE importing the db
// module — the module resolves DATA_DIR lazily inside getDb() so this
// works as long as nobody imports it before we set the env.
let tempDir: string;

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), "hsselfservice-db-test-"));
  process.env.DATA_DIR = tempDir;
});

beforeEach(async () => {
  const mod = await import("../db.ts");
  mod._resetForTests();
  // Wipe on-disk state between tests.
  rmSync(tempDir, { recursive: true, force: true });
});

test("getDb creates the file and runs migrations idempotently", async () => {
  const { getDb, _resetForTests } = await import("../db.ts");
  const db1 = getDb();
  const tables = db1
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r: any) => r.name);
  assert.ok(tables.includes("jobs"));
  assert.ok(tables.includes("idempotency_keys"));
  assert.ok(tables.includes("schema_migrations"));

  const migrationsBefore = db1
    .prepare("SELECT COUNT(*) as c FROM schema_migrations")
    .get() as { c: number };
  assert.ok(migrationsBefore.c >= 1);

  _resetForTests();
  const db2 = getDb();
  const migrationsAfter = db2
    .prepare("SELECT COUNT(*) as c FROM schema_migrations")
    .get() as { c: number };
  assert.equal(migrationsAfter.c, migrationsBefore.c);
});

test("jobs table accepts a valid insert and enforces status CHECK", async () => {
  const { getDb } = await import("../db.ts");
  const db = getDb();
  db.prepare(
    `INSERT INTO jobs (id, status, payload_json) VALUES (?, ?, ?)`
  ).run("job-1", "pending", "{}");
  const row = db.prepare("SELECT * FROM jobs WHERE id=?").get("job-1") as any;
  assert.equal(row.status, "pending");
  assert.equal(row.payload_json, "{}");

  assert.throws(() => {
    db.prepare(
      `INSERT INTO jobs (id, status, payload_json) VALUES (?, ?, ?)`
    ).run("job-2", "nonsense", "{}");
  }, /CHECK/);
});

test("claimIdempotencyKey returns true once, false for duplicate within TTL", async () => {
  const { claimIdempotencyKey } = await import("../db.ts");
  assert.equal(claimIdempotencyKey("abc"), true);
  assert.equal(claimIdempotencyKey("abc"), false);
  assert.equal(claimIdempotencyKey("def"), true);
});

test("claimIdempotencyKey re-accepts a key after the TTL prunes it", async () => {
  const { claimIdempotencyKey, getDb } = await import("../db.ts");
  assert.equal(claimIdempotencyKey("ttl-key"), true);
  // Force-age the row so the TTL prune sees it as expired. SQLite's
  // datetime('now') writes local-ish UTC; set explicitly.
  getDb()
    .prepare("UPDATE idempotency_keys SET created_at = datetime('now', '-60 seconds') WHERE key=?")
    .run("ttl-key");
  assert.equal(claimIdempotencyKey("ttl-key", 30), true);
});
