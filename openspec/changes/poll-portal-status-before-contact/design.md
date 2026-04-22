## Context

`app/api/create/route.ts` today creates a HubSpot company, immediately creates the associated contact, and optionally attaches them via the v4 associations API. All steps are sequential and wrapped in a single try/catch that drives `rollbackEntities()` on any failure. This works when the operations are idempotent/synchronous in HubSpot — but the Yorizon portal has an **asynchronous provisioning automation** that runs after a company is created and writes its result into a custom textarea field, `portal_status_update`. Until that automation finishes, adding a contact that expects a working portal login silently breaks downstream. The end-user workaround (check `portal_status_update` in the HubSpot UI) isn't acceptable in a self-service tool.

Constraints shaping the design:

- **Deployed on Vercel serverless.** Default function timeout is 10s on the App Router; `export const maxDuration` can raise it but there's a hard cap depending on plan (60s Hobby, 300s Pro). The user-facing request is synchronous — there's no background worker available without adding infra.
- **HubSpot rate limits.** Private Apps: 100 req/10s burst, 250k/day. Polling at 30s/60s/120s adds at most 3 extra GETs per company — negligible.
- **Field is a textarea, not an enum.** Values are freeform strings written by the automation. The allowlist was verified empirically against the live portal (see proposal) but could drift if the automation changes. Any match needs to be forgiving (trim, normalize whitespace) but specific enough not to false-positive on ambiguous messages.
- **Field is overwritten on every status event.** On a brand-new company it starts empty, transitions to a creation-result message, and later gets overwritten by update events. Since we're polling a company we just created milliseconds ago, the first non-empty value we see IS the creation result.
- **Rollback already works.** The existing `rollbackEntities()` loops through `createdIds` in reverse and deletes each via the v3 CRM API. A poll failure needs to throw into the existing catch so the company gets cleaned up.
- **Advanced mode exists.** A user can ask to create just the partner, just the customer, or both independently. Each side is a self-contained company+contact pair and must gate independently.

Stakeholders: end users (creating test tenants), Arslan Ataev + Marius Lupasco (raised the ticket, owners of the provisioning automation), Casey (tool owner).

## Goals / Non-Goals

**Goals:**

- Contact creation never fires before its paired company is confirmed ready in the Yorizon portal.
- When provisioning fails or times out, the user gets a clear, actionable error and zero HubSpot-side residue (no orphan company, no orphan contact).
- Total added latency stays under ~250s worst case (2 sides × 120s budget + overhead) so we stay inside Vercel Pro's 300s `maxDuration` cap.
- Polling is cheap: no queues, no storage, no webhook infra. The whole thing fits inside the existing synchronous POST request.
- The change is fully reversible: a feature flag / env var can disable polling and fall back to current behaviour without a code deploy.

**Non-Goals:**

- Webhook-driven readiness signalling. Would be cleaner but adds a public endpoint, signature validation, and some place to park in-flight state until the webhook arrives. Revisit if polling hits timeouts frequently.
- Background-job architecture with client long-polling. Correct long-term answer if provisioning routinely takes >60s, but over-engineered for the current evidence (all 100 sampled companies reached a terminal status within minutes — most inside tens of seconds).
- Fixing the upstream provisioning automation. Out of this team's scope.
- Gating the company↔company association step on status. The association is a HubSpot-only operation that doesn't care about portal provisioning.

## Decisions

### 1. Polling schedule: T=30s / T=60s / T=120s (3 attempts, 120s budget per side)

**Decision:** Poll `portal_status_update` at T=30s, T=60s, T=120s from the moment the company is created. Three attempts total, 120-second budget per side. If the third attempt returns empty or unknown, treat as `PORTAL_TIMEOUT` / `PORTAL_UNEXPECTED_STATE` and fail.

**Why:** The original T=0/+10s/+30s schedule was too optimistic — in practice the Yorizon provisioning automation frequently takes longer than 30 seconds to write the success status, and the tighter schedule produced false timeouts for otherwise-successful creates. The T=30/60/120s schedule accepts a longer wall-clock worst case in exchange for far fewer false failures. Three attempts still bound the total budget predictably.

