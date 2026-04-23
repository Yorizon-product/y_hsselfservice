import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseStatus,
  classifyStatus,
  pollCompanyReadiness,
  PortalStatusError,
  SUCCESS_MESSAGES,
  TERMINAL_FAILURE_MESSAGES,
} from "../portal-status.ts";

/* parseStatus */

test("parseStatus returns null for empty, null, undefined", () => {
  assert.equal(parseStatus(null), null);
  assert.equal(parseStatus(undefined), null);
  assert.equal(parseStatus(""), null);
  assert.equal(parseStatus("   "), null);
});

test("parseStatus returns null when format is malformed", () => {
  assert.equal(parseStatus("no timestamp here"), null);
  assert.equal(parseStatus("2026-04-22 10:00:00.000: Company created successfully"), null); // wrong date order
  assert.equal(parseStatus("22/04/2026 10:00:00: missing millis"), null);
  assert.equal(parseStatus("22/04/2026 10:00:00.000 Company created successfully"), null); // missing colon
});

test("parseStatus extracts timestamp and trimmed message for valid success value", () => {
  const parsed = parseStatus("22/04/2026 10:00:05.123: Company created successfully");
  assert.ok(parsed);
  assert.equal(parsed!.message, "Company created successfully");
  assert.equal(parsed!.timestamp.toISOString(), "2026-04-22T10:00:05.123Z");
});

test("parseStatus extracts failure messages", () => {
  const parsed = parseStatus("06/01/2026 13:54:19.316: Company creation failed");
  assert.ok(parsed);
  assert.equal(parsed!.message, "Company creation failed");
});

test("parseStatus trims leading/trailing whitespace in message", () => {
  const parsed = parseStatus("22/04/2026 10:00:05.123:    Company created successfully   ");
  assert.ok(parsed);
  assert.equal(parsed!.message, "Company created successfully");
});

test("parseStatus handles the whole raw input being padded", () => {
  const parsed = parseStatus("  22/04/2026 10:00:05.123: Company created successfully  ");
  assert.ok(parsed);
  assert.equal(parsed!.message, "Company created successfully");
});

/* classifyStatus */

const companyCreatedAt = new Date("2026-04-22T10:00:00.000Z");

test("classifyStatus returns pending for null parse", () => {
  assert.equal(classifyStatus(null, companyCreatedAt), "pending");
});

test("classifyStatus returns success for allowlisted success message within skew", () => {
  const parsed = parseStatus("22/04/2026 10:00:05.000: Company created successfully")!;
  assert.equal(classifyStatus(parsed, companyCreatedAt), "success");
});

test("classifyStatus returns failed for allowlisted failure message", () => {
  const parsed = parseStatus("22/04/2026 10:00:05.000: Company creation failed")!;
  assert.equal(classifyStatus(parsed, companyCreatedAt), "failed");
});

test("classifyStatus returns unexpected for unknown message", () => {
  const parsed = parseStatus("22/04/2026 10:00:05.000: Company updated successfully")!;
  assert.equal(classifyStatus(parsed, companyCreatedAt), "unexpected");
});

test("classifyStatus treats stale timestamp (beyond 2s skew) as pending", () => {
  // 3 seconds before createdAt, outside the 2s allowance.
  const parsed = parseStatus("22/04/2026 09:59:57.000: Company created successfully")!;
  assert.equal(classifyStatus(parsed, companyCreatedAt), "pending");
});

test("classifyStatus accepts timestamp within 2s skew before createdAt", () => {
  // 1.5 seconds before createdAt, inside the 2s allowance.
  const parsed = parseStatus("22/04/2026 09:59:58.500: Company created successfully")!;
  assert.equal(classifyStatus(parsed, companyCreatedAt), "success");
});

/* pollCompanyReadiness */

