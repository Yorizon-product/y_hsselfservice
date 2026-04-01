## Context

The HubSpot Entity Creator (`app/page.tsx`) is a single-page form that creates a partner company + contact and a customer company + contact, associates them, and assigns a shared portal role. The entire flow lives in one `"use client"` component with reusable `Section`, `Input`, and `ThemeToggle` sub-components.

The current API (`POST /api/create`) always expects both partner and customer, applies a single `portalRole` to both contacts, and creates a company-to-company association (typeId 13). Rollback deletes entities in reverse order on failure.

We need to add an Advanced Mode that allows independent entity creation with per-entity roles while keeping the existing Simple Mode as the default.

## Goals / Non-Goals

**Goals:**
- Add a mode toggle that switches between Simple and Advanced mode
- Advanced mode: allow creating partner only, customer only, or both
- Advanced mode: per-entity role assignment (Admin, RW, RO)
- Conditional association creation (only when both entities present)
- Maintain full backward compatibility of Simple mode
- Persist mode choice across page reloads

**Non-Goals:**
- Batch/bulk entity creation
- Duplicate detection or entity search
- Editing or deleting existing entities
- Changing the HubSpot association type (stays typeId 13)
- Refactoring page.tsx into separate component files (do this later)

## Decisions

### 1. Mode Toggle: Segmented Control in the Header

**Decision:** Use a two-segment pill control ("Simple" | "Advanced") placed on its own row below the page subtitle, full-width, above the auth status bar.

**Why not in the header row:** The header already contains the accent dot, version badge, and ThemeToggle. Adding a 44px segmented control would crowd the row on mobile (375px) and cause wrapping. A dedicated row gives it proper prominence and avoids layout issues.

**Why not a toggle switch:** A boolean switch implies on/off — ambiguous about what "on" means. A segmented control makes both modes equally visible and named.

**Why not tabs:** Tabs imply separate pages with separate content. This is the same form with more options surfaced.

**Persist to localStorage** using the same pattern as `useTheme` — the mode is a UI preference, not data. Suppress form render until mode is resolved from localStorage to prevent flash of Simple mode.

**Lock during submission:** Disable the segmented control while `loading === true` to prevent mode switches during in-flight API requests.

**Styling:** `bg-[hsl(var(--muted))]` track, `bg-[hsl(var(--card))]` active segment with `border border-[hsl(var(--border))]` and `shadow-sm`. 44px height. `font-button text-xs uppercase tracking-wide`. Active: `text-[hsl(var(--foreground))]`, inactive: `text-[hsl(var(--muted-foreground))]`.

### 2. Optional Entity Sections: Checkbox-Gated Cards

**Decision:** In Advanced mode, add a checkbox to the left of each Section title (replacing the accent dot). Both default to checked. Unchecking a section dims its content (`opacity-50`, `pointer-events-none`), changes border to `border-dashed`, and hides the Randomize button. The header row stays interactive so users can re-enable.

**Why not collapsible/accordion:** Collapsing hides the section entirely — users may scroll past and submit without realizing an entity was excluded. Dimmed-but-visible preserves spatial awareness.

**Why not removing the section entirely:** Removing causes layout shift and makes it unclear what "Advanced" adds.

**Accessibility for disabled sections:** `pointer-events-none` alone is insufficient — keyboard users can still Tab into inputs, and screen readers still announce them as editable. Disabled sections MUST also set `disabled` and `tabIndex={-1}` on all child inputs, and `aria-disabled="true"` on the section wrapper.

**In Simple mode:** Both checkboxes are checked and hidden — the UI looks exactly like today.

**Data preservation:** Switching modes does not reset field values. Simple mode = "both enabled, shared role." Advanced mode toggles visibility and role granularity, not field state.

### 3. Per-Entity Role Dropdowns: Inside Each Section's Action Slot

**Decision:** In Advanced mode, remove the standalone "Portal Role" Section. Instead, place a compact `<select>` in each entity Section's action slot (next to the existing Randomize button).

