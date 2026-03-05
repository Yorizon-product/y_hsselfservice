# OpenSpec: HubSpot Entity Creator

| Field         | Value                                      |
|---------------|--------------------------------------------|
| **ID**        | HSS-2026-001                               |
| **Status**    | Implemented                                |
| **Owner**     | Casey                                      |
| **Created**   | 2026-03-05                                 |
| **Updated**   | 2026-03-05                                 |

---

## 1. Problem

The production CRM pipeline takes HubSpot entities (companies + contacts) and provisions accounts in an OpenStack environment via a backend service. The HubSpot side requires a specific structure: a partner company linked to a customer company via an association label, each with at least one contact.

Creating these entities by hand in the HubSpot UI is slow, error-prone, and requires navigating multiple screens. Anyone testing the downstream provisioning flow needs to create the same structure repeatedly, and getting any detail wrong (missing `companytype`, wrong association, no contact linked) means the backend silently ignores the input.

A lightweight self-service tool is needed so any team member can create correctly-structured test data in HubSpot without CRM expertise.

---

## 2. Domain Model

```
┌─────────────────────────┐     labeled association      ┌─────────────────────────┐
│   Partner Company       │◄──── (user-selected) ───────►│   Customer Company      │
│   companytype = partner │     company ↔ company         │   companytype = customer│
└──────────┬──────────────┘                               └──────────┬──────────────┘
           │                                                         │
           │ default (typeId: 1)                                     │ default (typeId: 1)
           │ contact → company                                       │ contact → company
           ▼                                                         ▼
┌─────────────────────────┐                               ┌─────────────────────────┐
│   Partner Contact       │                               │   Customer Contact      │
│   firstname, lastname,  │                               │   firstname, lastname,  │
│   email                 │                               │   email                 │
└─────────────────────────┘                               └─────────────────────────┘
```

### Entities

| Entity           | HubSpot Object | Required Properties                          |
|------------------|----------------|----------------------------------------------|
| Partner Company  | `company`      | `name`, `domain` (optional), `companytype`=`partner`  |
| Partner Contact  | `contact`      | `email`, `firstname` (optional), `lastname` (optional) |
| Customer Company | `company`      | `name`, `domain` (optional), `companytype`=`customer` |
| Customer Contact | `contact`      | `email`, `firstname` (optional), `lastname` (optional) |

### Associations

| From             | To               | Type                                | Category        |
|------------------|------------------|-------------------------------------|-----------------|
| Partner Contact  | Partner Company  | Default contact→company (typeId: 1) | HUBSPOT_DEFINED |
| Customer Contact | Customer Company | Default contact→company (typeId: 1) | HUBSPOT_DEFINED |
| Partner Company  | Customer Company | User-selected label                 | USER_DEFINED    |

The company↔company association label varies per HubSpot portal. The tool fetches available labels at runtime and lets the user select.

---

## 3. Constraints & Decisions

### Authentication: user-supplied Private App token

The tool does **not** store credentials. Each user enters their HubSpot Private App token in the form per session. The token is passed from browser to API route to HubSpot and discarded after the request. This means:

- No server-side secrets or env vars required
- Each user's actions are scoped to their own HubSpot permissions
- No OAuth flow, no refresh tokens, no token management
- Trade-off: the user must create and manage their own Private App

**Required HubSpot scopes:**

- `crm.objects.companies.read`
- `crm.objects.companies.write`
- `crm.objects.contacts.read`
- `crm.objects.contacts.write`
- `crm.schemas.companies.read` (for fetching association labels)

### No duplicate detection (v1)

The current implementation does **not** check for existing entities before creation. Submitting the same data twice creates duplicates in HubSpot. This is acceptable for test data generation — the tool is not designed for production CRM management.

Future versions may add search-before-create using the HubSpot search API with domain/email as keys.

### No Terraform layer

Initial scoping explored using Terraform for both infrastructure deployment and HubSpot entity creation. This was dropped because:

