import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), "hsselfservice-waiter-test-"));
  process.env.DATA_DIR = tempDir;
});

beforeEach(async () => {
  const mod = await import("../db.ts");
  mod._resetForTests();
  rmSync(tempDir, { recursive: true, force: true });
});

const CREATED_AT = new Date("2026-04-24T15:00:00.000Z");
const STATUS_OK = "24/04/2026 15:00:30.000: Company created successfully";
const STATUS_UPD = "24/04/2026 15:00:31.000: Company updated successfully";
const STATUS_FAIL = "24/04/2026 15:00:31.000: Company creation failed";

test("resolves immediately when a success event already exists in the DB (initial sweep)", async () => {
  const { recordWebhookEvent } = await import("../db.ts");
  recordWebhookEvent({
    eventId: "e1",
    subscriptionType: "company.propertyChange",
    objectId: "co-1",
    propertyName: "portal_status_update",
    propertyValue: STATUS_OK,
    occurredAt: "2026-04-24T15:00:30.000Z",
    rawJson: "{}",
  });
  const { waitForPortalStatusViaWebhook } = await import("../portal-status-waiter.ts");
  await waitForPortalStatusViaWebhook("co-1", CREATED_AT, {
    totalTimeoutMs: 1_000,
    fallbackTickMs: 100_000,
  });
});

test("resolves when a live event is emitted after subscribing", async () => {
  const { waitForPortalStatusViaWebhook } = await import("../portal-status-waiter.ts");
  const { emitPortalStatusEvent } = await import("../portal-status-events.ts");
  const promise = waitForPortalStatusViaWebhook("co-2", CREATED_AT, {
    totalTimeoutMs: 1_000,
    fallbackTickMs: 100_000,
  });
  // Emit shortly after the waiter is set up.
  setTimeout(() => emitPortalStatusEvent("co-2", STATUS_UPD, "2026-04-24T15:00:31.000Z"), 10);
  await promise;
});

test("rejects with PORTAL_CREATION_FAILED when status classifies as failed", async () => {
  const { waitForPortalStatusViaWebhook } = await import("../portal-status-waiter.ts");
  const { emitPortalStatusEvent } = await import("../portal-status-events.ts");
  const promise = waitForPortalStatusViaWebhook("co-3", CREATED_AT, {
    totalTimeoutMs: 1_000,
    fallbackTickMs: 100_000,
  });
  setTimeout(() => emitPortalStatusEvent("co-3", STATUS_FAIL, "2026-04-24T15:00:31.000Z"), 10);
  await assert.rejects(promise, (err: any) => err.code === "PORTAL_CREATION_FAILED");
});

test("ignores events for other companies", async () => {
  const { waitForPortalStatusViaWebhook } = await import("../portal-status-waiter.ts");
  const { emitPortalStatusEvent } = await import("../portal-status-events.ts");
  const promise = waitForPortalStatusViaWebhook("co-4", CREATED_AT, {
    totalTimeoutMs: 200,
    fallbackTickMs: 100_000,
  });
  // Wrong company — should NOT resolve.
  setTimeout(() => emitPortalStatusEvent("co-other", STATUS_OK, "2026-04-24T15:00:30.000Z"), 10);
  await assert.rejects(promise, (err: any) => err.code === "PORTAL_TIMEOUT");
});

test("times out when no event arrives within totalTimeoutMs", async () => {
  const { waitForPortalStatusViaWebhook } = await import("../portal-status-waiter.ts");
  await assert.rejects(
    waitForPortalStatusViaWebhook("co-5", CREATED_AT, {
      totalTimeoutMs: 50,
      fallbackTickMs: 1_000_000,
    }),
    (err: any) => err.code === "PORTAL_TIMEOUT"
  );
});

test("fallback tick re-checks the DB and resolves when a row appears", async () => {
  const { waitForPortalStatusViaWebhook } = await import("../portal-status-waiter.ts");
  const { recordWebhookEvent } = await import("../db.ts");
  const promise = waitForPortalStatusViaWebhook("co-6", CREATED_AT, {
    totalTimeoutMs: 500,
    fallbackTickMs: 30,
  });
  // Simulate a webhook that lands but the in-process bus signal is missed
  // (e.g. a webhook to this Node hasn't been wired to our emitter for
  // some reason). The DB row still appears, fallback should pick it up.
  setTimeout(() => {
    recordWebhookEvent({
      eventId: "e-late",
      subscriptionType: "company.propertyChange",
      objectId: "co-6",
      propertyName: "portal_status_update",
      propertyValue: STATUS_OK,
      occurredAt: "2026-04-24T15:00:30.000Z",
      rawJson: "{}",
    });
  }, 50);
  await promise;
});

test("ignores stale events (timestamp before companyCreatedAt - skew)", async () => {
  const { recordWebhookEvent } = await import("../db.ts");
  // Stale event: occurredAt is BEFORE companyCreatedAt. The sinceIso
  // filter in recentEventsForObject excludes these from the initial
  // sweep entirely.
  recordWebhookEvent({
    eventId: "e-stale",
    subscriptionType: "company.propertyChange",
    objectId: "co-7",
    propertyName: "portal_status_update",
    propertyValue: STATUS_OK,
    occurredAt: "2026-04-24T14:30:00.000Z",
    rawJson: "{}",
  });
  const { waitForPortalStatusViaWebhook } = await import("../portal-status-waiter.ts");
  await assert.rejects(
    waitForPortalStatusViaWebhook("co-7", CREATED_AT, {
      totalTimeoutMs: 50,
      fallbackTickMs: 1_000_000,
    }),
    (err: any) => err.code === "PORTAL_TIMEOUT"
  );
});
