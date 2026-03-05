## ADDED Requirements

### Requirement: Encrypted cookie session
The system SHALL store session data in an encrypted HTTP-only cookie using `iron-session`. The cookie MUST be encrypted with a `SESSION_SECRET` environment variable of at least 32 characters.

#### Scenario: Session cookie properties
- **WHEN** a session is created or updated
- **THEN** the cookie MUST be HTTP-only, Secure (in production), SameSite=Lax, and encrypted with the configured secret

#### Scenario: Missing SESSION_SECRET
- **WHEN** the application starts without a `SESSION_SECRET` environment variable
- **THEN** auth routes MUST fail with a clear server error rather than using an insecure default

### Requirement: Session stores OAuth tokens
The session SHALL store `accessToken`, `refreshToken`, `expiresAt` (Unix timestamp in milliseconds), and `portalId`.

#### Scenario: Session payload after login
- **WHEN** a user completes OAuth and the callback stores tokens
- **THEN** the session contains all four fields with correct values from HubSpot's token response

### Requirement: Auth status endpoint
The system SHALL provide a `/api/auth/me` endpoint that returns the current authentication status without exposing tokens.

#### Scenario: Authenticated user checks status
- **WHEN** an authenticated user calls `/api/auth/me`
- **THEN** system returns `{ loggedIn: true, portalId: "<id>" }` without exposing access or refresh tokens

#### Scenario: Unauthenticated user checks status
- **WHEN** an unauthenticated user calls `/api/auth/me`
- **THEN** system returns `{ loggedIn: false }`

### Requirement: Logout clears session
The system SHALL provide a `/api/auth/logout` endpoint that destroys the session cookie and redirects to the app root.

#### Scenario: User logs out
- **WHEN** user navigates to `/api/auth/logout`
- **THEN** system clears the session cookie and redirects to `/`

### Requirement: Frontend auth state
The frontend SHALL check `/api/auth/me` on load and render either a "Connect to HubSpot" button or the entity creation form based on login status.

#### Scenario: User is not logged in
- **WHEN** the page loads and `/api/auth/me` returns `{ loggedIn: false }`
- **THEN** the UI shows a "Connect to HubSpot" button that links to `/api/auth/install`

#### Scenario: User is logged in
- **WHEN** the page loads and `/api/auth/me` returns `{ loggedIn: true, portalId: "..." }`
- **THEN** the UI shows the entity creation form with the portal ID displayed, and no token input field

#### Scenario: User session expires mid-use
- **WHEN** an API call returns 401 while the user is using the app
- **THEN** the UI shows a message indicating the session has expired and provides a link to re-authenticate
