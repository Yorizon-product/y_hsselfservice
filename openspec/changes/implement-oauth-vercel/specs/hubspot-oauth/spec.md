## ADDED Requirements

### Requirement: OAuth install redirect
The system SHALL provide a `/api/auth/install` endpoint that redirects the user to HubSpot's OAuth authorization URL with the correct client ID, redirect URI, requested scopes, and a CSRF `state` parameter.

#### Scenario: User initiates OAuth flow
- **WHEN** user navigates to `/api/auth/install`
- **THEN** system generates a random `state` value, stores it in the session, and responds with a 302 redirect to `https://app.hubspot.com/oauth/authorize` with query parameters: `client_id`, `redirect_uri`, `scope` (crm.objects.companies.write, crm.objects.contacts.write, crm.schemas.companies.read), and `state`

### Requirement: OAuth callback handles code exchange
The system SHALL provide a `/api/auth/callback` endpoint that receives the authorization code from HubSpot, validates the `state` parameter, exchanges the code for access and refresh tokens, stores them in the session, and redirects to the app root.

#### Scenario: Successful callback with valid state
- **WHEN** HubSpot redirects to `/api/auth/callback` with a valid `code` and matching `state` parameter
- **THEN** system exchanges the code for tokens via HubSpot's `/oauth/v1/token` endpoint, stores `accessToken`, `refreshToken`, `expiresAt`, and `portalId` in the session cookie, and redirects to `/`

#### Scenario: Callback with mismatched state
- **WHEN** HubSpot redirects to `/api/auth/callback` with a `state` parameter that does not match the session
- **THEN** system rejects the request with an error and does not exchange the code

#### Scenario: Callback with missing code
- **WHEN** HubSpot redirects to `/api/auth/callback` without a `code` parameter
- **THEN** system redirects to `/` with an error indicator

### Requirement: Token refresh on expiry
The system SHALL automatically refresh the HubSpot access token when it is expired or within 5 minutes of expiry, before making any HubSpot API call.

#### Scenario: Access token near expiry
- **WHEN** an API route needs a HubSpot token and the current `expiresAt` is within 5 minutes of the current time
- **THEN** system calls HubSpot's `/oauth/v1/token` with `grant_type=refresh_token`, updates the session with new `accessToken`, `refreshToken`, and `expiresAt`, and returns the new access token

#### Scenario: Refresh token invalid
- **WHEN** the refresh token call to HubSpot fails (e.g., token revoked)
- **THEN** system clears the session and returns a 401 response indicating re-authentication is needed

### Requirement: OAuth scopes match current functionality
The system SHALL request exactly the scopes needed for the app's current features: `crm.objects.companies.write`, `crm.objects.contacts.write`, and `crm.schemas.companies.read`.

#### Scenario: Scopes in authorize URL
- **WHEN** the install redirect is constructed
- **THEN** the `scope` query parameter MUST contain `crm.objects.companies.write crm.objects.contacts.write crm.schemas.companies.read`

### Requirement: API routes use session token
The system SHALL modify `/api/create` and `/api/labels` to read the HubSpot access token from the session cookie instead of the request body.

#### Scenario: Authenticated API request
- **WHEN** a request hits `/api/create` or `/api/labels` with a valid session containing an access token
- **THEN** the route uses the session's access token for HubSpot API calls and does not require a `token` field in the request body

#### Scenario: Unauthenticated API request
- **WHEN** a request hits `/api/create` or `/api/labels` without a valid session
- **THEN** the route returns a 401 JSON response with an error message
