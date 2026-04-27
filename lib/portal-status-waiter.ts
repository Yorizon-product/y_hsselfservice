import {
  classifyStatus,
  parseStatus,
  PortalStatusError,
  type StatusClass,
} from "./portal-status.ts";
import { recentEventsForObject } from "./db.ts";
import { onPortalStatusEvent } from "./portal-status-events.ts";

// Webhook-driven equivalent of pollCompanyReadiness. Returns once the
// classifier decides the status is `success`, throws PortalStatusError
// on classified failure, throws PORTAL_TIMEOUT on the safety-net
// timeout. Designed to be a drop-in for the polling implementation in
// the worker.
//
// Three signals feed the classification:
//
//   1. **Initial DB sweep.** A webhook may have arrived BEFORE the
//      worker started waiting (it was already in flight when we
//      created the company). Check webhook_events first.
//   2. **Live event bus.** When the webhook handler persists a new
//      event, it emits on the in-process bus. We listen and wake up.
//   3. **Slow-poll fallback.** Every WAITER_DB_TICK_MS we re-query the
//      DB. Catches the case where the bus emit was missed (different
//      Node process, race during deploy, etc.). Cheap enough to leave
//      on by default.

type Logger = (line: string) => void;

export type WaiterOptions = {
  totalTimeoutMs?: number;        // default 240_000 (matches old poll budget)
  fallbackTickMs?: number;        // default 30_000
  log?: Logger;
};

const DEFAULT_TOTAL_TIMEOUT_MS = 240_000;
const DEFAULT_FALLBACK_TICK_MS = 30_000;

export async function waitForPortalStatusViaWebhook(
  companyId: string,
  companyCreatedAt: Date,
  opts: WaiterOptions = {}
): Promise<void> {
  const totalTimeoutMs = opts.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const fallbackTickMs = opts.fallbackTickMs ?? DEFAULT_FALLBACK_TICK_MS;
  const log = opts.log ?? (() => {});
  const startedAt = Date.now();

  // Helper: try to classify whatever status we currently know about.
  // Returns `null` if there's nothing to classify (still pending) or a
  // resolved/rejected indicator if a classification fired.
  const classifyCurrent = (rawStatus: string | null): StatusClass => {
    return classifyStatus(parseStatus(rawStatus), companyCreatedAt);
  };

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    let fallbackTimer: ReturnType<typeof setInterval> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const settle = (action: "resolve" | "reject", err?: Error) => {
      if (settled) return;
      settled = true;
      if (unsubscribe) unsubscribe();
      if (fallbackTimer) clearInterval(fallbackTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (action === "resolve") resolve();
      else reject(err);
    };

    const handleStatus = (rawStatus: string | null, source: string): boolean => {
      const cls = classifyCurrent(rawStatus);
      if (cls === "success") {
        log(`[waiter] company=${companyId} success via=${source} elapsed=${Date.now() - startedAt}ms`);
        settle("resolve");
        return true;
      }
      if (cls === "failed") {
        log(`[waiter] company=${companyId} failed via=${source} elapsed=${Date.now() - startedAt}ms raw="${rawStatus}"`);
        settle("reject", new PortalStatusError(
          "PORTAL_CREATION_FAILED",
          "Yorizon reported company creation failure",
          rawStatus
        ));
        return true;
      }
      // 'pending' or 'unexpected' — keep waiting. Unexpected stays
      // tentative because the value might be overwritten by a real
      // success/failure later within the timeout window.
      return false;
    };

    // 1. Initial DB sweep — did the webhook beat us?
    const sweepDb = (source: string) => {
      // Look only at events at or after the company's createdAt minus
      // the standard skew, so a stale status from before creation
      // doesn't accidentally match.
      const sinceIso = new Date(companyCreatedAt.getTime() - 2_000).toISOString();
      const rows = recentEventsForObject(companyId, "portal_status_update", sinceIso);
      if (rows.length === 0) return;
      // Most recent first; iterate to find the first classifiable one.
      for (const r of rows) {
        if (handleStatus(r.property_value, source)) return;
      }
    };

    // 2. Subscribe to live events from the webhook handler.
    unsubscribe = onPortalStatusEvent((evCompanyId, propertyValue) => {
      if (evCompanyId !== companyId) return;
      handleStatus(propertyValue, "event");
    });

    // 3. Slow-poll fallback against the DB.
    fallbackTimer = setInterval(() => {
      if (settled) return;
      sweepDb("fallback");
    }, fallbackTickMs);

    // 4. Hard timeout.
    timeoutTimer = setTimeout(() => {
      log(`[waiter] company=${companyId} timeout after ${totalTimeoutMs}ms`);
      settle("reject", new PortalStatusError(
        "PORTAL_TIMEOUT",
        `Yorizon did not report on company within ${Math.round(totalTimeoutMs / 1000)}s`,
        null
      ));
    }, totalTimeoutMs);

    // 5. Run the initial sweep AFTER subscribing so we don't miss an
    // event that lands during the gap between "register listener" and
    // "first DB read". Order is: subscribe → sweep → wait.
    sweepDb("initial");
  });
}