1. No Terraform provider exists for HubSpot CRM record creation (existing providers only manage portal users)
2. The `terraform-provider-restapi` approach is a poor fit for multi-step entity creation with intermediate IDs
3. The goal shifted to a Vercel-deployed web app — Terraform adds no value to a `git push` deploy

### Association label is dynamic

The partner↔customer association label is not hardcoded. The tool fetches all company↔company association labels from the portal at runtime via the v4 associations API. This handles portals where the label may be named differently or where multiple custom labels exist.

---

## 4. Architecture

### Overview

```
┌──────────────────┐     POST /api/labels     ┌──────────────────┐
│                  │─────────────────────────►│                  │
│   Browser        │     POST /api/create     │   Next.js API    │
│   (React form)   │─────────────────────────►│   Routes         │
│                  │◄─────────────────────────│                  │
└──────────────────┘     JSON response        └───────┬──────────┘
                                                      │
                                                      │ HubSpot REST API
                                                      │ (CRM v3 + v4)
                                                      ▼
                                              ┌──────────────────┐
                                              │   HubSpot        │
                                              │   CRM            │
                                              └──────────────────┘
```

### Stack

| Component        | Technology       | Rationale                                       |
|------------------|------------------|-------------------------------------------------|
| Frontend         | Next.js + React  | Single project, Vercel zero-config deploy        |
| Styling          | Tailwind CSS     | Utility classes, no build complexity             |
| Backend          | Next.js API routes | Co-located with frontend, serverless on Vercel  |
| HubSpot client   | Plain `fetch`    | No SDK dependency for 5 API calls               |
| Hosting          | Vercel           | Free tier, git push deploy, edge functions       |

### Target Stack (OpenStack MVP and beyond)

All internal tools — including this one — should converge on a shared frontend stack to reduce context-switching and enable component reuse across the wider OpenStack MVP platform.

| Layer            | Choice           | Notes                                            |
|------------------|------------------|--------------------------------------------------|
| Framework        | React (Next.js)  | SSR/SSG flexibility, API routes co-located       |
| Component library| shadcn/ui        | Composable, unstyled primitives; no vendor lock-in |
| Styling          | Tailwind CSS     | Utility-first, pairs natively with shadcn        |
| Design tokens    | Yorizon token system | See §4a below                                |

shadcn/ui components should be adopted incrementally — the current v1 uses raw Tailwind, but all new UI work should prefer shadcn primitives (Button, Input, Select, Card, Alert, etc.) styled via the Yorizon token system.

---

## 4a. Design Token System (Yorizon)

All internal and partner-facing tools inherit their visual identity from the Yorizon brand. The tokens below are extracted from `yorizon.com` production CSS and should be treated as the single source of truth for the shared frontend stack.

### Color Tokens

| Token                  | Value      | Usage                                         |
|------------------------|------------|-----------------------------------------------|
| `--color-primary`      | `#3e4227`  | Primary brand — dark olive. Body bg, nav bg, text on light surfaces |
| `--color-secondary`    | `#defe19`  | Accent — electric lime. CTAs, highlights, active states, table headers, footer bg |
| `--color-third`        | `#797979`  | Muted grey. Secondary text, disabled states, dropdown bg |
| `--color-accent-pink`  | `#bd1074`  | Accent pink. Sparingly used for contrast highlights |
| `--color-surface-light`| `#E3EDEC`  | Light surface. Cards, section backgrounds on light pages |
| `--color-section-bg`   | `#f2f2f2`  | Neutral section background                    |
| `--color-black`        | `#000000`  | Body text, headings (h2-h6)                   |
| `--color-white`        | `#ffffff`  | Nav links, text on dark surfaces, primary button bg |
| `--color-nav-hover`    | `#eef0e5`  | Soft olive tint for nav hover states           |

### Typography Tokens

| Token                  | Font             | Weights      | Usage                              |
|------------------------|------------------|--------------|------------------------------------|
| `--font-display`       | Expletus Sans    | 500, 600, 700| h1, h2, h3 headings. Distinctive geometric display face |
| `--font-body`          | Lato             | 300, 400, 700| Body copy, paragraphs, anchors. Clean humanist sans |
| `--font-ui`            | Inter            | 400, 500, 700| Buttons, form labels, UI chrome. Neutral and legible at small sizes |

