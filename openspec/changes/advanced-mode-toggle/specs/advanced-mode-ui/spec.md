## ADDED Requirements

### Requirement: Mode toggle segmented control
The system SHALL display a two-segment pill control with "Simple" and "Advanced" options on its own row below the page subtitle, full-width, above the auth status bar. "Simple" SHALL be selected by default on first visit. The segmented control SHALL be disabled (non-interactive) while a form submission is in-flight (`loading === true`).

#### Scenario: Default state on first visit
- **WHEN** the user loads the page for the first time (no localStorage value)
- **THEN** the segmented control displays with "Simple" selected and the form renders identically to the current layout

#### Scenario: Switching to Advanced mode
- **WHEN** the user clicks the "Advanced" segment
- **THEN** the form transitions to Advanced mode with `transition-opacity duration-200` and `transition-[border-style] duration-200`: entity section checkboxes become visible, per-entity role dropdowns appear in each section's action slot, and the shared Portal Role section is removed

#### Scenario: Switching back to Simple mode
- **WHEN** the user clicks the "Simple" segment while in Advanced mode
- **THEN** the form returns to Simple mode layout with smooth transitions: checkboxes are hidden (both entities enabled), per-entity role dropdowns are removed, and the shared Portal Role section reappears. Field values SHALL NOT be reset.

#### Scenario: Mode toggle locked during submission
- **WHEN** the user has clicked submit and a request is in-flight
- **THEN** the segmented control SHALL be visually disabled and non-interactive until the request completes or fails

### Requirement: Mode preference persistence
The system SHALL persist the selected mode to localStorage and restore it on subsequent page loads. The initial render SHALL suppress the form until mode is resolved from localStorage to prevent a flash of Simple mode.

#### Scenario: Mode is remembered across sessions
- **WHEN** the user selects "Advanced" mode and reloads the page
- **THEN** the form loads in Advanced mode with the segmented control showing "Advanced" as active

#### Scenario: No flash of wrong mode on load
- **WHEN** the user has "Advanced" persisted in localStorage and loads the page
- **THEN** the form SHALL NOT briefly render in Simple mode before switching — mode resolution SHALL complete before first meaningful paint of the form

### Requirement: Checkbox-gated entity sections
In Advanced mode, each entity section (Partner, Customer) SHALL display a checkbox to the left of the section title. Both checkboxes SHALL default to checked.

#### Scenario: Unchecking an entity section
- **WHEN** the user unchecks the Partner checkbox in Advanced mode
- **THEN** the Partner section content dims (opacity-50), becomes non-interactive (pointer-events-none), the border changes to dashed, and the Randomize button hides. The section header row (including checkbox) remains interactive. All inputs within the disabled section SHALL receive `disabled` attribute and `tabIndex={-1}` to prevent keyboard focus. The section wrapper SHALL have `aria-disabled="true"`.

#### Scenario: Re-enabling an entity section
- **WHEN** the user re-checks a previously unchecked entity section
- **THEN** the section returns to full opacity and interactivity with all previously entered field values preserved

#### Scenario: At least one entity must be enabled
- **WHEN** both entity checkboxes are unchecked
- **THEN** the submit button SHALL be disabled

### Requirement: Per-entity role dropdowns
In Advanced mode, each enabled entity section SHALL display a role dropdown in its action slot (next to the Randomize button). The dropdown options SHALL be "Administrator", "Read & Write", and "Read Only".

#### Scenario: Role dropdown appears in Advanced mode
- **WHEN** the user switches to Advanced mode
- **THEN** each entity section's action slot shows a role dropdown defaulting to "Read Only" (least-privilege default), and the shared Portal Role section is no longer visible. On mobile viewports (< 640px), the action slot items (role dropdown + Randomize button) SHALL stack vertically to prevent overflow.

#### Scenario: Role selection is independent per entity
- **WHEN** the user selects "Read Only" for Partner and "Read & Write" for Customer
- **THEN** the form submission sends the Partner role as "User-RO" and the Customer role as "User-RW"

### Requirement: Association status indicator
In Advanced mode, the system SHALL display a status line between the entity sections and the submit button indicating whether an association will be created.

#### Scenario: Both entities enabled
- **WHEN** both Partner and Customer checkboxes are checked
- **THEN** a green indicator dot and text "Partner-Customer association will be created" is displayed

