## Why

The current tool always creates both a partner and a customer as a pair — this is the right default for the common case, but power users need the ability to create entities independently (e.g., onboard just a partner, or just a customer) and assign granular portal roles (RO, RW, Admin) per entity instead of a single shared role. An advanced mode toggle keeps the simple flow as the default while unlocking these capabilities for users who need them.

## What Changes

- Add a **Simple / Advanced mode toggle** at the top of the form UI
- **Simple mode** (default): unchanged — creates partner + customer pair with a single shared portal role, auto-creates the association tag
- **Advanced mode**:
  - User can create a **partner only**, a **customer only**, or **both**
  - Each entity type gets its own **role dropdown** (RO / RW / Admin) instead of a shared role
  - Association tag is **only created when both** partner and customer are present
- Refactor the POST `/api/create` endpoint to accept flexible payloads:
  - Partner-only, customer-only, or both
  - Independent `portalRole` per entity
  - Conditional association step
- Adjust rollback logic to handle partial entity sets
- **BREAKING**: The `portalRole` field in the request body changes from a single string to per-entity role assignments (backward compat maintained in simple mode)

## Capabilities

### New Capabilities
- `advanced-mode-ui`: Toggle between simple and advanced mode; advanced mode shows independent entity sections with per-entity role dropdowns (RO/RW/Admin)
- `flexible-entity-creation`: API support for creating partner-only, customer-only, or both, with independent role assignments and conditional association

### Modified Capabilities
- None (no existing spec files to modify — the current flow is documented in `openspec/001-hubspot-entity-creator.md` but has no formal spec files under `openspec/specs/`)

## Impact

- **UI** (`app/page.tsx`): Major changes — mode toggle, conditional form sections, per-entity role dropdowns
- **API** (`app/api/create/route.ts`): Refactor to support partial payloads, per-entity roles, conditional association step; rollback logic must handle 1-entity and 2-entity cases
- **Types**: `CompanyInput` and request body types need to support optional partner/customer and per-entity `portalRole`
- **Lockfile drift** (from Codex review): `package-lock.json` still references old package name `hubspot-self-service` — must be synced before shipping any changes
- **No new dependencies expected** — toggle and dropdowns use existing shadcn/ui components