**Why inline, not a separate section:** Co-locating the role with its entity eliminates the cognitive overhead of mapping a role back to an entity. The current action slot already accommodates buttons; a select fits naturally.

**Styling:** `h-[44px] px-3 text-xs font-mono rounded-md bg-[hsl(var(--muted))] border border-[hsl(var(--border))]`. Options: "Administrator" / "Read & Write" / "Read Only" (matching existing labels). Default: "Read Only" (least-privilege).

**Mobile layout:** On viewports < 640px, the action slot items (role dropdown + Randomize button) SHALL stack vertically using `flex-wrap` to prevent horizontal overflow.

**In Simple mode:** The shared Portal Role Section remains exactly as-is.

### 4. Association Indicator: Contextual Status Line

**Decision:** Add a status line between the last entity section and the submit button (Advanced mode only). When both entities are enabled: green dot + "Partner-Customer association will be created." When only one is enabled: muted amber dot + "No association — single entity mode."

**Why:** Users may not realize the association is conditionally skipped. A persistent status line matches the existing visual language (green dot in auth bar, success states). The submit button label alone is insufficient — users read buttons last.

### 5. Dynamic Submit Button Labels

| Mode | State | Label |
|------|-------|-------|
| Simple | Always both | Create all entities |
| Advanced | Both enabled | Create partner + customer |
| Advanced | Partner only | Create partner |
| Advanced | Customer only | Create customer |
| Advanced | Neither (edge) | Button disabled |

### 6. API Payload Changes

**Decision:** Make `partner` and `customer` optional in the request body. Add per-entity `portalRole` fields.

**New payload shape (Advanced mode):**
```json
{
  "partner": { ... } | null,
  "customer": { ... } | null,
  "partnerRole": "User-RO",
  "customerRole": "User-RO",
  "portalId": "12345"
}
```

**Simple mode payload:** Unchanged — `partner`, `customer`, `portalRole` (single). The API detects which shape it receives: if `portalRole` (singular) is present, apply to both; if `partnerRole`/`customerRole` are present, apply individually. **Mixed payloads (both shapes) SHALL be rejected with 400.**

**Role allowlist validation:** All role values MUST be validated server-side against `VALID_ROLES = ["Admin-RW", "User-RW", "User-RO"]`. Invalid values return 400. Default when omitted: `"User-RO"` (least-privilege).

**Validation:** At least one of `partner` or `customer` must be provided — explicit guard before any HubSpot API calls. Per-entity validation only runs for entities that are present.

**Association:** Only created when both `partner` and `customer` are provided and successfully created.

**Rollback:** Same reverse-order deletion, but only for entities that were actually created (handles 1-entity and 2-entity cases). Error response SHALL include `rolledBack: string[]` listing entity types deleted, enabling the UI to show clear rollback messaging.

### 7. Validation Fix

**Decision:** The current `isValid` check (line 214) requires all four fields. Refactor to mode-aware validation:
- Simple mode: require partner name + email AND customer name + email (unchanged)
- Advanced mode: require name + email for each enabled entity section

## Risks / Trade-offs

- **[Risk] Mode state not persisted → user loses config on session expiry** → Mitigation: persist mode to `localStorage` alongside theme preference
- **[Risk] Switching modes silently discards data** → Mitigation: mode toggle changes visibility/structure, never resets field values
- **[Risk] "Start over" button calls `handleSignOut` (existing bug)** → Mitigation: in scope to fix — "Start over" should reset the form, not log out. Add a separate "Disconnect" action
- **[Risk] Randomize buttons fire on disabled sections** → Mitigation: hide Randomize when section is unchecked
- **[Risk] Lockfile drift (Codex finding)** → Mitigation: run `npm install` to sync `package-lock.json` before any code changes

## Open Questions

- Should Advanced mode be the default for certain user roles, or always start in Simple?
- Should we track mode usage analytics to understand adoption?
- Should field values persist to localStorage (like mode does) to survive page reloads? Currently mode persists but field data doesn't — acceptable asymmetry but worth documenting.
