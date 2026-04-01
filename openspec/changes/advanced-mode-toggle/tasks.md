## 1. Prep & Lockfile Fix

- [x] 1.1 Run `npm install` to sync `package-lock.json` with the renamed package (`y_hsselfservice`)
- [x] 1.2 Verify `npm ci` succeeds with the updated lockfile

## 2. UI Components

- [x] 2.1 Create `SegmentedControl` component (two-segment pill: "Simple" | "Advanced", 44px height, existing design tokens)
- [x] 2.2 Add `useMode` hook with localStorage persistence (same pattern as `useTheme`); suppress form render until mode is resolved to prevent flash of wrong mode
- [x] 2.3 Place segmented control on its own row below page subtitle, full-width, above auth status bar (not in header row — too crowded on mobile)
- [x] 2.4 Disable segmented control while `loading === true` (prevent mode switch during in-flight submission)
- [x] 2.5 Add `transition-opacity duration-200` and `transition-[border-style] duration-200` for smooth mode transitions

## 3. Checkbox-Gated Entity Sections

- [x] 3.1 Add `enabled` checkbox to `Section` component header (left of title, replaces accent dot in Advanced mode)
- [x] 3.2 Implement dimmed state for unchecked sections: `opacity-50`, `pointer-events-none`, `border-dashed`, hide Randomize button
- [x] 3.3 Add `disabled` attribute and `tabIndex={-1}` to all inputs inside unchecked sections; add `aria-disabled="true"` to section wrapper (keyboard/screen reader accessibility)
- [x] 3.4 Hide checkboxes in Simple mode (both always enabled)
- [x] 3.5 Ensure field values are preserved when toggling checkboxes and switching modes

## 4. Per-Entity Role Dropdowns

- [x] 4.1 Add `partnerRole` and `customerRole` state variables (default: "User-RO" — least-privilege default)
- [x] 4.2 Add compact role `<select>` to each entity Section's action slot (next to Randomize) in Advanced mode
- [x] 4.3 On mobile (< 640px), stack action slot items vertically (`flex-wrap`) to prevent overflow
- [x] 4.4 Hide individual role dropdowns and show shared Portal Role section in Simple mode

## 5. Association Status Indicator

- [x] 5.1 Create association status line component (green dot + text when both enabled, amber dot + text when single entity)
- [x] 5.2 Render between entity sections and submit button in Advanced mode only

## 6. Dynamic Subtitle, Submit Button & Validation

- [x] 6.1 Make page subtitle dynamic: update text based on mode and entity selection
- [x] 6.2 Update submit button label to reflect current entity selection (partner + customer / partner only / customer only)
- [x] 6.3 Refactor `isValid` check to be mode-aware: only require fields for enabled entity sections
- [x] 6.4 Disable submit button when neither entity is checked

## 7. Discoverability

- [x] 7.1 Add first-visit hint near submit button: "Need to create just one entity? Try Advanced mode."
- [x] 7.2 Persist hint dismissal to localStorage; hide after first mode switch or explicit dismiss

## 8. API Security: Role Validation

- [x] 8.1 Add `VALID_ROLES` allowlist (`Admin-RW`, `User-RW`, `User-RO`) with server-side validation; return 400 on invalid role
- [x] 8.2 Reject mixed payloads that send both `portalRole` (singular) AND `partnerRole`/`customerRole` with 400
- [x] 8.3 Default to `User-RO` when no role is provided (least-privilege)

## 9. API Refactor

- [x] 9.1 Add explicit guard: return 400 if neither `partner` nor `customer` is provided (before any HubSpot calls)
- [x] 9.2 Make `partner` and `customer` optional in request body types and validation
- [x] 9.3 Add `partnerRole` and `customerRole` fields; detect per-entity vs shared `portalRole` and apply accordingly
- [x] 9.4 Conditionally skip partner or customer creation steps when null
- [x] 9.5 Only create company-to-company association when both entities are present
- [x] 9.6 Update rollback logic to only delete entities actually created during the request

## 10. Rollback Error Response

- [x] 10.1 Add `rolledBack` array to error response listing entity types that were created and then deleted
- [x] 10.2 Include human-readable rollback summary in error message

## 11. Results Display

- [x] 11.1 Group results by entity type (Partner / Customer) with section headers
- [x] 11.2 Add explicit association status row in results (created / not created — single entity mode)
- [x] 11.3 Display rollback error with `rolledBack` details: "X was created but then removed — nothing was saved. You can retry safely."

## 12. Audit & Logging

- [x] 12.1 Update audit log to reflect operation type (partner-only, customer-only, both) and per-entity roles

## 13. Bug Fix: "Start Over" Button

- [x] 13.1 Change post-success "Start over" button to reset form state (field values, checkboxes re-checked, roles to defaults) instead of calling `handleSignOut`
- [x] 13.2 Preserve mode preference (Simple/Advanced) on "Start over"
- [x] 13.3 Keep "Disconnect" as a separate action in the auth status bar

## 14. Testing & Deploy

- [ ] 14.1 Manual test: Simple mode unchanged behavior (both entities, shared role, association)
- [ ] 14.2 Manual test: Advanced mode — partner only with role, verify no association created
- [ ] 14.3 Manual test: Advanced mode — customer only with role
- [ ] 14.4 Manual test: Advanced mode — both entities with different roles, verify association created
- [ ] 14.5 Manual test: Mode toggle preserves field values and persists to localStorage
- [ ] 14.6 Manual test: Rollback works for partial entity failures, error shows rolled-back entities
- [ ] 14.7 Manual test: Invalid role via direct API call returns 400
- [ ] 14.8 Manual test: Mixed role fields via direct API call returns 400
- [ ] 14.9 Manual test: Keyboard navigation — Tab skips disabled section inputs, screen reader announces disabled state
- [ ] 14.10 Manual test: Mobile layout — segmented control, action slot stacking, no overflow at 375px
- [ ] 14.11 Manual test: No flash of wrong mode on page load
- [ ] 14.12 Manual test: Mode toggle locked during in-flight submission
- [ ] 14.13 Manual test: First-visit hint shows and dismisses correctly
- [ ] 14.14 Push to `staging` branch, verify Vercel preview deployment