#### Scenario: Single entity enabled
- **WHEN** only one entity checkbox is checked
- **THEN** a muted indicator dot and text "No association — single entity mode" is displayed

### Requirement: Dynamic submit button labels
The submit button label SHALL reflect the current entity selection in Advanced mode.

#### Scenario: Both entities enabled in Advanced mode
- **WHEN** both Partner and Customer are checked in Advanced mode
- **THEN** the submit button reads "Create partner + customer"

#### Scenario: Partner only in Advanced mode
- **WHEN** only Partner is checked in Advanced mode
- **THEN** the submit button reads "Create partner"

#### Scenario: Customer only in Advanced mode
- **WHEN** only Customer is checked in Advanced mode
- **THEN** the submit button reads "Create customer"

#### Scenario: Simple mode button label unchanged
- **WHEN** the user is in Simple mode
- **THEN** the submit button reads "Create all entities"

### Requirement: Mode-aware validation
The form validation SHALL only require fields for enabled entity sections.

#### Scenario: Advanced mode with partner only
- **WHEN** only Partner is checked and partner name + email are filled
- **THEN** the submit button SHALL be enabled regardless of Customer field state

#### Scenario: Advanced mode with empty required fields
- **WHEN** Partner is checked but partner name or email is empty
- **THEN** the submit button SHALL be disabled

### Requirement: Dynamic subtitle text
The page subtitle below the h1 SHALL update to reflect the current mode and entity selection.

#### Scenario: Simple mode subtitle
- **WHEN** the user is in Simple mode
- **THEN** the subtitle reads "Creates a partner company + contact, a customer company + contact, and links them with a Parent Company association."

#### Scenario: Advanced mode subtitle with both entities
- **WHEN** the user is in Advanced mode with both entities checked
- **THEN** the subtitle reads "Creates selected entities and links them with a Parent Company association."

#### Scenario: Advanced mode subtitle with single entity
- **WHEN** the user is in Advanced mode with only one entity checked
- **THEN** the subtitle reads "Creates a single entity (company + contact)."

### Requirement: Results display for partial operations
The results display SHALL group entities by type and include an explicit association status, even when the association was skipped.

#### Scenario: Single-entity results
- **WHEN** a partner-only creation succeeds
- **THEN** the results display shows a "Partner" group header with the created company and contact, and an "Association: not created — single entity mode" status line

#### Scenario: Both-entity results with association
- **WHEN** both entities and association are created
- **THEN** the results display shows "Partner" and "Customer" group headers with their entities, and an "Association: created" status line

### Requirement: Rollback error messaging
When an API error occurs and entities are rolled back, the error display SHALL clearly communicate what was created and then cleaned up.

#### Scenario: Rollback after partial failure
- **WHEN** the API returns an error with a `rolledBack` field listing cleaned-up entities
- **THEN** the error display shows the API error message AND a human-readable summary: e.g., "Partner company and contact were created but then removed — nothing was saved. You can retry safely."

#### Scenario: Association failure with full rollback
- **WHEN** both entity pairs were created but the association step fails and all 4 entities are rolled back
- **THEN** the error display shows: "Both entities were created, then removed due to an association error. Nothing was saved."

### Requirement: "Start over" behavior in Advanced mode
The post-success "Start over" button SHALL reset form field values and entity-enabled checkboxes but SHALL preserve the mode preference (Simple/Advanced).

#### Scenario: Start over in Advanced mode
- **WHEN** the user clicks "Start over" after a successful creation in Advanced mode
- **THEN** all field values are cleared, both entity checkboxes are re-checked, roles reset to defaults, results are hidden, but the mode stays on "Advanced"

### Requirement: First-visit discoverability hint
On the first visit (no mode preference in localStorage), the system SHALL display a brief inline hint near the submit button area: "Need to create just one entity? Try Advanced mode."

#### Scenario: Hint shown on first visit
- **WHEN** the user loads the page for the first time in Simple mode
- **THEN** a subtle hint text appears above the submit button: "Need to create just one entity? Try Advanced mode."

#### Scenario: Hint dismissed after first use
- **WHEN** the user switches to Advanced mode or dismisses the hint
- **THEN** the hint is hidden and a localStorage flag prevents it from showing again
