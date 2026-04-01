## ADDED Requirements

### Requirement: Partial entity payload support
The POST `/api/create` endpoint SHALL accept payloads where `partner` or `customer` is null/omitted. At least one of the two MUST be provided.

#### Scenario: Partner-only creation
- **WHEN** the request body contains `partner` data and `customer` is null
- **THEN** the API creates the partner company + contact only, skips customer creation and association, and returns the created partner entities

#### Scenario: Customer-only creation
- **WHEN** the request body contains `customer` data and `partner` is null
- **THEN** the API creates the customer company + contact only, skips partner creation and association, and returns the created customer entities

#### Scenario: Both entities provided
- **WHEN** the request body contains both `partner` and `customer` data
- **THEN** the API creates both entity pairs and the company-to-company association, matching existing behavior

#### Scenario: Neither entity provided
- **WHEN** the request body contains neither `partner` nor `customer` (both null)
- **THEN** the API returns HTTP 400 with error "At least one entity (partner or customer) is required"

### Requirement: Per-entity role assignment
The API SHALL support independent portal role assignment per entity via `partnerRole` and `customerRole` fields.

#### Scenario: Per-entity roles provided
- **WHEN** the request body includes `partnerRole: "User-RO"` and `customerRole: "Admin-RW"`
- **THEN** the partner contact is created with `portal_role = "User-RO"` and the customer contact with `portal_role = "Admin-RW"`

#### Scenario: Shared role fallback (backward compatibility)
- **WHEN** the request body includes `portalRole` (singular) instead of per-entity roles
- **THEN** the API applies `portalRole` to all created contacts, matching existing Simple mode behavior

#### Scenario: Per-entity role for single entity
- **WHEN** only `partner` is provided with `partnerRole: "User-RW"`
- **THEN** the partner contact is created with `portal_role = "User-RW"` and `customerRole` is ignored

#### Scenario: Mixed role fields rejected
- **WHEN** the request body includes both `portalRole` (singular) AND either `partnerRole` or `customerRole`
- **THEN** the API SHALL return HTTP 400 with error "Cannot provide both shared portalRole and per-entity roles. Use one or the other."

### Requirement: Portal role allowlist validation
The API SHALL validate all portal role values against a server-side allowlist before passing them to HubSpot. The valid values are: "Admin-RW", "User-RW", "User-RO".

#### Scenario: Valid role accepted
- **WHEN** the request body includes `partnerRole: "User-RO"`
- **THEN** the API accepts the value and passes it to HubSpot as `portal_role`

#### Scenario: Invalid role rejected
- **WHEN** the request body includes `partnerRole: "SuperAdmin"` or any string not in the allowlist
- **THEN** the API SHALL return HTTP 400 with error "Invalid portal role: SuperAdmin. Valid values: Admin-RW, User-RW, User-RO"

#### Scenario: Empty role uses default
- **WHEN** no role field is provided for an entity
- **THEN** the API SHALL default to "User-RO" (least-privilege default)

### Requirement: Conditional association creation
The company-to-company association (typeId 13) SHALL only be created when both partner and customer companies are successfully created.

#### Scenario: Association created for both entities
- **WHEN** both partner company and customer company are successfully created
- **THEN** the API creates the association between them and includes it in the response

#### Scenario: Association skipped for single entity
- **WHEN** only one entity (partner or customer) is created
- **THEN** no association is created, and no association entry appears in the response

### Requirement: Partial rollback on failure
Rollback SHALL only delete entities that were actually created during the current request.

#### Scenario: Failure during customer creation after partner success
- **WHEN** partner company + contact are created successfully but customer company creation fails
- **THEN** the API rolls back only the partner company and partner contact (in reverse order) and returns an error

#### Scenario: Failure during single-entity creation
- **WHEN** only partner is requested and partner contact creation fails after company creation succeeds
- **THEN** the API rolls back only the partner company and returns an error

#### Scenario: Failure during association after both entities succeed
- **WHEN** both entity pairs are created successfully but the association step fails
- **THEN** the API rolls back all four entities (two contacts, then two companies) in reverse order and returns an error

### Requirement: Rollback error response
When a rollback occurs, the API error response SHALL include a `rolledBack` array listing the entity types that were created and then deleted, enabling the UI to communicate clearly what happened.

#### Scenario: Rollback response includes entity list
- **WHEN** partner company + contact are created but customer creation fails and rollback occurs
- **THEN** the API error response includes `{ "error": "...", "rolledBack": ["partner_contact", "partner_company"] }`

#### Scenario: Full rollback response after association failure
- **WHEN** all 4 entities are created but association fails and all are rolled back
- **THEN** the API error response includes `{ "error": "...", "rolledBack": ["customer_contact", "customer_company", "partner_contact", "partner_company"] }`

### Requirement: Audit logging for partial operations
Audit log entries SHALL accurately reflect which entities were created, including single-entity operations.

#### Scenario: Single entity audit log
- **WHEN** a partner-only creation succeeds
- **THEN** the audit log records the creator email, the operation type ("partner-only"), and the created entity IDs

#### Scenario: Both entities audit log
- **WHEN** both entities and association are created
- **THEN** the audit log records all created entity IDs including the association, matching existing behavior