**Alternatives considered:**
- *Linear polling (every 5s up to 45s):* More requests for the same outcome; retry-count-based messaging is harder to render meaningfully in the UI.
- *Exponential backoff (1s, 2s, 4s, 8s, 16s, 32s):* Lower median latency (hits faster when the automation is fast), but 6 sequential requests feel chatty and give the UI nothing coherent to display.
- *Webhook + state store:* Covered under Non-Goals.

### 2. Success condition: exact-match message against a known allowlist

**Decision:** Parse `portal_status_update` as `<DD/MM/YYYY HH:MM:SS.sss>: <message>`, trim the message, and compare against two sets:

- **Success:** `{"Company created successfully"}` → proceed to contact creation
- **Terminal failure:** `{"Company creation failed"}` → abort immediately, no more retries, rollback

Any other non-empty value (including `Company updated successfully`, `Company update failed`, `Company update completed with errors`) → treat as "unexpected, keep polling" for the remaining retries, and fail as `PORTAL_UNEXPECTED_STATE` if the budget exhausts with that value still present.

**Why:** The creation automation emits exactly one of the two success/fail messages on a new company. `Company updated successfully` on a just-created company would be anomalous — it would mean the company was edited between our create and our first poll, which we didn't do. Treating it as "unexpected" instead of "success" is defensive without being brittle.

**Alternatives considered:**
- *Substring match on "successfully":* False-positives on `Company update completed with errors` (contains "completed", and future messages could easily say "Already successfully synced"). Too loose.
- *Regex match on `/^Company created successfully$/`:* Functionally identical to exact match after trim. Extra syntax for no gain.
- *Treat any non-"failed" message as success:* Too permissive. If the automation adds a new "Company created with warnings" state we want to surface it, not silently swallow it.

### 3. Timestamp-parsing: optional guard, not primary signal

**Decision:** Parse the `DD/MM/YYYY HH:MM:SS.sss: ` prefix into a `Date`. Record the company's own `createdAt` as baseline just before we start polling. Only accept a status message if its parsed timestamp is `>= createdAt - 2 seconds` (2s slack for clock skew between our server, HubSpot, and the automation host).

**Why:** Brand-new companies should have empty `portal_status_update`, so this guard is mostly theoretical. But if the field is ever non-empty on create (HubSpot clone, race with another tool, whatever), we don't want to read a stale success message as ours. Cheap insurance.

**Alternatives considered:**
- *Ignore the timestamp entirely:* Works 99% of the time but opens a silent-failure mode we don't need to accept.
- *Use HubSpot's `hs_lastmodifieddate` instead:* That changes on any property write, including the initial create. Noisier than parsing the status string itself.

### 4. Per-side polling, per-side rollback

