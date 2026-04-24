## ADDED Requirements

### Requirement: Per-side creation endpoint

The system SHALL expose `POST /api/create/side` that creates the full entity stack for exactly one side (partner or customer): company → note on company → poll portal readiness → contact associated to company → note on contact.

#### Scenario: Successful partner side creation

- **WHEN** the client POSTs `{ side: "partner", payload: { name, domain, contact: {...} }, portalRole: "User-RO" }` with a valid idempotency key and session
- **THEN** the system SHALL create the company, attach the initial note, poll `portal_status_update` until `"Company created successfully"` within the 240s budget, create the contact associated to the company, attach the contact note, and respond 200 with `{ created: [{ type, id, name, url }] }` in creation order
- **AND** the created IDs SHALL be suitable input for `POST /api/create/rollback`

#### Scenario: Mid-flow server-side rollback on poll failure

- **WHEN** the side route creates a company but `pollCompanyReadiness` throws `PortalStatusError`
- **AND** `PORTAL_STATUS_POLL_KEEP_ON_FAIL` is not `"1"`
- **THEN** the system SHALL delete every entity it created in this call in reverse order before returning
- **AND** the response SHALL be 5xx with a JSON body containing `{ error, code }` matching the existing `PORTAL_*` codes
- **AND** no orphan company SHALL remain in HubSpot

#### Scenario: Debug keep-on-fail preserves records

- **WHEN** a side call fails mid-flow
- **AND** `PORTAL_STATUS_POLL_KEEP_ON_FAIL === "1"`
- **THEN** the system SHALL skip its internal rollback and include the partial `kept` URLs in the error response body, matching today's behavior

#### Scenario: Idempotency on retried submission

- **WHEN** the client POSTs to `/api/create/side` twice within 30 seconds with the same `x-idempotency-key` header
- **THEN** the second request SHALL be rejected with 409 Conflict
- **AND** no duplicate HubSpot entities SHALL be created

### Requirement: Association endpoint

The system SHALL expose `POST /api/create/associate` that creates the parent-company association between two existing HubSpot companies.

#### Scenario: Successful association

- **WHEN** the client POSTs `{ partnerCompanyId: "<id>", customerCompanyId: "<id>" }` with a valid session
- **THEN** the system SHALL create the parent-company association using `associationTypeId: 13`
- **AND** respond 200 with `{ created: [{ type: "Association", ... }] }`

#### Scenario: Association failure is the caller's responsibility

- **WHEN** the association call fails (HubSpot 4xx/5xx)
- **THEN** the system SHALL return a 5xx with the mapped friendly error code
- **AND** the system SHALL NOT attempt to delete either company — cleanup is the client's responsibility via `POST /api/create/rollback`

### Requirement: Rollback endpoint

The system SHALL expose `POST /api/create/rollback` that deletes a client-supplied list of previously-created HubSpot entity IDs in reverse order.

#### Scenario: Successful rollback

- **WHEN** the client POSTs `{ ids: [{ type: "contact", id: "123" }, { type: "company", id: "456" }] }` with a valid session
- **THEN** the system SHALL delete each entity in reverse order (the last-created entity deleted first)
- **AND** respond 200 with `{ deleted: [...], failed: [...] }`

#### Scenario: Type whitelist enforcement

- **WHEN** the client POSTs an entity with a `type` other than `"company"`, `"contact"`, or `"note"`
- **THEN** the system SHALL reject the request with 400 Bad Request
- **AND** SHALL NOT attempt any deletion

#### Scenario: Size cap enforcement

- **WHEN** the client POSTs more than 8 IDs in a single call
- **THEN** the system SHALL reject the request with 400 Bad Request

#### Scenario: Partial failure tolerance

- **WHEN** some IDs in the batch have already been deleted (HubSpot returns 404)
- **THEN** the system SHALL treat 404 as success for rollback purposes and continue
- **AND** include the ID in the `deleted` list of the response

### Requirement: Extended per-side polling budget

The system SHALL use per-attempt delays of `[60_000, 60_000, 120_000]` milliseconds for the portal-status polling loop, giving each side 240 seconds of provisioning tolerance.

#### Scenario: Default polling delays

- **WHEN** the server-side poll runs without overriding `opts.delaysMs`
- **THEN** the successive `sleep` calls SHALL be 60s, 60s, and 120s respectively
- **AND** cumulative T from company creation SHALL be 60s / 120s / 240s for attempts 1 / 2 / 3

### Requirement: Client orchestrates phases and cross-phase rollback

The client SHALL invoke the three routes sequentially — partner side (if selected), customer side (if selected), associate (only when both sides are selected) — and SHALL call `/api/create/rollback` with all previously-accumulated IDs if any subsequent phase fails.

#### Scenario: Partner succeeds, customer fails — client rolls back partner

- **WHEN** `POST /api/create/side` for partner responds 200 with partner IDs
- **AND** `POST /api/create/side` for customer responds 5xx
- **THEN** the client SHALL call `POST /api/create/rollback` with the partner IDs before surfacing the error to the user
- **AND** the user SHALL see the normal friendly error in the inline banner and (if applicable) a browser notification

#### Scenario: Both sides succeed, association fails — client rolls back both

- **WHEN** both side calls succeed
- **AND** `POST /api/create/associate` responds 5xx
- **THEN** the client SHALL call `POST /api/create/rollback` with the combined partner + customer IDs
- **AND** surface the friendly error

#### Scenario: Single-side flow skips association

- **WHEN** only one of partner / customer is enabled
- **THEN** the client SHALL NOT call `/api/create/associate`

### Requirement: User-visible progress and notifications unchanged

The change SHALL preserve the existing per-stage progress indicator (stages, step counter, step pips, waiting-ring countdown) and the browser-notification dispatch on terminal states.

#### Scenario: Progress stages render as before

- **WHEN** the user submits both partner and customer
- **THEN** the progress indicator SHALL cycle through the same 7 stages as today (`creatingPartnerCompany`, `waitingPartnerProvisioning`, `creatingPartnerContact`, `creatingCustomerCompany`, `waitingCustomerProvisioning`, `creatingCustomerContact`, `associating`)
- **AND** the step counter SHALL show `Step X of 7`

#### Scenario: Notifications fire on final phase completion

- **WHEN** the final phase (associate, or the last single-side `side` call) resolves
- **AND** the tab is hidden
- **THEN** the system SHALL dispatch exactly one success notification, matching the behavior specified in `creation-notifications`

#### Scenario: Notifications fire on any phase error

- **WHEN** any phase rejects (and client rollback completes)
- **AND** the tab is hidden
- **THEN** the system SHALL dispatch exactly one error notification with the friendly error body
