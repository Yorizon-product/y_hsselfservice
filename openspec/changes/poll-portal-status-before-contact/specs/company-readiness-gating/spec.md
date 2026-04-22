## ADDED Requirements

### Requirement: Poll company provisioning status before contact creation

The system SHALL poll the `portal_status_update` custom property on a newly-created HubSpot company and only create the associated contact once the property reports successful provisioning. The polling SHALL execute entirely server-side within the existing `POST /api/create` handler in `app/api/create/route.ts`.

#### Scenario: Company provisions successfully on the first poll

- **WHEN** a company has just been created and the server fetches `portal_status_update` at T=0 (immediately after the create call returns)
- **AND** the property value is `<timestamp>: Company created successfully`
- **THEN** the system SHALL proceed to create the associated contact using the existing `createContact()` helper

#### Scenario: Company provisions successfully on the first retry

- **WHEN** a company has just been created
- **AND** the property value at T=0 is empty or null
- **AND** the property value at T=10s is `<timestamp>: Company created successfully`
- **THEN** the system SHALL proceed to create the associated contact

#### Scenario: Company provisions successfully on the second retry

- **WHEN** a company has just been created
- **AND** the property value at T=0 and T=10s is empty or null
- **AND** the property value at T=30s is `<timestamp>: Company created successfully`
- **THEN** the system SHALL proceed to create the associated contact

### Requirement: Bounded poll budget with three attempts

The system SHALL attempt at most three reads of `portal_status_update`: one immediately after company creation (T=0), and two retries at T=10s and T=30s measured from the moment the HubSpot company-create call returned. The system SHALL NOT add additional attempts beyond these three.

#### Scenario: Status never appears within the poll budget

- **WHEN** a company has just been created
- **AND** the property value is empty or null at T=0, T=10s, and T=30s
- **THEN** the system SHALL abort the create flow with error code `PORTAL_TIMEOUT`
- **AND** the system SHALL invoke `rollbackEntities()` to delete the created company
- **AND** the system SHALL return HTTP 500 with an error message indicating provisioning did not complete in time

### Requirement: Terminal-failure short-circuit

The system SHALL stop polling and fail immediately when `portal_status_update` reports a known terminal failure, without waiting for the remaining retries.

#### Scenario: Creation failure on first poll

- **WHEN** a company has just been created
- **AND** the property value at T=0 is `<timestamp>: Company creation failed`
- **THEN** the system SHALL NOT execute further polls
- **AND** the system SHALL abort the create flow with error code `PORTAL_CREATION_FAILED`
- **AND** the system SHALL invoke `rollbackEntities()` to delete the created company
- **AND** the system SHALL return HTTP 500 with an error message naming `Company creation failed`

#### Scenario: Creation failure on retry

- **WHEN** the property value at T=0 is empty
- **AND** the property value at T=10s is `<timestamp>: Company creation failed`
- **THEN** the system SHALL NOT execute the third poll
- **AND** the system SHALL abort with `PORTAL_CREATION_FAILED` and roll back

### Requirement: Unexpected-state handling

The system SHALL treat any non-empty `portal_status_update` value that is neither the known success message (`Company created successfully`) nor the known terminal-failure message (`Company creation failed`) as "keep polling" for the remainder of the budget, and as a failure condition when the budget is exhausted.

#### Scenario: Unknown status at final attempt

- **WHEN** a company has just been created
- **AND** the property value at T=0 is empty
- **AND** the property value at T=10s is empty
- **AND** the property value at T=30s is `<timestamp>: Company updated successfully` (or any other unexpected message)
- **THEN** the system SHALL abort with error code `PORTAL_UNEXPECTED_STATE`
- **AND** the system SHALL include the raw property value in the server audit log for debugging
- **AND** the system SHALL invoke `rollbackEntities()` to delete the created company

#### Scenario: Unknown status on early attempt continues polling

- **WHEN** the property value at T=0 is `<timestamp>: Some unrecognised message`
- **THEN** the system SHALL wait 10s and poll again rather than failing immediately

### Requirement: Status timestamp validation against baseline

The system SHALL parse the leading `DD/MM/YYYY HH:MM:SS.sss: ` timestamp from `portal_status_update` and reject any value whose timestamp predates the company's `createdAt` minus a 2-second clock-skew allowance. Rejected values SHALL be treated identically to empty/null (continue polling).

#### Scenario: Stale status on a freshly created company