**Decision:** In Advanced mode with both partner and customer enabled, poll partner-company → create partner-contact → poll customer-company → create customer-contact sequentially, matching the current creation order. If the partner-side poll times out, roll back ONLY the partner company (customer hasn't been created yet). If the customer-side poll times out, roll back customer company + contact + partner contact + partner company — same behaviour as today's catch block.

**Why:** Matches the existing sequential rollback semantics. Parallelising partner/customer creation would halve the latency but doubles implementation complexity in rollback and in the progress UI; the two sides are almost always both slow or both fast (same automation host), so parallelism doesn't help the worst case.

**Alternatives considered:**
- *Parallel partner + customer:* Nice in theory, but complicates error messaging ("customer timed out but partner succeeded — do you want to keep the partner?") and the rollback state machine. Defer.

### 5. Progress feedback via response streaming vs. fixed-stage guesses

**Decision:** Do **not** stream. Keep the POST as a single synchronous request that returns when the whole flow is done. On the client, the progress indicator is driven off a simple `performance.now()`-based state machine with known stage durations (create ~500ms per entity, poll up to ~35s). The indicator shows the current stage label based on elapsed time, not on real server progress.

**Why:** Streaming from Next.js route handlers works but adds protocol complexity (Server-Sent Events, chunked JSON) and failure-mode ambiguity (what does a mid-stream abort mean?). The stages are so predictable that a time-based estimate on the client is indistinguishable from real progress to the user. If streaming becomes necessary (e.g., we add more steps and the estimate goes stale), it's a future refactor.

**Alternatives considered:**
- *SSE with per-stage events:* Accurate but invasive. Probably overkill.
- *Two-phase client flow (POST /start returns job ID, client polls GET /jobs/:id):* Requires persistent state between invocations (KV), violates "no new infra" constraint.

### 6. Feature flag / kill switch

**Decision:** New env var `PORTAL_STATUS_POLL=on|off` (default `on`). When `off`, the route behaves exactly as today — no poll, no delay. Read once at module load.

**Why:** Lets us ship this change and flip it off without a redeploy if it breaks something in production we didn't predict (e.g., rate limits, timeout behaviour on a different HubSpot portal). Cheap.

**Alternatives considered:**
- *No flag:* Riskier given the field format is effectively undocumented and could change.
- *Per-request flag from the client:* Enables A/B but muddies the contract; not worth the surface.

### 7. Vercel function duration

**Decision:** Add `export const maxDuration = 300` at the top of `app/api/create/route.ts`. Sufficient for worst case (two entities × 120s poll + HubSpot calls ≈ 245s) with cushion. Requires Vercel Pro or higher (Hobby caps at 60s).

**Why:** Minimum plan change needed. Well below the Pro-tier 300s cap.

## Risks / Trade-offs

- **Risk:** The automation changes its message strings without notice → all our creations start failing with `PORTAL_UNEXPECTED_STATE`. **Mitigation:** Log the raw `portal_status_update` value on every unexpected-state failure so we can update the allowlist quickly; add an integration test against a sandbox portal during CI if Arslan/Marius can set one up.
- **Risk:** Polling-based latency frustrates users who are used to "instant" creation today. **Mitigation:** Progress indicator with explicit "Waiting for Yorizon provisioning…" label so the delay is attributed correctly; kill switch available if complaints spike.
- **Risk:** Vercel function hits `maxDuration = 300` and returns a 504 gateway error mid-flow, leaving the user without a clear error and possibly with orphan companies in HubSpot. **Mitigation:** Set the per-side poll budget (120s) so both sides plus overhead stay under 250s, leaving 50s of cushion under the 300s cap. The existing try/catch + rollback handles partial state even on abrupt termination — the catch runs, rollback runs, response is just lost. Future-proof: add a "cleanup" cron or a manual cleanup endpoint that scans for companies with empty `portal_status_update` older than N hours and deletes them.
- **Risk:** Terminal-failure short-circuit misses a case the automation fails silently (no message ever written, or written as "…failed" with a typo). **Mitigation:** The timeout path covers silent failures. Typo'd failure messages fall into `PORTAL_UNEXPECTED_STATE` which is still a failure — just with a slightly less informative user message. Acceptable.
- **Trade-off:** We're coupling the tool to a specific, undocumented convention of a textarea field. The spec explicitly names `Company created successfully` and `Company creation failed`. If these ever change, the tool breaks. **Accepted** because the alternative (wait for a proper enum or a webhook contract from the automation team) blocks solving the user's pain indefinitely.

## Migration Plan

**Deploy:**

1. Merge the change. No schema migrations, no data backfill.
2. Set `PORTAL_STATUS_POLL=on` in Vercel project env (production + preview).
3. Smoke-test by creating one partner + customer pair in production; confirm the progress indicator advances through "Waiting for provisioning…" and that the request completes successfully.

**Rollback:**

1. Flip `PORTAL_STATUS_POLL=off` in Vercel env → behaviour reverts to pre-change immediately on next cold start (or after a redeploy for instant effect).
2. If the flag isn't sufficient (e.g., the new code path has a bug on a code path the flag doesn't gate), revert the merge and redeploy `master`.

## Open Questions

- **Q1:** Is `Company created successfully` the *only* success string, or are there portal-type-specific variants (e.g., a partner vs. customer flavour)? → Verified only via 100-company sample; would be more confident with a direct word from Arslan/Marius.
- **Q2:** Does the automation ever emit multiple status updates per create (e.g., `Company creation in progress` → `Company created successfully`)? → Not observed in sampling, but if it does, our "first non-empty value wins" approach is still correct — we'd just need to keep polling past an "in progress" message. **Proposed resolution:** treat any message containing "in progress" as "keep polling" (same bucket as empty).
- **Q3:** Should we log the poll attempts to the `[audit]` trail for debugging? → Probably yes. Low log volume (≤3 lines per create), high debuggability value.
- **Q4:** Partner-side failure in Advanced mode — do we proceed with the customer side or abort both? → Proposed: abort both, since the user asked for "create both as a unit". But if we want more granular behaviour, we can add a `continueOnPartialFailure` flag later.
