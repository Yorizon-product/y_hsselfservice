# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Next.js 16 (App Router) self-service tool that creates test partner/customer entities in HubSpot. It authenticates via HubSpot OAuth, stores tokens in an encrypted iron-session cookie, and proxies CRM calls so the user's token never leaves the server.

**Deployment: self-hosted on `yorizoncasey` as a Docker container behind Caddy at `https://hsselfservice.cdit-dev.de`**, mirroring the y_prmcrm/flows pattern. State lives in a bind-mounted SQLite DB at `/data/hsselfservice.db`. The app used to run on Vercel; the migration is documented in the Phase-1/2/3 commits starting at `918d457`.

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
- `PORTAL_STATUS_POLL_KEEP_ON_FAIL` — optional debug flag. When `1`, poll-failure path skips `rollbackEntities()` so the failed HubSpot records remain for inspection; the error response includes `kept[]` URLs that the client renders under the error message. Leaves orphans — only set during active debugging.

## Architecture

### Two layers of auth

1. **`proxy.ts`** — Edge-runtime HTTP Basic auth wrapping the whole site (matcher excludes `_next/static`, `_next/image`, `favicon.ico`). Skipped when env vars absent. Next.js 16+ uses the `proxy.ts` convention (renamed from `middleware.ts`); both files are not allowed to coexist.
2. **HubSpot OAuth** — `/api/auth/install` → HubSpot consent → `/api/auth/callback` exchanges code for tokens and stores `{accessToken, refreshToken, expiresAt, portalId, userEmail}` in the iron-session cookie. `/api/auth/me` reports status to the client; `/api/auth/logout` destroys the session.

### Token refresh

All server routes that call HubSpot go through `lib/hubspot-token.ts::getHubSpotToken()`. It reads the session, and if `expiresAt` is within 5 minutes it refreshes via HubSpot's OAuth token endpoint and persists the new tokens. Failure destroys the session and throws `AuthError`, which API routes translate to a 401. Never call HubSpot with a raw `session.accessToken` — always go through this helper.

### Entity creation flow (job-based, in-process worker)

Self-hosting means no 300s function cap — the full flow runs inside a single long-lived Node.js process as an in-process worker.

1. **`POST /api/jobs/create`** — client enqueues a job. The route validates, captures the post-refresh HubSpot access token, writes a `pending` row in the `jobs` table, and returns `{ jobId }` immediately. Idempotency via `x-idempotency-key` backed by the `idempotency_keys` table (30s TTL).
2. **In-process worker (`lib/job-runner.ts`)** — started by `instrumentation.ts::register()` when `RUN_WORKER=1`. Loop ticks every 500ms, atomically claims one `pending` job (txn: SELECT → UPDATE to `running`), runs the full flow (partner side → customer side → associate → mark `succeeded`). On any failure: rolls back via `rollbackEntities`, records `kept` list on partial rollback failure, marks `failed`. On boot, marks any leftover `running` jobs as `failed` (process restart reconciliation).
3. **`GET /api/jobs/:id`** — client polls every 2s. Returns `{ status, phase, phase_started_at, created, tracked_ids, error, code, raw_status, kept }`. Scoped to `session.userEmail` so one authenticated user can't peek at another's job.

The **client** (`app/page.tsx handleSubmit`) enqueues the job, then polls `/api/jobs/:id`. On each poll it snaps the local progress clock to the server-reported `phase_started_at` so the UI advances as soon as the server transitions phases (no more elapsed-time estimation race). On terminal `succeeded`, renders `created` entries. On terminal `failed`, surfaces `error` + any `kept` list.

Shared HubSpot primitives live in `lib/hubspot-entities.ts` (`createCompany`, `createContact`, `createNote`, `patchCompanyDomain`, `associateCompanies`, `rollbackEntities`, `hubspotRecordUrl`). Each primitive takes an injected fetch impl for tests and has a 30s AbortController timeout so a hung HubSpot endpoint can't burn the whole worker run. `createNote` uses association type IDs `190` (company↔note) and `202` (contact↔note); contacts associate to their company via `associationTypeId: 1`; parent-company association uses type `13`.

### SQLite state (`lib/db.ts`)

`lib/db.ts::getDb()` opens `$DATA_DIR/hsselfservice.db` (default `./data`, container-time `/data`) with WAL + migrations. Tables:

- `jobs` — `(id, user_email, status ∈ {pending,running,succeeded,failed}, phase, payload_json, created_json, tracked_ids_json, error, raw_status, code, kept_json, created_at, updated_at)`
- `idempotency_keys` — `(key, created_at)`, lazily pruned on each `claimIdempotencyKey(key)` call.
- `schema_migrations` — migration ledger; migrations live inline in `lib/db.ts::MIGRATIONS` and run on first DB open.

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

Self-hosted on `yorizoncasey` alongside y_prmcrm/flows, behind Caddy at `https://hsselfservice.cdit-dev.de`.

**Image**: `.github/workflows/publish.yml` builds + pushes `ghcr.io/yorizon-product/y_hsselfservice:{main,sha-<short>}` on every push to `master` (skipped for openspec/docs-only changes). Multi-stage `Dockerfile`: deps → `next build` → slim Node 22 runtime with Next.js standalone output, non-root user `app` (uid 10001), `/data` volume, `/api/health` healthcheck.

**Compose** (`docker-compose.yml`): single `hsselfservice` container, binds `127.0.0.1:8081`, `env_file: .env` on the host, `./data:/data` bind mount, 512m memory, `RUN_WORKER=1` so the in-process job worker boots.

**Deploy**: `sudo /srv/hsselfservice/scripts/deploy.sh` — git fast-forward + `docker compose pull` + `docker compose up -d --wait`. `--ref <git-sha>` rolls back to that specific GHCR image tag.

**Caddy** (`Caddyfile.snippet`): terminates TLS via ACME, proxies to `127.0.0.1:8081`, adds HSTS + X-Content-Type-Options, writes JSON logs to `/var/log/caddy/hsselfservice.log`.

**Env**: `.env` on host at `/srv/hsselfservice/.env` (0600, owner `hsselfservice:hsselfservice`). Includes the HubSpot OAuth creds, `SESSION_SECRET`, `BASIC_AUTH_*`, `PORTAL_STATUS_POLL*`, and `DATA_DIR=/data`. `HUBSPOT_REDIRECT_URI` must be `https://hsselfservice.cdit-dev.de/api/auth/callback` and match the HubSpot OAuth app's configured redirect exactly.

**State**: SQLite at `/data/hsselfservice.db`. Inspect with `docker compose exec hsselfservice sqlite3 /data/hsselfservice.db`. On process restart the worker marks any `running` jobs as `failed` with a restart message — no partial-resume logic, so any HubSpot records created up to that point may remain and need manual cleanup.
