## Context

`app/page.tsx` owns the entire submit lifecycle for partner/customer creation. On submit it starts a ~60–130s wait driven by `lib/portal-status.ts`'s polling windows, renders a `<ProgressIndicator>` while the `/api/create` request is in flight, and on resolve/reject writes to `setResults` / `setError`. There is no other success/failure surface — if the user minimizes the window or flips to another tab they miss the terminal state.

We have no service worker, no push infrastructure, and no desire to add either. The app is a single-instance Vercel deployment talking to HubSpot on the user's behalf; feedback is 100% client-rendered. Browsers expose `Notification` (the Web Notifications API) which works in-page without any server setup — permission-gated, but the tab only needs to be *open*, not focused. That's precisely the "nice user feedback so they don't have to keep the tab open … in focus" that we want.

i18n already wraps all user-facing strings through `useTranslation()` / `locales/{en,de}.json` (DE uses `du`-form). Any new copy must flow through that.

## Goals / Non-Goals

**Goals:**
- On terminal states of the create flow (success / error), show a browser notification that brings the user back when the tab isn't focused.
- Only ask for notification permission when it's clearly relevant (at first submit), never on page load.
- Never double-ping: if the tab is already focused, the inline UI is sufficient and we don't fire.
- Degrade silently on unsupported browsers or denied permission — zero user-visible errors, inline UI unchanged.
- Keep i18n-correct (EN + DE, `du`-form).

**Non-Goals:**
- Push API / service workers / background notifications when the tab is closed.
- Sound, badges, actions, images, or a settings UI for notification preferences.
- Persisting user choice in `localStorage` — the browser's own permission store is the source of truth.
- Notifying on intermediate progress stages — only terminal success / error.
- iOS Safari parity — it has partial support; we treat it as "unsupported" via the same feature-detection path.

## Decisions

### 1. Web Notifications API (in-page), not Push API
**Decision:** Use `new Notification(title, options)` directly in the client. **Alternatives considered:** Push API with a service worker (rejected — requires SW registration, VAPID keys, a push service subscription, and still needs the browser open; adds complexity with no win for our single-tab flow).
**Why:** The user flow is always rooted in the tab they pressed submit in. Web Notifications work as long as the tab is alive, which is exactly our requirement. No server-side plumbing.

### 2. Permission request on first submit, not on page load
**Decision:** Call `Notification.requestPermission()` inside `handleSubmit`, the first time we actually need it, and only if `permission === "default"`. **Alternatives considered:** Prompt on login (rejected — unsolicited permission prompts are the #1 reason users click "Block" and hurt future prompts forever; also considered a one-time "Enable notifications?" banner, rejected for this iteration to keep scope tight — can be added later without a spec change).
**Why:** Browsers heavily penalize apps that ask without context. Asking at submit time ties the prompt to an explicit user action the user understands ("I just kicked off a long task").

### 3. Gate dispatch on `document.visibilityState === "hidden"`
**Decision:** Only fire when the tab is hidden at the terminal moment. If the user is watching, rely entirely on the inline UI. **Alternatives considered:** Always fire (rejected — duplicate feedback is noisy); use `document.hasFocus()` (rejected — "visible but unfocused" still means the user can see the inline UI well enough; `visibilityState` is the cleaner line).
**Why:** Notifications should pull attention back *to* the tab — if the user is already there, don't bother.

### 4. Extract to `lib/notifications.ts`, not inline in `app/page.tsx`
**Decision:** A small module with `isSupported()`, `ensurePermission()`, `notify({ title, body, tag, onClick })`. `app/page.tsx` calls it from the submit resolve/catch paths. **Alternatives considered:** Keep it inline (rejected — `page.tsx` is already large and the logic deserves unit tests that don't need to mount the whole page).
**Why:** Clean boundary for testing (matches existing `lib/**/__tests__` pattern using node's native test runner). Keeps `page.tsx` focused on layout/state.

### 5. `tag` per submit, so repeated submits replace rather than stack
**Decision:** Pass `tag: "hsselfservice-create"` on every notification. Browsers replace an existing notification with the same tag.
**Why:** If a user fires two creates in sequence and the first notification is still lingering, the second should replace it — not produce a pair.

### 6. On click, `window.focus()` and close the notification
**Decision:** Register `onclick` that calls `window.focus()` then `notification.close()`.
**Why:** Pulling the tab back to the foreground is the whole point.

### 7. No permission-state persistence in `localStorage`
**Decision:** Don't track "asked before" or "dismissed" ourselves. Read `Notification.permission` each time; if `default`, ask; if `granted`, fire; if `denied`, no-op.
**Why:** Browser's permission store already survives reloads and sessions. Adding a parallel `localStorage` flag would just introduce drift between the two.

### 8. i18n keys namespaced under `notify.*`
**Decision:** Add `notify.success.title`, `notify.success.body.partner`, `notify.success.body.customer`, `notify.success.body.both`, `notify.error.title`, `notify.error.body` (uses `{message}` substitution for the friendly error) to EN + DE.
**Why:** Keeps the existing `t(key, vars)` contract. DE strings use `du`-form per project convention.

## Risks / Trade-offs

- **[iOS Safari partial support]** → Feature-detect (`'Notification' in window` plus a `permission` check). Fail silently; inline UI remains the guaranteed path.
- **[User blocks permission on first prompt]** → Once `permission === "denied"`, the browser never shows the prompt again without user intervention in browser settings. We accept this: the submit still works, inline UI is unchanged, no retry prompts.
- **[Tab flips from hidden to visible right as the notification would fire]** → Minor race: we re-check `visibilityState` at dispatch time. If the user returns mid-request, they'll see the inline UI and no notification; if they return after dispatch, they'll see both. Both are acceptable.
- **[Repeated submits spamming notifications]** → Mitigated by `tag` (replaces in-place) and by the existing 10s cooldown on errors in `handleSubmit`.
- **[Notification text leaking sensitive info]** → Success body will list entity types + names the user just submitted (which they already see inline); no portal IDs, no tokens. Error body is the friendly localized message (never raw HubSpot responses).
- **[Basic-auth screen never reaches submit]** → Not a risk: the permission ask lives inside `handleSubmit`, which is only reachable past basic auth and past OAuth login.

## Migration Plan

- Additive change; no schema, no migrations, no env vars.
- Ship behind no flag — the entire path no-ops if `Notification` isn't supported or permission is `default`/`denied`.
- Rollback: revert the commit. No data to clean up, no user state to unwind.

## Open Questions

- None required for the first cut. A follow-up could add a subtle "Enable notifications" toggle in the UI once we see real usage, but that's deferred.