**Type scale (from Yorizon CSS):**

| Element | Font           | Size  | Weight | Color             |
|---------|----------------|-------|--------|-------------------|
| h1      | Expletus Sans  | 70px  | 400    | `--color-primary` |
| h2      | Expletus Sans  | 48px  | 500    | `#000`            |
| h3      | Expletus Sans  | —     | —      | `#000`            |
| body    | Lato           | 16px  | 400    | `#000`            |
| anchor  | Lato           | 12px  | —      | `#000`            |
| button  | Inter          | 15px  | 500    | varies            |

### Button Tokens

| Token                          | Value      | Notes                                    |
|--------------------------------|------------|------------------------------------------|
| `--button-radius`              | `30px`     | Pill-shaped. Consistent across all buttons |
| `--button-primary-bg`          | `#ffffff`  | White bg                                  |
| `--button-primary-text`        | `#3e4227`  | Primary olive text                        |
| `--button-primary-hover-bg`    | `#ffffff`  | Stays white                               |
| `--button-primary-hover-border`| `#3e4227`  | Olive border appears on hover             |
| `--button-secondary-bg`        | `#defe19`  | Lime bg                                   |
| `--button-secondary-text`      | `#163020`  | Dark green text                           |
| `--button-secondary-hover-bg`  | `#163020`  | Inverts to dark bg                        |
| `--button-secondary-hover-text`| `#defe19`  | Inverts to lime text                      |
| `--button-padding-x`           | `20–30px`  | Primary: 20px, Secondary: 30px           |
| `--button-padding-y`           | `8–12px`   | Primary: 12px, Secondary: 8px            |

### Applying to shadcn/ui

The Yorizon tokens map to shadcn's theming layer via Tailwind CSS variables in `globals.css`:

```css
@layer base {
  :root {
    --background: 78 12% 15%;       /* #3e4227 as HSL */
    --foreground: 0 0% 100%;        /* white on dark */
    --primary: 72 97% 55%;          /* #defe19 */
    --primary-foreground: 150 35% 14%; /* #163020 */
    --muted: 0 0% 47%;              /* #797979 */
    --accent: 326 85% 35%;          /* #bd1074 */
    --card: 170 17% 90%;            /* #E3EDEC */
    --radius: 1.875rem;             /* 30px pill */
  }
}
```

This ensures `<Button variant="default">` renders in Yorizon lime, `<Card>` uses the light surface, and all radii are pill-shaped — without per-component overrides.

### API Routes

#### `POST /api/labels`

Fetches company↔company association labels and portal ID.

**Request:**
```json
{ "token": "pat-na1-..." }
```

**Response:**
```json
{
  "labels": [
    { "typeId": 13, "label": "is_client_of", "category": "USER_DEFINED" }
  ],
  "portalId": "12345678"
}
```

**HubSpot endpoints used:**
- `GET /crm/v4/associations/companies/companies/labels`
- `GET /account-info/v3/details`

#### `POST /api/create`

Creates all entities and associations in sequence.

**Request:**
```json
{
  "token": "pat-na1-...",
  "partner": {
    "name": "Acme Corp",
    "domain": "acme.com",
    "contact": { "firstname": "Jane", "lastname": "Doe", "email": "jane@acme.com" }
  },
  "customer": {
    "name": "Widget Inc",
    "domain": "widget.io",
    "contact": { "firstname": "John", "lastname": "Smith", "email": "john@widget.io" }
  },
  "associationLabelId": 13,
  "portalId": "12345678"
}
```

**Response:**
```json
{
  "created": [
    { "type": "Partner Company",  "id": "123", "name": "Acme Corp",           "url": "https://app.hubspot.com/contacts/12345678/company/123" },
    { "type": "Partner Contact",  "id": "456", "name": "Jane Doe",            "url": "https://app.hubspot.com/contacts/12345678/contact/456" },
    { "type": "Customer Company", "id": "789", "name": "Widget Inc",          "url": "https://app.hubspot.com/contacts/12345678/company/789" },
    { "type": "Customer Contact", "id": "012", "name": "John Smith",          "url": "https://app.hubspot.com/contacts/12345678/contact/012" },
    { "type": "Association",      "id": "123↔789", "name": "Acme Corp ↔ Widget Inc", "url": "..." }
  ]
}
```

