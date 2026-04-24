## ADDED Requirements

### Requirement: Browser notifications on terminal create-flow states

The system SHALL dispatch a Web Notification when the `/api/create` flow resolves or rejects, so that the user receives feedback on partner/customer creation without needing to keep the tab in focus.

#### Scenario: Success notification when tab is hidden

- **WHEN** a create request resolves successfully
- **AND** `document.visibilityState === "hidden"` at the moment of resolution
- **AND** `Notification.permission === "granted"`
- **THEN** the system SHALL dispatch a single notification with the localized success title and a body summarizing which entities were created (partner, customer, or both)
- **AND** the notification SHALL use the tag `hsselfservice-create` so any lingering prior notification from this app is replaced in place

#### Scenario: Error notification when tab is hidden

- **WHEN** a create request rejects
- **AND** `document.visibilityState === "hidden"` at the moment of rejection
- **AND** `Notification.permission === "granted"`
- **THEN** the system SHALL dispatch a single notification with the localized error title and the same friendly error message that is rendered inline
- **AND** the notification body SHALL NOT include raw HubSpot status text, portal IDs, tokens, or debug-only "kept in HubSpot" URLs

#### Scenario: No notification when tab is visible

- **WHEN** a create request resolves or rejects
- **AND** `document.visibilityState === "visible"` at the moment of completion
- **THEN** the system SHALL NOT dispatch a notification
- **AND** the inline success/error UI SHALL render as it does today

### Requirement: Lazy permission prompt tied to user action

The system SHALL request notification permission only in response to an explicit user-initiated submit, never on page load, and only when the permission state is `default`.

#### Scenario: First submit with default permission

- **WHEN** the user presses the submit button
- **AND** `Notification.permission === "default"`
- **AND** the Notification API is supported in the browser
- **THEN** the system SHALL call `Notification.requestPermission()` before awaiting the create request
- **AND** the permission outcome SHALL NOT block or delay the create request from proceeding

#### Scenario: Subsequent submits do not re-prompt

- **WHEN** the user presses the submit button
- **AND** `Notification.permission` is `granted` or `denied`
- **THEN** the system SHALL NOT call `Notification.requestPermission()` again

#### Scenario: No prompt on initial page render

- **WHEN** the page loads for an authenticated user
- **THEN** the system SHALL NOT call `Notification.requestPermission()`

### Requirement: Graceful degradation when unsupported or denied

The system SHALL degrade silently when the Notification API is unavailable, when permission is denied, or when the browser throws while constructing a notification. The existing inline progress / success / error UI SHALL remain authoritative in all cases.

#### Scenario: Notification API unsupported

- **WHEN** `window.Notification` is undefined (e.g. unsupported browser)
- **AND** the user submits a create request
- **THEN** the system SHALL skip any permission request and any notification dispatch
- **AND** no errors SHALL be surfaced to the user
- **AND** the inline UI SHALL behave exactly as if the notification feature were absent

#### Scenario: Permission denied

- **WHEN** `Notification.permission === "denied"`
- **AND** a create request completes (success or error)
- **THEN** the system SHALL NOT attempt to construct a notification
- **AND** the inline UI SHALL render the result as today

#### Scenario: Notification constructor throws

- **WHEN** constructing the notification throws (e.g. locked-down context)
- **THEN** the error SHALL be swallowed
- **AND** the inline UI SHALL render the result as today

### Requirement: Clicking a notification focuses the tab

The system SHALL bring the originating tab to the foreground when the user clicks a dispatched notification, and the notification SHALL close on click.

#### Scenario: Click pulls user back to tab

- **WHEN** the user clicks a notification dispatched by the create flow
- **THEN** `window.focus()` SHALL be called on the originating page
- **AND** the notification SHALL be closed

### Requirement: Localized notification copy (EN + DE)

The system SHALL pull all notification title and body strings through the existing `useTranslation()` / `t(key, vars)` mechanism, with entries in `locales/en.json` and `locales/de.json`. German strings SHALL use `du`-form per project convention.

#### Scenario: Success body reflects which entities were created

- **WHEN** a notification is dispatched after a successful create
- **AND** only the partner side was created
- **THEN** the body SHALL be the localized `notify.success.body.partner` string
- **WHEN** only the customer side was created
- **THEN** the body SHALL be the localized `notify.success.body.customer` string
- **WHEN** both sides were created
- **THEN** the body SHALL be the localized `notify.success.body.both` string

#### Scenario: Error body carries the friendly message

- **WHEN** a notification is dispatched after a failed create
- **THEN** the title SHALL be the localized `notify.error.title`
- **AND** the body SHALL be the friendly, already-localized error message (the same text shown inline, minus raw HubSpot status and kept-URL blocks)
