/**
 * Helpers for gating HubSpot contact creation on Yorizon's async portal
 * provisioning. Reads the `portal_status_update` custom company property,
 * parses its freeform `DD/MM/YYYY HH:MM:SS.sss: <message>` format, and
 * polls until the company is confirmed ready (or fails).
 *
 * Allowlist verified against the live Yorizon HubSpot portal on 2026-04-22
 * (n=100 most-recently-modified companies). Update the date + sample when
 * re-running GET /crm/v3/properties/companies and sampling messages.
 */

export const SUCCESS_MESSAGES = ["Company created successfully"] as const;
export const TERMINAL_FAILURE_MESSAGES = ["Company creation failed"] as const;

const CLOCK_SKEW_MS = 2_000;
const HUBSPOT_API = "https://api.hubapi.com";

export type StatusClass = "pending" | "success" | "failed" | "unexpected";

export type ParsedStatus = {
  timestamp: Date;
  message: string;
};

export class PortalStatusError extends Error {
  code: "PORTAL_TIMEOUT" | "PORTAL_CREATION_FAILED" | "PORTAL_UNEXPECTED_STATE";
  rawStatus: string | null;

  constructor(
    code: PortalStatusError["code"],
    message: string,
    rawStatus: string | null = null
  ) {
    super(message);
    this.name = "PortalStatusError";
    this.code = code;
    this.rawStatus = rawStatus;
  }
}

/**
 * Parse `DD/MM/YYYY HH:MM:SS.sss: <message>` into a Date + trimmed message.
 * Returns null for empty, null, or structurally invalid input.
 */
export function parseStatus(raw: string | null | undefined): ParsedStatus | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const match = trimmed.match(
    /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})\.(\d{3}): ([\s\S]+)$/
  );
  if (!match) return null;

  const [, dd, mm, yyyy, h, min, s, ms, message] = match;
  const iso = `${yyyy}-${mm}-${dd}T${h}:${min}:${s}.${ms}Z`;
  const timestamp = new Date(iso);
  if (Number.isNaN(timestamp.getTime())) return null;

  return { timestamp, message: message.trim() };
}

/**
 * Classify a parsed status against the allowlist, applying the clock-skew
 * guard. `companyCreatedAt` is the HubSpot-reported create time of the
 * company we're polling; any status timestamped more than 2s before that
 * is considered stale and treated as still-pending.
 */
export function classifyStatus(
  parsed: ParsedStatus | null,
  companyCreatedAt: Date
): StatusClass {
  if (!parsed) return "pending";

  if (parsed.timestamp.getTime() < companyCreatedAt.getTime() - CLOCK_SKEW_MS) {
    return "pending";
  }

  if (SUCCESS_MESSAGES.includes(parsed.message as typeof SUCCESS_MESSAGES[number])) {
    return "success";
  }
  if (TERMINAL_FAILURE_MESSAGES.includes(parsed.message as typeof TERMINAL_FAILURE_MESSAGES[number])) {
    return "failed";
  }
  return "unexpected";
}

type Logger = (line: string) => void;

type PollOptions = {
  // Incremental sleep before each attempt, in milliseconds. Defaults to
  // [30_000, 30_000, 60_000] → cumulative T=30s, T=60s, T=120s from the
  // moment the company was created. Overridable for tests.
  delaysMs?: number[];
  // Injectable fetch for testing.
  fetchImpl?: typeof fetch;
  // Injectable sleep for testing.
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll a just-created company's portal_status_update until it reports
 * success, failure, or the retry budget is exhausted.
 *
 * Throws PortalStatusError on any non-success outcome. On success, returns
 * void and the caller may proceed with contact creation.
 */
export async function pollCompanyReadiness(
  token: string,
  companyId: string,
  companyCreatedAt: Date,
  log: Logger,
  opts: PollOptions = {}
): Promise<void> {
  const delays = opts.delaysMs ?? [30_000, 30_000, 60_000];
  const fetchFn = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;

  let lastRaw: string | null = null;

  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) await sleep(delays[i]);

    const res = await fetchFn(
      `${HUBSPOT_API}/crm/v3/objects/companies/${companyId}?properties=portal_status_update`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) {
      throw new Error(`HubSpot status read failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { properties?: { portal_status_update?: string | null } };
    const raw = body.properties?.portal_status_update ?? null;
    lastRaw = raw;

    const parsed = parseStatus(raw);
    const cls = classifyStatus(parsed, companyCreatedAt);
    const displayStatus = raw ? `"${raw}"` : "<empty>";
    log(`[audit] poll ${i + 1}/${delays.length} company=${companyId} status=${displayStatus} class=${cls}`);

    if (cls === "success") return;
    if (cls === "failed") {
      throw new PortalStatusError(
        "PORTAL_CREATION_FAILED",
        "Yorizon reported that company provisioning failed.",
        raw
      );
    }
    // pending or unexpected: keep polling if we have attempts left
  }

  // Budget exhausted. Decide between timeout (never saw a message) and
  // unexpected-state (saw a message but it wasn't in the allowlist).
  const parsed = parseStatus(lastRaw);
  if (parsed && classifyStatus(parsed, companyCreatedAt) === "unexpected") {
    throw new PortalStatusError(
      "PORTAL_UNEXPECTED_STATE",
      `Unexpected portal status after ${delays.length} attempts: ${parsed.message}`,
      lastRaw
    );
  }
  throw new PortalStatusError(
    "PORTAL_TIMEOUT",
    `Portal provisioning did not complete after ${delays.length} attempts.`,
    lastRaw
  );
}