**Creation sequence:**

1. Create partner company → get `partnerCompanyId`
2. Create partner contact with inline association to `partnerCompanyId`
3. Create customer company → get `customerCompanyId`
4. Create customer contact with inline association to `customerCompanyId`
5. Create labeled association: `partnerCompanyId` ↔ `customerCompanyId`

All steps are sequential. If any step fails, the request returns an error. Previously created entities from the same request are **not** rolled back (acceptable for test data).

**HubSpot endpoints used:**
- `POST /crm/v3/objects/companies` (×2)
- `POST /crm/v3/objects/contacts` (×2, with inline associations)
- `POST /crm/v4/objects/companies/{id}/associations/companies/{id}` (×1)

---

## 5. File Structure

```
hubspot-self-service/
├── app/
│   ├── layout.tsx              # Root layout, metadata, font imports
│   ├── globals.css             # Tailwind directives, CSS variables, animations
│   ├── page.tsx                # Main form UI (token entry, partner/customer fields, results)
│   └── api/
│       ├── labels/
│       │   └── route.ts        # Fetch association labels + portal ID
│       └── create/
│           └── route.ts        # Create all entities + associations
├── openspec/
│   └── 001-hubspot-entity-creator.md
├── package.json
├── next.config.js
├── tsconfig.json
├── tailwind.config.ts
├── postcss.config.js
├── .gitignore
└── README.md
```

---

## 6. UI Flow

1. **Token entry** — user pastes their HubSpot Private App token. On submit, the app calls `/api/labels` to validate the token and fetch association labels.
2. **Token confirmed** — green indicator shows truncated token and portal ID. Association label dropdown is populated.
3. **Fill form** — two sections: Partner (company name, domain, contact first/last/email) and Customer (same fields). User selects association label from dropdown.
4. **Submit** — "Create all entities" button calls `/api/create`. Loading state shown.
5. **Results** — list of created entities with HubSpot record links (clickable, open in new tab).
6. **Error** — any HubSpot API error is surfaced verbatim in the UI.

---

## 7. Acceptance Criteria

- [ ] Entering a valid HubSpot token shows association labels and portal ID
- [ ] Entering an invalid token shows a clear error
- [ ] Submitting the form creates a partner company with `companytype=partner`
- [ ] Submitting the form creates a customer company with `companytype=customer`
- [ ] Each contact is associated to its respective company
- [ ] The partner↔customer company association is created with the selected label
- [ ] Created entity IDs and HubSpot record URLs are displayed after successful creation
- [ ] HubSpot API errors are surfaced to the user
- [ ] The token is never persisted (no cookies, localStorage, env vars, or database)
- [ ] The app deploys to Vercel with zero configuration

---

## 8. Future Considerations

| Item | Priority | Notes |
|------|----------|-------|
| HubSpot OAuth App | High | See §9 for full effort analysis. Removes need for users to create Private Apps. |
| Yorizon design token migration | High | Migrate current raw-Tailwind UI to shadcn/ui + Yorizon token system (§4a). |
| Duplicate detection | Medium | Search by domain/email before creating. Requires `crm.objects.*.read` scopes. |
| Multiple clients per partner | Medium | Currently 1:1. The domain model supports 1:N but the UI doesn't yet. |
| Batch mode | Low | Paste JSON/YAML to create multiple partner→customer sets in one go. |
| Teardown / cleanup | Low | Delete entities by ID or by creation session. |
| Rollback on partial failure | Low | If step 3 fails, steps 1-2 already created entities. Could queue and rollback. |
| Self-hosted alternative | Low | Docker image + Coolify for teams that can't use Vercel. |

---

## 9. HubSpot OAuth App: Effort Analysis

### Current state (Private App token)

