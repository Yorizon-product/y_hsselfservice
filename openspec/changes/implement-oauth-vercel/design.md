## Context

The app is a Next.js 14 (App Router) project deployed on Vercel. Currently, users paste a HubSpot Private App Token into a text field, which gets sent in the request body to API routes (`/api/create`, `/api/labels`). There is no session state, no persistent auth, and tokens live only in React state.

HubSpot's OAuth 2.0 uses the standard authorization code flow: redirect user to HubSpot → user authorizes → HubSpot redirects back with a code → server exchanges code for access/refresh tokens. Access tokens expire after 6 hours; refresh tokens are long-lived.

Vercel runs API routes as serverless functions — no shared memory between requests, no persistent process. All state must live in cookies, headers, or external stores.

## Goals / Non-Goals

**Goals:**
- Replace manual token entry with HubSpot OAuth 2.0 authorization code flow
- Persist auth state across page loads using encrypted cookies (no database needed)
- Automatically refresh expired access tokens
- Work fully on Vercel with zero additional infrastructure
- Keep the existing entity creation and association functionality intact

**Non-Goals:**
- Multi-tenant / multi-account support (one HubSpot account per session is fine)
- External session store (Redis, database) — cookies are sufficient for this app's needs
- Admin panel or user management
- Revoking tokens on HubSpot's side on logout (just clear the local session)

## Decisions

### 1. Session library: `iron-session`

**Choice:** Use `iron-session` for encrypted, stateless cookie sessions.

**Why over alternatives:**
- `next-auth` — too heavy for a single OAuth provider with no user model. Adds complexity we don't need.
- Raw JWT — requires manual encryption, cookie management, and refresh logic. `iron-session` handles all of this.
- `iron-session` encrypts the cookie payload with a 32-byte secret, stores it in an HTTP-only cookie, and works natively with Next.js App Router route handlers.

**Session payload:**
```ts
{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;      // Unix timestamp (ms)
  portalId: string;
}
```

### 2. Auth route structure

```
/api/auth/install   → Redirects to HubSpot OAuth authorize URL
/api/auth/callback  → Handles code exchange, sets session cookie, redirects to /
/api/auth/logout    → Clears session cookie, redirects to /
/api/auth/me        → Returns current auth status (logged in, portalId, etc.)
```

**Why `/api/auth/install` instead of client-side redirect:**
- Server constructs the authorize URL with `state` parameter for CSRF protection
- Keeps client ID server-side only

### 3. Token refresh strategy: lazy refresh in a shared helper

**Choice:** Before any HubSpot API call, check `expiresAt`. If within 5 minutes of expiry, refresh the token and update the session cookie.

**Why not a background job:** Vercel has no persistent process. Lazy refresh on each request is the only option without external infrastructure.

**Implementation:** A shared `getHubSpotToken(req, res)` helper that:
1. Reads the session
2. Checks expiry
3. If expired/near-expiry, calls HubSpot's token refresh endpoint
4. Updates the session cookie with new tokens
5. Returns the valid access token

### 4. CSRF protection via `state` parameter

**Choice:** Generate a random `state` value, store it in the session cookie before redirect, and verify it matches on callback.

**Why:** Standard OAuth security practice. Prevents authorization code injection attacks. No additional infrastructure needed since we already have cookie sessions.

### 5. Environment variables

```
HUBSPOT_CLIENT_ID       — From HubSpot public app settings
HUBSPOT_CLIENT_SECRET   — From HubSpot public app settings
HUBSPOT_REDIRECT_URI    — e.g. https://app.vercel.app/api/auth/callback
SESSION_SECRET          — 32+ character random string for iron-session encryption
```

These go in Vercel's environment variables dashboard and `.env.local` for dev.

### 6. Frontend auth flow

- On load, call `/api/auth/me` to check if logged in
- If not logged in: show "Connect to HubSpot" button linking to `/api/auth/install`
- If logged in: show the existing entity creation form (no token input needed)
- API routes (`/api/create`, `/api/labels`) read token from session instead of request body

### 7. OAuth scopes

Request the same scopes the current PAT needs:
- `crm.objects.companies.write`
- `crm.objects.contacts.write`
- `crm.schemas.companies.read`

## Risks / Trade-offs

- **Cookie size limit (~4KB):** OAuth tokens are typically small enough. If HubSpot ever returns large tokens, we'd need to move to an external store. → Mitigation: Monitor payload size; `iron-session` will error if too large.

- **6-hour token expiry with lazy refresh:** If a user leaves the tab open for 6+ hours without interaction and the refresh token also expires, they'll need to re-authenticate. → Mitigation: Refresh tokens are long-lived in HubSpot; only access tokens expire. Lazy refresh handles this transparently.

- **Single redirect URI:** The `HUBSPOT_REDIRECT_URI` must exactly match the deployed URL. Preview deployments on Vercel get unique URLs that won't match. → Mitigation: Use a stable production domain. For preview deploys, either skip OAuth testing or add the preview URL to HubSpot's allowed redirects.

- **No token revocation on logout:** We only clear the local cookie. The access token remains valid on HubSpot's side until it expires. → Mitigation: Acceptable for an internal tool. Access tokens expire in 6 hours anyway.