- **WHEN** the company's `createdAt` is `2026-04-22T10:00:05.000Z`
- **AND** the property value at T=0 is `22/04/2026 09:59:00.000: Company created successfully` (5 seconds before create, exceeding the 2s skew window)
- **THEN** the system SHALL treat the value as stale and continue polling

### Requirement: Per-side gating in Advanced mode

The system SHALL gate contact creation on company readiness independently for the partner side and the customer side. The partner company SHALL be polled before the partner contact is created; the customer company SHALL be polled before the customer contact is created. Order matches the existing sequential creation order in `app/api/create/route.ts`.

#### Scenario: Partner-side timeout in combined create

- **WHEN** the request body includes both a partner and a customer
- **AND** the partner company is created successfully but its poll times out
- **THEN** the system SHALL NOT create the customer company
- **AND** the system SHALL roll back the partner company
- **AND** the system SHALL return an error identifying the partner side as the failure point

#### Scenario: Customer-side failure after partner success

- **WHEN** the partner company polls successfully and the partner contact is created
- **AND** the customer company is created and its poll reports `Company creation failed`
- **THEN** the system SHALL roll back in reverse order: customer company, partner contact, partner company

### Requirement: Feature flag kill switch

The system SHALL read an environment variable `PORTAL_STATUS_POLL` at module load. When set to the string `off`, the system SHALL skip the poll entirely and behave as it did before this change (create contact immediately after company). Any other value (including unset) SHALL enable polling.

#### Scenario: Polling disabled via env

- **WHEN** `PORTAL_STATUS_POLL=off` at startup
- **AND** a company-create request is made
- **THEN** the system SHALL NOT call the HubSpot `GET /crm/v3/objects/companies/{id}` endpoint for status
- **AND** the system SHALL create the contact immediately after the company, matching pre-change behaviour

#### Scenario: Polling enabled by default

- **WHEN** `PORTAL_STATUS_POLL` is unset at startup
- **THEN** the system SHALL perform the poll as specified in the other requirements

### Requirement: Server audit log of poll attempts

The system SHALL emit one `[audit]` log line per poll attempt, including the company ID, the attempt number (1/3, 2/3, 3/3), and the raw `portal_status_update` value (or `<empty>` if null/blank). On terminal failure or timeout, the system SHALL also log the decision (`PORTAL_CREATION_FAILED`, `PORTAL_UNEXPECTED_STATE`, or `PORTAL_TIMEOUT`).

#### Scenario: Successful first-attempt poll is logged

- **WHEN** a poll at T=0 returns `Company created successfully`
- **THEN** the server logs contain an `[audit]` line matching `poll 1/3 company=<id> status="...: Company created successfully" → proceed`

#### Scenario: Timeout is logged with final raw value

- **WHEN** all three polls return empty
- **THEN** the server logs contain three `[audit]` poll lines followed by one `[audit] poll-result company=<id> decision=PORTAL_TIMEOUT` line

### Requirement: Client-visible progress indicator

The client SHALL display a staged progress indicator during a create request, replacing the existing single-state spinner. The indicator SHALL show the current phase using i18n strings under the `poll.*` key group, including at minimum: creating-partner-company, waiting-partner-provisioning, creating-partner-contact, creating-customer-company, waiting-customer-provisioning, creating-customer-contact. The "waiting-*-provisioning" phases SHALL include a retry counter when the poll enters its second or third attempt.

#### Scenario: Indicator transitions through stages

- **WHEN** a request is in-flight for 0–500ms
- **THEN** the client displays the "creating-partner-company" label

- **WHEN** the request has been in-flight for 500ms–10s (during the first poll window)
- **THEN** the client displays the "waiting-partner-provisioning" label without a retry counter

- **WHEN** the request has been in-flight 10s–30s (during the retry window)
- **THEN** the client displays the "waiting-partner-provisioning" label with retry counter "1/2"

#### Scenario: Timeout surfaces a user-readable error

- **WHEN** the server returns a `PORTAL_TIMEOUT` error
- **THEN** the client renders the i18n string `poll.error.timeout` rather than the raw server message
- **AND** the rollback summary (from the existing `rolledBack` array) is still shown

### Requirement: Vercel function duration

The `app/api/create/route.ts` module SHALL declare `export const maxDuration = 60` to permit poll budgets that exceed Vercel's default 10-second serverless function timeout.

#### Scenario: Long-running request completes within extended duration

- **WHEN** a request takes ~45 seconds due to two sequential poll retries on both sides
- **THEN** the Vercel runtime SHALL NOT terminate the request before completion
