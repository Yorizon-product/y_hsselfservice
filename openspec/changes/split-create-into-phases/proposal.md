## Why

The partner+customer create flow runs as a single Vercel function with `maxDuration = 300s` and ~244s of worst-case work (2 × 120s polling budgets + company/contact creation). That leaves only ~56s of headroom — any Yorizon slowness on either side can push us past the function cap, killing the request mid-flow and leaving orphan HubSpot records.

We want more room per phase (longer poll windows so Yorizon has more time to provision) without moving off Vercel Pro's 300s cap. Splitting the single invocation into three sequential calls — one per side, one for the association — gives each call its own 300s budget, which is headroom we can spend on longer polls.

## What Changes

- **BREAKING** Delete the single `/api/create` POST route; replace with three smaller routes:
  - `POST /api/create/side` — creates one side (company → note → poll → contact → note) for `{ side: "partner" | "customer" }`. Rolls back its own partial failures.
  - `POST /api/create/associate` — creates the parent-company association between two already-existing companies.
  - `POST /api/create/rollback` — deletes a list of previously-created HubSpot entity IDs. Used by the client to clean up when a *later* phase fails and prior phases already succeeded.
- Extend `DEFAULT_POLL_DELAYS_MS` from `[30_000, 30_000, 60_000]` (120s) to `[60_000, 60_000, 120_000]` (240s). Each side call still fits under the 300s function cap with ~58s of headroom.
- Extract the shared HubSpot primitives (`createCompany`, `createNote`, `createContact`, `associateCompanies`, `rollbackEntities`) out of `app/api/create/route.ts` into a new `lib/hubspot-entities.ts` so all three routes share one implementation.
- Rewrite `handleSubmit` in `app/page.tsx` as a phase-aware orchestrator: partner → customer → associate. Accumulates created IDs across calls; on any failure, calls `/api/create/rollback` with the accumulated IDs before surfacing the friendly error to the user.
- Keep the inline progress indicator and the (recently added) browser notifications behaving exactly as today — the *user-visible* stage sequence and step count is unchanged; only the wire-level boundary moves.
- Update the client-side timing constants (`POLL_WINDOW_1_MS`/`2`/`3`) to match the new server delays.

Non-goals:
- No background-job / queue architecture. This is strictly "split one function into three; keep everything synchronous from the client's POV."
- No changes to OAuth, session, or basic-auth surfaces.
- No new env vars.

## Capabilities

### New Capabilities
_(none — this reshapes an existing behavior rather than introducing a new user-facing capability.)_

### Modified Capabilities
_(none — no canonical specs exist yet under `openspec/specs/`.)_

This change introduces its own spec under `specs/create-flow-phases/` documenting the new phased contract.

## Impact

- **Code**
  - `app/api/create/route.ts` — deleted.
  - `app/api/create/side/route.ts` — new.
  - `app/api/create/associate/route.ts` — new.
  - `app/api/create/rollback/route.ts` — new.
  - `lib/hubspot-entities.ts` — new; shared primitives.
  - `lib/portal-status.ts` — `DEFAULT_POLL_DELAYS_MS` bumped.
  - `app/page.tsx` — `handleSubmit` rewritten to orchestrate three calls; progress-timing constants updated.
  - `CLAUDE.md` — architecture section updated to describe the three-route flow.
- **APIs / deps** — zero new dependencies.
- **Env vars** — unchanged. The existing `PORTAL_STATUS_POLL` and `PORTAL_STATUS_POLL_KEEP_ON_FAIL` flags keep their semantics (per side call).
- **Backwards compat** — none. The tool is the only caller of `/api/create`; no external clients to break.
- **Security** — the new `/api/create/rollback` endpoint MUST restrict deletions to the object types this tool creates (company, contact, note). It relies on the same session + OAuth as today, but the input list must be validated so a caller can't delete arbitrary CRM objects via type-forgery.
- **Tests** — new unit tests for `lib/hubspot-entities.ts` (mirroring the existing `portal-status` test pattern); updated timing constants in any existing tests that reference the old 120s-per-side budget.
