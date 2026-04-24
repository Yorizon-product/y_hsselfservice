## 1. Shared primitives

- [ ] 1.1 Create `lib/hubspot-entities.ts` with exports: `createCompany`, `createNote`, `createContact`, `associateCompanies`, `rollbackEntities`, plus shared `HUBSPOT_API`, `CreatedEntity` type, `hubspotUrl()` helper
- [ ] 1.2 Each primitive takes an injected `token` + optional `fetchImpl` for tests; throws on HTTP failure
- [ ] 1.3 `rollbackEntities(token, ids, fetchImpl?)` deletes in reverse order; treats 404 as success; returns `{ deleted, failed }`

## 2. Poll delays

- [ ] 2.1 Change `DEFAULT_POLL_DELAYS_MS` in `lib/portal-status.ts` from `[30_000, 30_000, 60_000]` to `[60_000, 60_000, 120_000]`
- [ ] 2.2 Verify existing `portal-status.test.ts` still passes (it injects custom delays and shouldn't care about defaults)

## 3. Per-side endpoint

- [ ] 3.1 Create `app/api/create/side/route.ts` with `maxDuration = 300`
- [ ] 3.2 Validate `{ side, payload, portalRole }`; reject unknown `side` with 400
- [ ] 3.3 Re-use existing idempotency Set (module-local, 30s window)
- [ ] 3.4 Call `createCompany → createNote → pollCompanyReadiness → createContact → createNote`
- [ ] 3.5 On any failure: if `PORTAL_STATUS_POLL_KEEP_ON_FAIL !== "1"`, `rollbackEntities` with this call's created IDs; return mapped error (reuse `PORTAL_*` codes)
- [ ] 3.6 On success: return `{ created: [...] }` in creation order

## 4. Association endpoint

- [ ] 4.1 Create `app/api/create/associate/route.ts` with `maxDuration = 300`
- [ ] 4.2 Validate `{ partnerCompanyId, customerCompanyId }` (both non-empty strings)
- [ ] 4.3 Idempotency per call (same 30s Set pattern)
- [ ] 4.4 Call `associateCompanies`; on success return `{ created: [{ type: "Association", ... }] }`
- [ ] 4.5 On failure: return 5xx; do NOT attempt to delete companies

## 5. Rollback endpoint

- [ ] 5.1 Create `app/api/create/rollback/route.ts` with `maxDuration = 60`
- [ ] 5.2 Validate `{ ids: [{ type, id }] }`; reject types not in `{ company, contact, note }` with 400
- [ ] 5.3 Cap `ids.length <= 8`; reject over-cap with 400
- [ ] 5.4 Call `rollbackEntities(token, ids)`; return `{ deleted, failed }`

## 6. Remove old route

- [ ] 6.1 Delete `app/api/create/route.ts`
- [ ] 6.2 Verify no other code imports from it (grep)

## 7. Client orchestration

- [ ] 7.1 Rewrite `handleSubmit` in `app/page.tsx`: accumulate `allCreated: CreatedEntity[]` in a local variable across phase calls
- [ ] 7.2 Phase 1: if `doPartner`, POST `/api/create/side` with `side: "partner"`; on failure → surface error (server already rolled back) and return
- [ ] 7.3 Phase 2: if `doCustomer`, POST `/api/create/side` with `side: "customer"`; on failure → call rollback with `allCreated` so far (partner entities), then surface error
- [ ] 7.4 Phase 3 (both sides only): POST `/api/create/associate`; on failure → call rollback with `allCreated` (both sides), then surface error
- [ ] 7.5 `setResults(allCreated)` on final success
- [ ] 7.6 Preserve existing progress-tick behavior: on phase transitions, the elapsed-time-based `computeProgress` continues to work because the per-side timing still matches

## 8. Client-side timing constants

- [ ] 8.1 Update `POLL_WINDOW_1_MS`, `POLL_WINDOW_2_MS`, `POLL_WINDOW_3_MS` in `app/page.tsx` to match new delays (60_000 / 60_000 / 120_000)
- [ ] 8.2 Verify `SIDE_TOTAL_MS` math is correct with new windows

## 9. Tests

- [ ] 9.1 Create `lib/__tests__/hubspot-entities.test.ts` following the node:test / native-TS pattern used by `portal-status.test.ts`
- [ ] 9.2 Test `rollbackEntities`: normal reverse-order deletion, 404-is-success, partial failure accounting
- [ ] 9.3 Test `createNote`: uses correct association type IDs (190 for company, 202 for contact)
- [ ] 9.4 Test `associateCompanies`: uses association type ID 13
- [ ] 9.5 Verify `npm test` — all suites pass

## 10. Docs

- [ ] 10.1 Update `CLAUDE.md` architecture section to describe the three-route phased flow, the 240s per-side budget, and the client's rollback responsibility
- [ ] 10.2 Update any description of the old single-route transaction

## 11. Validation

- [ ] 11.1 `openspec validate split-create-into-phases --strict`
- [ ] 11.2 `npm test` (all green)
- [ ] 11.3 `npm run build` with stub env (clean)
