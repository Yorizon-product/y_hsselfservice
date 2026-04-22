## Why

HubSpot company records are created instantly via the CRM API, but Yorizon's provisioning automation runs asynchronously afterwards and only then makes the company ready to accept users. Creating a contact before that automation finishes silently breaks user provisioning downstream — the contact exists in HubSpot but never gets a working portal login. The current workaround documented to end users is "check the Portal Status field in the HubSpot UI and wait until it says 'Company created successfully' before you add a user", which defeats the purpose of a self-service tool.

The self-service app should absorb that wait itself: after creating each company, poll the company's provisioning status and only create the contact once the company is confirmed ready. If provisioning fails or never completes, surface a clear error to the user and roll back any partial state (the existing rollback mechanism already handles this).

## What Changes

- **Gate contact creation on company readiness.** After `createCompany()` in `app/api/create/route.ts`, poll the created company's `portal_status_update` property and only proceed to `createContact()` when the parsed message equals `Company created successfully`. This applies to both the partner and customer sides of the flow.
- **Bounded retry schedule.** Poll immediately, then retry at +10s and +30s (total budget ~35–40s including network latency). If the status is still missing after the final retry, treat it as a timeout and fail the request.
- **Parse HubSpot's timestamped status format.** `portal_status_update` is a freeform textarea written as `DD/MM/YYYY HH:MM:SS.sss: <message>`. A tiny parser extracts the message portion; the timestamp is checked to ensure we read a status written *after* our company-create call (guards against stale messages if the record already existed — defensive only, since we just created it).
- **Terminal-failure short-circuit.** If `portal_status_update` contains `Company creation failed`, abort immediately without retrying — the 10s/30s retry budget only applies to the "status not yet written" case, not to explicit-failure messages.
- **Progress feedback to the user.** The existing client spinner is replaced with a staged indicator showing the current phase (`Creating partner company → Waiting for provisioning → Creating partner contact → …`). On retry, the indicator reports the attempt (`Waiting for provisioning (retry 1/2)…`).
- **Error messaging.** A new i18n key group (`poll.*`) covers the progress states, the timeout message, the creation-failed message, and the retry hint. All strings flow through the existing `useTranslation()` hook.
- **Rollback unchanged.** Any timeout or terminal failure during the poll falls into the existing `catch` in `app/api/create/route.ts`, which triggers the existing `rollbackEntities()` path — the just-created company is deleted so the user can retry cleanly.

## Capabilities

### New Capabilities
- `company-readiness-gating`: Defines how the create API waits for Yorizon's async provisioning automation to finish before proceeding to contact creation, including the polling contract, retry budget, terminal-failure handling, and progress signalling to the client.

### Modified Capabilities
- None. `openspec/specs/` is empty — the existing creation flow has no canonical spec yet, so the polling behaviour is captured entirely in the new `company-readiness-gating` spec and referenced from tasks targeting `app/api/create/route.ts`.

## Impact

**Code:**
- `app/api/create/route.ts` — insert poll loop between `createCompany()` and `createContact()` for each side; extend the existing try/catch so poll failures funnel into `rollbackEntities()`; log poll attempts under the `[audit]` prefix.
- `app/page.tsx` — replace the single loading state with a staged progress indicator; wire new i18n keys.
- `locales/en.json`, `locales/de.json` — add `poll.*` strings (progress labels, retry hint, timeout error, creation-failed error).
- `lib/` — new tiny helper (likely `lib/portal-status.ts`) for the parser and the poll loop, kept server-only to keep `app/api/create/route.ts` readable.

**API contract:** No breaking change to request/response shape. The POST `/api/create` endpoint still returns `{ created: [...] }` on success and `{ error, rolledBack }` on failure. The new failure mode (`PORTAL_TIMEOUT`, `PORTAL_CREATION_FAILED`) surfaces as a distinct error message but uses the existing 500 response shape.

**HubSpot scopes:** No new scopes required. The app already holds `crm.objects.companies.read`, which covers `GET /crm/v3/objects/companies/{id}?properties=portal_status_update`.

**Latency:** Worst-case request duration grows from ~2s (network × 5 sequential HubSpot calls) to ~40s when both entities are being created and provisioning is slow on both. The client progress indicator makes this visible so users don't think the tool has hung. If Vercel's default 10s function timeout is in play, the route will need `export const maxDuration = 60` (App Router).

**Out of scope:**
- Webhook-driven readiness (HubSpot property-change webhook on `portal_status_update`) — cleaner but requires a public webhook endpoint, signature verification, and state storage; revisit if polling proves too slow or HubSpot rate limits bite.
- Queueing long-running creates to a background job with client long-polling — would solve the Vercel timeout concern more durably, but adds infrastructure (KV or durable storage) for a rare failure path.
- Changing the provisioning automation itself to emit a machine-readable status enum instead of a textarea — owned by a different team; we consume what HubSpot gives us.