Users must manually create a HubSpot Private App, configure scopes, copy the token, and paste it into the tool. This is acceptable for internal/power-user use but creates friction for broader adoption.

### What a HubSpot App (OAuth) would give us

Instead of pasting a token, users click "Connect to HubSpot" → authorize via HubSpot's OAuth consent screen → done. The tool receives a scoped access token automatically. This is how all HubSpot marketplace integrations work.

### Two flavors: unlisted vs. marketplace-listed

| Aspect | Unlisted Public App | Marketplace-Listed App |
|--------|--------------------|-----------------------|
| Auth flow | OAuth 2.0 (authorization code grant) | Same |
| Who can install | Anyone with the install URL (up to 25 without verification) | Anyone via HubSpot Marketplace |
| Review required | No (but shows "unverified" warning) | Yes — HubSpot Ecosystem Quality team, ~10 business days |
| Minimum installs | None | 3 active unique installs required before submission |
| Webhooks required | No | Yes (privacy-compliant contact deletion) |
| Listing assets | None | Logo, screenshots, description, pricing, ToS, privacy policy, support URL |

**Recommendation:** Start with an **unlisted public app**. It gives you OAuth without the marketplace overhead. You can list later if needed.

### What changes in the codebase

| Component | Current (PAT) | OAuth version | Effort |
|-----------|--------------|---------------|--------|
| Auth flow | User pastes token in form | "Connect to HubSpot" button → OAuth redirect → callback stores token in session | **Medium** — new `/api/auth/hubspot` and `/api/auth/callback` routes |
| Token storage | None (stateless) | Server-side session or encrypted cookie holding access + refresh tokens | **Small** — Vercel supports encrypted cookies or you add a KV store |
| Token refresh | N/A (PATs don't expire) | Access tokens expire after ~30min; refresh token used to renew | **Small** — middleware that checks expiry and calls `/oauth/v1/token` |
| HubSpot Developer Account | Not needed | Required — create app in developer portal, get `client_id` + `client_secret` | **Trivial** — one-time setup |
| Environment variables | None | `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `HUBSPOT_REDIRECT_URI` | **Trivial** — Vercel env vars |
| API calls | Identical | Identical (both use Bearer token) | **None** |
| UI | Token input field | "Connect to HubSpot" button + connection status indicator | **Small** |

### New routes required

```
GET  /api/auth/hubspot   → Redirects to HubSpot OAuth consent URL
GET  /api/auth/callback   → Receives auth code, exchanges for access + refresh tokens
POST /api/auth/refresh    → Exchanges refresh token for new access token
GET  /api/auth/status     → Returns current connection status (connected/expired/none)
```

### Estimated effort

| Task | Time |
|------|------|
| Create HubSpot Developer Account + register public app | 1 hour |
| Implement OAuth flow (redirect, callback, token exchange) | 3–4 hours |
| Token storage (Vercel KV or encrypted cookie) | 1–2 hours |
| Token refresh middleware | 1 hour |
| UI updates (replace token input with connect button) | 1–2 hours |
| Testing across portals | 2 hours |
| **Total** | **~1–1.5 days** |

### Key consideration: state

The current tool is **fully stateless** — no database, no sessions, nothing persists. OAuth introduces state (tokens must survive across requests). Options:

1. **Encrypted HTTP-only cookie** — simplest. Token lives in the browser cookie, encrypted server-side. No database. Works on Vercel. Tokens lost when cookie expires or user clears cookies.
2. **Vercel KV (Redis)** — session ID in cookie, tokens in KV. More robust. Vercel KV has a free tier (3,000 requests/day). Needed if you want multi-device sessions or admin token management.
3. **Database (Postgres/Planetscale)** — overkill for this tool unless it grows into a full admin panel.

**Recommendation for v2:** Encrypted cookie. Keeps deployment simple (zero external deps), and you can upgrade to KV later if needed.

### HubSpot OAuth v3

As of January 2026, HubSpot released OAuth v3 API endpoints with enhanced security. The v1 endpoints still work but are deprecated. Any new OAuth implementation should target v3 directly.
