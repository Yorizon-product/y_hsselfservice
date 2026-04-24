## Context

`app/api/create/route.ts` is a single POST that orchestrates partner-side → customer-side → association in one Vercel serverless invocation. It has `export const maxDuration = 300` (Vercel Pro cap). Worst-case elapsed time today is roughly:

- Partner: create company (~1s) + poll up to 120s (`[30, 30, 60]`) + create contact (~1s) ≈ 122s
- Customer: same ≈ 122s
- Associate: ~1s

Total worst case ≈ 245s → ~55s of headroom under 300s. Any Yorizon slowness and we blow past the cap mid-request — the function is killed, and the client sees a gateway timeout while orphan HubSpot records pile up (the server-side rollback never runs because the server process was terminated).

We want to extend the poll budget so Yorizon has breathing room, without jumping Vercel plans. The headroom inside one 300s function isn't enough; each side needs its own 300s.

## Goals / Non-Goals

**Goals:**
- Double the per-side poll budget from 120s to 240s, fitting comfortably inside one 300s function per side.
- Preserve atomic semantics from the user's POV: if any phase fails after earlier phases succeeded, orphan records get deleted before the user sees the error.
- Keep the inline progress indicator and browser-notification behavior functionally identical to today.
- Keep the in-memory idempotency guard so accidental double-clicks don't create duplicates.

**Non-Goals:**
- No async / background-job / queue-based pattern. The client still blocks on each call.
- No new infrastructure (KV, Upstash, DB). Everything remains stateless serverless + client state.
- No new env vars. Existing `PORTAL_STATUS_POLL*` flags keep their meaning per-side.
- No monitoring of partial state beyond the current session. If the user closes the tab mid-flow, whatever is already in HubSpot stays there (same as today when the single-route flow dies mid-request).

## Decisions

### 1. Three routes, not one route with a `phase` parameter
**Decision:** `POST /api/create/side`, `POST /api/create/associate`, `POST /api/create/rollback`. **Alternatives considered:** Single `/api/create` with a `phase` field (rejected — 3 distinct input/output shapes packed into one route encourages drift and makes payload typing awkward).
**Why:** Each route has a single concern, a clear input shape, and independent idempotency. Easier to reason about, easier to test, and cleaner in the Next.js App Router file tree.

### 2. Atomic-from-user-POV, but client-orchestrated rollback
**Decision:** Each side route continues to roll back its *own* partial failures (create company → poll fails → delete company internally). But when a later phase fails and earlier phases *did* succeed, the client calls `POST /api/create/rollback` with the accumulated IDs. **Alternatives considered:** Full server-driven cross-phase rollback via shared state (rejected — would require KV/DB, violating the "no new infra" goal).
**Why:** We preserve the current guarantee ("user never sees orphans") without persisting state on the server between calls. The client already tracks what was created for UI purposes; reusing that state for rollback is cheap.

### 3. Poll budget: `[60_000, 60_000, 120_000]`
**Decision:** Bump `DEFAULT_POLL_DELAYS_MS`. Each side call now has a 240s poll budget + ~2s of create/contact = ~242s under the 300s cap. **Alternatives considered:** `[45, 75, 120]` (rejected — no reason to spread unevenly), `[90, 90, 120]` (rejected — 300s with zero headroom, too tight).
**Why:** Doubles Yorizon's provisioning window uniformly. Leaves ~58s of headroom for HubSpot call overhead and cold-start variance. Matches the existing 3-attempt pattern, so client-side progress rendering barely changes.

### 4. `lib/hubspot-entities.ts` as the shared primitive layer
**Decision:** Move `createCompany`, `createNote`, `createContact`, `associateCompanies`, `rollbackEntities` out of `app/api/create/route.ts` into a new lib module. The three routes (and any future ones) import from there. **Alternatives considered:** Copy-paste into each route (rejected — immediate 3× drift risk).
**Why:** Routes become thin orchestration layers; the CRM logic is in one testable place. Tests follow the existing `lib/__tests__/portal-status.test.ts` pattern (node:test, native TS, `.ts` imports).

### 5. Rollback endpoint validates allowed types
**Decision:** `/api/create/rollback` accepts `{ ids: [{ type: "company" | "contact" | "note"; id: string }] }` and rejects any other type. IDs are opaque strings but must be non-empty. Max 8 IDs per call (enough for both sides + notes).
**Why:** The endpoint has OAuth-scoped access to the user's portal, so without validation a malicious or buggy caller could delete arbitrary deals, tickets, products, etc. Whitelisting types keeps the blast radius to what this tool creates.

### 6. Delete the old `/api/create` route rather than leave it for compat
**Decision:** Remove the legacy single-route flow. **Alternatives considered:** Keep it, delegate internally (rejected — dead code path that must be maintained and can drift from the new routes).
**Why:** The tool's UI is the only caller. No external integrations exist. Carrying two paths would double the surface area with zero benefit.

### 7. Client orchestration stays in `app/page.tsx` `handleSubmit`
**Decision:** Extend the current submit handler into a small state machine that fires the three calls sequentially, tracking created IDs in a ref. On any error, call `/api/create/rollback` (if there's anything to clean up) before surfacing the friendly message. **Alternatives considered:** New custom hook `useCreateFlow` (rejected — premature abstraction; one caller).
**Why:** Keeps the change localized. The existing `setProgress` tick and notification dispatch work unchanged — only the source of phase transitions changes (instead of a single `/api/create` resolving at the end, three resolutions map to partner-done / customer-done / associate-done).

### 8. Idempotency per call, not per flow
**Decision:** Each of the three calls takes its own `x-idempotency-key` header and de-dupes independently (30s in-memory `Set`, same as today per route).
**Why:** Each route is a separate request — a per-flow key would require shared state. Per-call is sufficient to stop double-clicks within a single submit.

## Risks / Trade-offs

- **[Client closes tab mid-flow]** → Whatever was already created in HubSpot stays. Same failure mode as today (only user-visible difference: the tab could close between calls instead of during a single call). Mitigation: nothing new required; this is an accepted limitation.
- **[Client-driven rollback fails]** → Orphans accumulate. Mitigation: the rollback endpoint is the same simple DELETE-in-reverse-order logic as today; as long as HubSpot is reachable, it succeeds. We log rollback failures and surface them in the friendly error.
- **[Latency between calls]** → Three serial HTTP round-trips to Vercel add ~100–300ms total vs. one call today. Negligible compared to the 240s poll window.
- **[Type-forgery on `/rollback`]** → Attacker passes an arbitrary CRM ID hoping we'll DELETE it. Mitigation: type whitelist (company/contact/note only) + OAuth-scoped token means worst case they can only delete their own objects of those types. No escalation.
- **[Test drift from new timing constants]** → Existing tests reference `[30_000, 30_000, 60_000]`. Mitigation: update test expectations where the constants are referenced directly; most tests inject custom `delaysMs` and are unaffected.

## Migration Plan

- Purely internal — the UI is the only caller, so zero external migration.
- No data migration; nothing persisted.
- Rollback strategy: revert the commit. The old single-route flow is preserved in git; reverting restores it. No DB or infra state to unwind.

## Open Questions

- Should `/api/create/rollback` itself retry on transient 5xx from HubSpot before giving up? For now: no retry; surfaces the failure and lets the user retry. A follow-up could add a short bounded retry if we see the pattern in logs.