function makeFetch(responses: (string | null)[]) {
  let i = 0;
  return async () => {
    const raw = responses[i++];
    return new Response(
      JSON.stringify({ properties: { portal_status_update: raw } }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
}

test("pollCompanyReadiness returns on first-attempt success", async () => {
  const logs: string[] = [];
  await pollCompanyReadiness(
    "tok",
    "123",
    companyCreatedAt,
    (l) => logs.push(l),
    {
      delaysMs: [0, 10, 30],
      sleep: async () => {},
      fetchImpl: makeFetch(["22/04/2026 10:00:02.000: Company created successfully"]) as any,
    }
  );
  assert.equal(logs.length, 1);
  assert.match(logs[0], /poll 1\/3 company=123 .* class=success/);
});

test("pollCompanyReadiness keeps polling through failure and succeeds on later retry (Yorizon retry pattern)", async () => {
  // Yorizon's automation has been observed to write 'failed' first then
  // 'successfully' ~80s later on its own retry. We must not short-circuit.
  const fetchImpl = makeFetch([
    "22/04/2026 10:00:02.000: Company creation failed",
    "22/04/2026 10:00:02.000: Company creation failed",
    "22/04/2026 10:01:30.000: Company created successfully",
  ]);
  const logs: string[] = [];
  await pollCompanyReadiness(
    "tok",
    "123",
    companyCreatedAt,
    (l) => logs.push(l),
    { delaysMs: [0, 10, 30], sleep: async () => {}, fetchImpl: fetchImpl as any }
  );
  assert.equal(logs.length, 3);
  assert.match(logs[0], /poll 1\/3 .* class=failed/);
  assert.match(logs[1], /poll 2\/3 .* class=failed/);
  assert.match(logs[2], /poll 3\/3 .* class=success/);
});

test("pollCompanyReadiness throws PORTAL_CREATION_FAILED when all polls return failed", async () => {
  const fetchImpl = makeFetch([
    "22/04/2026 10:00:02.000: Company creation failed",
    "22/04/2026 10:00:02.000: Company creation failed",
    "22/04/2026 10:00:02.000: Company creation failed",
  ]);
  await assert.rejects(
    pollCompanyReadiness(
      "tok",
      "123",
      companyCreatedAt,
      () => {},
      { delaysMs: [0, 10, 30], sleep: async () => {}, fetchImpl: fetchImpl as any }
    ),
    (err: any) => err instanceof PortalStatusError && err.code === "PORTAL_CREATION_FAILED"
  );
});

test("pollCompanyReadiness throws PORTAL_TIMEOUT when all three polls return empty", async () => {
  await assert.rejects(
    pollCompanyReadiness(
      "tok",
      "123",
      companyCreatedAt,
      () => {},
      {
        delaysMs: [0, 10, 30],
        sleep: async () => {},
        fetchImpl: makeFetch([null, null, null]) as any,
      }
    ),
    (err: any) => err instanceof PortalStatusError && err.code === "PORTAL_TIMEOUT"
  );
});

test("pollCompanyReadiness throws PORTAL_UNEXPECTED_STATE when budget exhausts with unknown message", async () => {
  await assert.rejects(
    pollCompanyReadiness(
      "tok",
      "123",
      companyCreatedAt,
      () => {},
      {
        delaysMs: [0, 10, 30],
        sleep: async () => {},
        fetchImpl: makeFetch([
          null,
          "22/04/2026 10:00:15.000: Company updated successfully",
          "22/04/2026 10:00:35.000: Company updated successfully",
        ]) as any,
      }
    ),
    (err: any) => err instanceof PortalStatusError && err.code === "PORTAL_UNEXPECTED_STATE"
  );
});

test("pollCompanyReadiness succeeds on the final retry", async () => {
  let calls = 0;
  await pollCompanyReadiness(
    "tok",
    "123",
    companyCreatedAt,
    () => { calls++; },
    {
      delaysMs: [0, 10, 30],
      sleep: async () => {},
      fetchImpl: makeFetch([
        null,
        null,
        "22/04/2026 10:00:35.000: Company created successfully",
      ]) as any,
    }
  );
  assert.equal(calls, 3);
});

/* Constants sanity */

test("success and terminal-failure allowlists are exclusive", () => {
  for (const m of SUCCESS_MESSAGES) {
    assert.ok(!TERMINAL_FAILURE_MESSAGES.includes(m as any));
  }
});
