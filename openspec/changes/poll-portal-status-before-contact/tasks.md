## 1. Pre-flight verification

- [x] 1.1 Re-run `GET /crm/v3/properties/companies` against the live Yorizon HubSpot portal using the "Yorizon HubSpot Private App" token to confirm `portal_status_update` is still present, still a textarea, still in group `companyinformation` — re-record the observed success/failure message strings into a code comment in `lib/portal-status.ts`
- [ ] 1.2 Confirm with Arslan Ataev and Marius Lupasco whether the provisioning automation ever emits an intermediate message (e.g., "in progress") before the terminal success/failure, and whether partner- vs customer-type companies get different wording (resolves design Open Question Q1 + Q2)

## 2. Status helper (server-only)

- [x] 2.1 Create `lib/portal-status.ts` with: exported `parseStatus(raw: string | null | undefined): { timestamp: Date; message: string } | null` parsing the `DD/MM/YYYY HH:MM:SS.sss: <message>` format (trim message, return `null` for empty/malformed input)
- [x] 2.2 In the same file, export `classifyStatus(parsed, companyCreatedAt): "pending" | "success" | "failed" | "unexpected"` implementing the allowlist and the 2s clock-skew guard specified in `specs/company-readiness-gating/spec.md`
- [x] 2.3 Export constants `SUCCESS_MESSAGES = ["Company created successfully"]` and `TERMINAL_FAILURE_MESSAGES = ["Company creation failed"]` with a JSDoc comment linking back to task 1.1's verification date
- [x] 2.4 Export `pollCompanyReadiness(token, companyId, companyCreatedAt, logger): Promise<void>` that implements the T=0 / T=10s / T=30s schedule, throws a `PortalStatusError` with a typed `code` of `PORTAL_TIMEOUT | PORTAL_CREATION_FAILED | PORTAL_UNEXPECTED_STATE` on failure, and calls the supplied `logger` for each attempt per the audit-log requirement

## 3. Wire polling into the create flow

- [x] 3.1 Add `export const maxDuration = 60` to the top of `app/api/create/route.ts`
- [x] 3.2 After `createCompany(...)` for the partner side, capture `partnerCompany.createdAt` (or call `GET /crm/v3/objects/companies/{id}` once to read it) and call `pollCompanyReadiness()` before `createContact(...)`, guarded by `if (process.env.PORTAL_STATUS_POLL !== "off")`
- [x] 3.3 Repeat 3.2 for the customer side
- [x] 3.4 Let `PortalStatusError` propagate into the existing `catch (stepError: any)` block so the existing `rollbackEntities()` path fires — extend the catch to map `PortalStatusError.code` into a user-facing message and include the raw `portal_status_update` value in the server log only, not the client response
- [x] 3.5 Add `[audit]` log lines for every poll attempt and the final decision, matching the format in the spec

## 4. Client progress indicator

- [x] 4.1 In `app/page.tsx`, replace the single `loading: boolean` state with a `progress: { stage: string; retry?: { current: number; total: number } } | null` state
- [x] 4.2 Drive the `progress` state off `performance.now()` elapsed time using the stage boundaries defined in `design.md` decision 5 (create ~500ms/entity, poll windows at 0–10s, 10s–30s, 30s+)
- [x] 4.3 Render the progress label via `t("poll.stage." + progress.stage)` and, when `progress.retry` is set, append `t("poll.retry", {current, total})`
- [x] 4.4 On error response, if `error.code === "PORTAL_TIMEOUT"` or `"PORTAL_CREATION_FAILED"` or `"PORTAL_UNEXPECTED_STATE"`, render the corresponding `t("poll.error.*")` string instead of the raw server message; still show the existing `rolledBack` summary

## 5. i18n strings

- [x] 5.1 Add to `locales/en.json` under a `poll.*` key group: `poll.stage.creatingPartnerCompany`, `poll.stage.waitingPartnerProvisioning`, `poll.stage.creatingPartnerContact`, `poll.stage.creatingCustomerCompany`, `poll.stage.waitingCustomerProvisioning`, `poll.stage.creatingCustomerContact`, `poll.retry` (with `{current}` and `{total}` vars), `poll.error.timeout`, `poll.error.creationFailed`, `poll.error.unexpectedState`
- [x] 5.2 Add matching German translations to `locales/de.json` using du-form and gender-inclusive language, consistent with the existing translation style

## 6. Env & deploy

- [x] 6.1 Add `PORTAL_STATUS_POLL` to `.env.example` with a comment explaining `on` (default) vs `off` (disable polling)
- [ ] 6.2 Set `PORTAL_STATUS_POLL=on` in Vercel production and preview environments before merging
- [x] 6.3 Update `CLAUDE.md` with a one-line note under "Required env" describing the kill switch

## 7. Verification

- [x] 7.1 Unit test `parseStatus()` against: empty string, null, missing colon, malformed date, valid `Company created successfully`, valid `Company creation failed`, values with leading/trailing whitespace
- [x] 7.2 Unit test `classifyStatus()` against all four return values including the clock-skew edge case
- [ ] 7.3 End-to-end smoke test against the live Yorizon portal via a Vercel preview deployment: create a partner+customer pair, confirm the progress indicator advances through waiting-provisioning, confirm the request completes with contacts created
- [ ] 7.4 Kill-switch test: deploy a preview with `PORTAL_STATUS_POLL=off`, create an entity, confirm no GET to `/crm/v3/objects/companies/{id}` appears in the audit log
- [ ] 7.5 Timeout test: temporarily stub `pollCompanyReadiness()` to always time out (locally only), confirm rollback deletes the created company in HubSpot and the client renders the timeout error

## 8. Release

- [ ] 8.1 Merge the feature branch to `master`; patch version auto-bumps via the pre-commit hook
- [x] 8.2 Add a CHANGELOG entry (EN + DE) describing the readiness gating and the `PORTAL_STATUS_POLL` flag
- [ ] 8.3 Notify Arslan Ataev, Marius Lupasco, and end users that the manual "Portal Status" wait workaround is no longer required, and share the kill-switch env var in case of regressions
- [ ] 8.4 Archive the change with `/opsx:archive poll-portal-status-before-contact` once in production for a week with no regressions
