## 1. Setup & Dependencies

- [x] 1.1 Install `iron-session` package
- [x] 1.2 Create `.env.local` with `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `HUBSPOT_REDIRECT_URI`, `SESSION_SECRET` placeholders
- [x] 1.3 Create `lib/session.ts` with iron-session config (cookie name, password from env, cookie options: httpOnly, secure, sameSite=lax) and session type definition (`accessToken`, `refreshToken`, `expiresAt`, `portalId`, `oauthState`)

## 2. Auth Routes

- [x] 2.1 Create `app/api/auth/install/route.ts` — generate random state, store in session, redirect to HubSpot authorize URL with client_id, redirect_uri, scope, state
- [x] 2.2 Create `app/api/auth/callback/route.ts` — validate state parameter, exchange code for tokens via HubSpot `/oauth/v1/token`, fetch portal ID from `/account-info/v3/details`, store all in session, redirect to `/`
- [x] 2.3 Create `app/api/auth/logout/route.ts` — destroy session, redirect to `/`
- [x] 2.4 Create `app/api/auth/me/route.ts` — return `{ loggedIn, portalId }` from session (never expose tokens)

## 3. Token Refresh Helper

- [x] 3.1 Create `lib/hubspot-token.ts` with `getHubSpotToken(req)` helper that reads session, checks `expiresAt` (5-min buffer), refreshes via HubSpot if needed, updates session, returns valid access token
- [x] 3.2 Handle refresh failure (revoked token) by clearing session and returning null/throwing

## 4. Refactor Existing API Routes

- [x] 4.1 Update `app/api/labels/route.ts` — remove token from request body, use `getHubSpotToken()` from session, return 401 if unauthenticated
- [x] 4.2 Update `app/api/create/route.ts` — remove token from request body, use `getHubSpotToken()` from session, return 401 if unauthenticated

## 5. Frontend Auth Integration

- [x] 5.1 Add auth state check on page load — call `/api/auth/me` and store `loggedIn`/`portalId` in state
- [x] 5.2 Replace token input section with "Connect to HubSpot" button (links to `/api/auth/install`) when not logged in
- [x] 5.3 Show logged-in state indicator (portal ID, disconnect button linking to `/api/auth/logout`) when authenticated
- [x] 5.4 Remove `token` from form submission payloads (`/api/create`, `/api/labels` calls)
- [x] 5.5 Handle 401 responses from API routes — show session expired message with re-auth link

## 6. Vercel & Environment Config

- [x] 6.1 Verify `next.config.js` needs no changes for cookie-based auth on Vercel
- [x] 6.2 Document required Vercel environment variables in README or `.env.example`
- [ ] 6.3 Test full OAuth flow: install → callback → entity creation → logout
