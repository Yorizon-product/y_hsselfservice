## Why

The partner+customer creation flow takes 60–130 seconds end-to-end (two 60s provisioning windows plus the surrounding CRM calls). Today the only success/failure signal is the inline banner in `app/page.tsx` — so if the user tab-switches away during the wait, they have no idea when the flow finishes or whether it errored. They have to keep the tab focused or keep checking back, which is the whole point of a long-running task people shouldn't have to babysit.

We want to surface the terminal outcome (success or error) as a browser notification so the user can switch tabs freely and get pulled back when it matters, while keeping the existing inline UI as the primary feedback channel.

## What Changes

- Add an opt-in browser-notification layer on top of the existing inline progress/error/results UI for the `/api/create` flow.
- Request `Notification.permission` only when the user first submits a create (lazy, never on page load) and only when the API is available.
- Fire a notification on terminal states:
  - **Success** — summary of what was created (partner / customer / both), click focuses the tab.
  - **Error** — the same friendly error string currently shown inline, click focuses the tab.
- Gate firing on tab visibility: only show a notification when `document.visibilityState === "hidden"` (or the tab has lost focus). If the user is actively watching, the inline UI is enough — no duplicate pings.
- Degrade silently when: the API is unsupported, permission is denied, or the user dismissed the permission prompt. Inline UI remains authoritative.
- Add localized notification strings (EN + DE) to `locales/{en,de}.json`.
- Remember the permission state across sessions via the browser's own permission store (no extra `localStorage` bookkeeping); suppress re-asking if `Notification.permission === "denied"`.

Non-goals (explicit):
- No Push API / service worker / background notifications — this is purely in-page Web Notifications, which means the tab must still be open (just not focused). That is the "graceful" scope the user asked for.
- No sound, no badges, no notification preferences UI.

## Capabilities

### New Capabilities
- `creation-notifications`: Browser-notification feedback for the `/api/create` flow — permission request, tab-visibility gating, success + error dispatch, and graceful degradation.

### Modified Capabilities
_(none — no existing spec files under `openspec/specs/` yet.)_

## Impact

- **Code**
  - `app/page.tsx` — submit handler fires notifications on resolve/reject; wire a small hook for permission + dispatch.
  - New `lib/notifications.ts` (or equivalent) — thin wrapper around `Notification` with support/permission/visibility checks, so the UI file stays focused on rendering.
  - `locales/en.json`, `locales/de.json` — new `notify.*` keys.
- **APIs / deps** — zero new dependencies. Uses the platform `Notification` API.
- **Privacy / security** — notifications stay client-side; nothing leaves the browser. No new telemetry, no new server routes.
- **Browser support** — modern evergreen browsers support `Notification` with the permission flow we need. iOS Safari has spotty support, so the degrade-silently path is the fallback there.
- **Tests** — add unit tests for the notifications helper (support detection, visibility gating, no-op when denied).
