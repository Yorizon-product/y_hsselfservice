## Why

The app currently requires users to manually paste a HubSpot Private App Token into a text field. This is insecure (tokens are sent from client to server on every request), unfriendly (users need to find and copy PATs), and doesn't support multi-user access. Proper OAuth 2.0 lets users authenticate via HubSpot's login screen, scopes permissions correctly, and works naturally on Vercel's serverless platform.

## What Changes

- **BREAKING**: Remove manual token input flow — users will authenticate via HubSpot OAuth instead
- Add HubSpot OAuth 2.0 authorization code flow (install URL → callback → token exchange)
- Add encrypted session management using HTTP-only cookies to persist auth state
- Add token refresh handling (HubSpot access tokens expire after 6 hours)
- Refactor API routes to read tokens from session instead of request body
- Add login/logout UI replacing the current token input section
- Add `/api/auth/install`, `/api/auth/callback`, `/api/auth/logout` routes
- Ensure all auth flows work on Vercel (stateless serverless functions, no in-memory sessions)

## Capabilities

### New Capabilities
- `hubspot-oauth`: HubSpot OAuth 2.0 authorization code flow — install URL generation, callback handling, token exchange, and token refresh. Vercel-compatible (stateless, cookie-based).
- `session-management`: Encrypted HTTP-only cookie sessions for storing OAuth tokens. No server-side session store required. Handles login state, token storage, and logout.

### Modified Capabilities
_(none — no existing specs)_

## Impact

- **API routes**: `/api/create` and `/api/labels` will no longer accept `token` in the request body — they'll read from the session cookie instead
- **Frontend**: Token input section replaced with "Connect to HubSpot" button and auth status indicator
- **New dependencies**: `iron-session` (encrypted cookie sessions) or similar lightweight session library
- **Environment variables**: `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `HUBSPOT_REDIRECT_URI`, `SESSION_SECRET` required
- **Vercel config**: Redirect URI must match the deployed Vercel URL; environment variables set in Vercel dashboard
- **HubSpot app setup**: Requires creating a HubSpot public app (not private app) with OAuth credentials
