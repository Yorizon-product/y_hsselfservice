# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Next.js 14 (App Router) self-service tool that creates test partner/customer entities in HubSpot. It authenticates via HubSpot OAuth, stores tokens in an encrypted iron-session cookie, and proxies CRM calls so the user's token never leaves the server. Designed to deploy to Vercel with zero infrastructure beyond env vars.

## Commands

```bash
npm install
npm run dev               # next dev @ http://localhost:3000
npm run build             # runs `sync-theme` (prebuild) then `next build`
npm start                 # production server
npm run sync-theme        # pull tokens from tweakcn (needs TWEAKCN_URL)
npm run lighthouse        # full LHCI run against a locally built `npm start`
npm run lighthouse:a11y   # accessibility-only Lighthouse via scripts/lighthouse-a11y.mjs
npm test                  # node --test on lib/**/__tests__/*.test.ts (native TS, no deps)
```

The test suite uses Node's built-in test runner with native TypeScript type-stripping (requires Node ≥ 22.18). Tests sit next to the code they cover in `lib/**/__tests__/*.test.ts`. Cross-module imports in test files use explicit `.ts` extensions so Node can resolve them. There is no linter configured beyond `tsc --noEmit` (implicit via `next build`). Type errors surface at build time only.

`npm run prepare` installs `scripts/bump-version.sh` as a Git pre-commit hook. The hook auto-bumps `package.json`'s patch version whenever files under `app/`, `lib/`, `components/`, or `middleware` are staged — so the in-app version badge (read from `package.json` at build time) stays in sync with shipped code. Do **not** manually bump patch versions for app-code changes; the hook does it. Only bump manually for minor/major.

## Required env (see .env.example)

- `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `HUBSPOT_REDIRECT_URI` — HubSpot OAuth app
- `SESSION_SECRET` — ≥32 chars; `lib/session.ts` throws at import time if missing
- `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` — edge middleware gate (skipped if either is unset, e.g. local dev; Lighthouse runs with `DISABLE_AUTH=1`)
- `PORTAL_STATUS_POLL` — `on` (default) or `off`. Kill switch for the portal-readiness poll inserted between company and contact creation in `app/api/create/route.ts`; set to `off` to revert to pre-polling behaviour without a code change.

## Architecture

### Two layers of auth

1. **`middleware.ts`** — Edge-runtime HTTP Basic auth wrapping the whole site (matcher excludes `_next/static`, `_next/image`, `favicon.ico`). Skipped when env vars absent.
2. **HubSpot OAuth** — `/api/auth/install` → HubSpot consent → `/api/auth/callback` exchanges code for tokens and stores `{accessToken, refreshToken, expiresAt, portalId, userEmail}` in the iron-session cookie. `/api/auth/me` reports status to the client; `/api/auth/logout` destroys the session.

`proxy.ts` at the repo root is a stale duplicate of the middleware — not wired up. Don't edit it; edit `middleware.ts`.

### Token refresh

All server routes that call HubSpot go through `lib/hubspot-token.ts::getHubSpotToken()`. It reads the session, and if `expiresAt` is within 5 minutes it refreshes via HubSpot's OAuth token endpoint and persists the new tokens. Failure destroys the session and throws `AuthError`, which API routes translate to a 401. Never call HubSpot with a raw `session.accessToken` — always go through this helper.

### Entity creation flow (`app/api/create/route.ts`)

Single POST route orchestrates a sequenced, rolled-back HubSpot CRM transaction:

1. Validate payload — at least one of `partner`/`customer` required; reject mixed `portalRole` + per-entity role payloads; validate `portalRole` against the allowlist `{Admin-RW, User-RW, User-RO}` (default `User-RO`).
2. Idempotency — if header `x-idempotency-key` was seen in the last 30s (in-memory `Set`), return 409. Good enough for a single-instance Vercel deployment; don't replace with anything fancier unless this becomes multi-instance.
3. For each requested side: create company → attach note → create contact (associated to company via `associationTypeId: 1`) → attach note. Push every created ID into `createdIds`.
4. If both partner and customer are present, associate the two companies (`associationTypeId: 13`).
5. On **any** step failure, `rollbackEntities` deletes every `createdIds` entry in reverse order and the error message includes a human-readable summary of what was rolled back. The whole flow is sequential specifically so rollback is deterministic — do not parallelize.

`createNote` uses association type IDs `190` (company↔note) and `202` (contact↔note), hard-coded from HubSpot's HUBSPOT_DEFINED catalogue.

### Client (`app/page.tsx`)

Single large client component. State is local; three `useX` hooks (`useTheme`, `useMode`, `useTranslation`) persist to `localStorage`. The `faker` seed generator uses the logged-in user's email to build `user+tag@domain` test addresses so created contacts go to a real inbox. "Advanced mode" decouples partner/customer creation and per-entity roles; "simple mode" creates both.

### i18n (`lib/i18n.ts` + `locales/{en,de}.json`)

`useTranslation()` hook — detects locale from `localStorage("locale")` → `navigator.language` prefix → `en` fallback. All user-facing strings (including API error messages rendered client-side) must flow through `t(key)`. German translations use `du`-form and gender-inclusive language (e.g. `Partner:in`).

### Theming (`app/globals.css` + `scripts/sync-theme.mjs`)

CSS variables live in `:root` and `.dark` blocks under `@layer base`. Theme tokens are sourced from a [tweakcn](https://tweakcn.com) instance — `npm run sync-theme` (and `prebuild`) fetches CSS/JSON and replaces just the variable blocks, preserving everything else in `globals.css`. Component colors (`tailwind.config.ts`) bind to these `var(--...)` names. **Do not** wrap the `oklch()` values in `hsl()` — that was the v1.0.6 dark-mode bug.

The theme toggle cycles `system → light → dark` by adding/removing `.light`/`.dark` on `<html>`; "system" clears both and the `:root:not(.light)` media query takes over.

## OpenSpec workflow

This repo uses OpenSpec for change proposals. Proposals live in `openspec/changes/<name>/` and get moved to `openspec/changes/archive/` once applied. `openspec/specs/` holds canonical specs. Use the `opsx:*` skills (`/opsx:new`, `/opsx:apply`, `/opsx:archive`, etc.) rather than hand-editing artifacts. The `001-hubspot-entity-creator.md` at the repo root is the originating spec document.

## Deployment

Vercel-native. No `vercel.json`. Push to the connected Git repo → Vercel builds. The `prebuild` hook runs theme sync if `TWEAKCN_URL` is set in Vercel env. Basic-auth and OAuth env vars must all be set in Vercel project settings, and `HUBSPOT_REDIRECT_URI` must match the HubSpot OAuth app's configured redirect exactly.
