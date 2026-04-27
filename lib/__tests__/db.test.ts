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

test("recordWebhookEvent stores a new event and dedups on event_id", async () => {
  const { recordWebhookEvent, recentEventsForObject } = await import("../db.ts");
  const ev = {
    eventId: "evt-1",
    subscriptionType: "company.propertyChange",
    objectId: "co-42",
    propertyName: "portal_status_update",
    propertyValue: "24/04/2026 15:45:18.829: Company created successfully",
    occurredAt: "2026-04-24T15:45:18.829Z",
    rawJson: JSON.stringify({ eventId: "evt-1" }),
  };
  assert.equal(recordWebhookEvent(ev), true);
  // Same eventId — HubSpot retry — must be ignored.
  assert.equal(recordWebhookEvent(ev), false);
  const rows = recentEventsForObject("co-42", "portal_status_update");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].property_value, ev.propertyValue);
});

test("recentEventsForObject returns most recent first and respects limit + sinceIso", async () => {
  const { recordWebhookEvent, recentEventsForObject } = await import("../db.ts");
  recordWebhookEvent({
    eventId: "e-old",
    subscriptionType: "company.propertyChange",
    objectId: "co-7",
    propertyName: "portal_status_update",
    propertyValue: "old",
    occurredAt: "2026-04-24T10:00:00.000Z",
    rawJson: "{}",
  });
  recordWebhookEvent({
    eventId: "e-new",
    subscriptionType: "company.propertyChange",
    objectId: "co-7",
    propertyName: "portal_status_update",
    propertyValue: "new",
    occurredAt: "2026-04-24T11:00:00.000Z",
    rawJson: "{}",
  });
  const all = recentEventsForObject("co-7", "portal_status_update");
  assert.equal(all.length, 2);
  assert.equal(all[0].property_value, "new");
  const since = recentEventsForObject(
    "co-7",
    "portal_status_update",
    "2026-04-24T10:30:00.000Z"
  );
  assert.equal(since.length, 1);
  assert.equal(since[0].property_value, "new");
  const limited = recentEventsForObject("co-7", "portal_status_update", undefined, 1);
  assert.equal(limited.length, 1);
});

test("recentEventsForObject returns empty when no events match", async () => {
  const { recentEventsForObject } = await import("../db.ts");
  assert.deepEqual(recentEventsForObject("does-not-exist", "portal_status_update"), []);
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
