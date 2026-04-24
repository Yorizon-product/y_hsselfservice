## 1. Notifications helper module

- [ ] 1.1 Create `lib/notifications.ts` exporting `isSupported()`, `getPermission()`, `ensurePermission()`, and `notify({ title, body, tag, onClick })`
- [ ] 1.2 `isSupported()` returns true only when `typeof window !== "undefined"` and `"Notification" in window`
- [ ] 1.3 `ensurePermission()` returns current permission immediately if not `"default"`, otherwise awaits `Notification.requestPermission()`; never throws
- [ ] 1.4 `notify(...)` no-ops when unsupported, when permission is not `"granted"`, or when the tab is visible (`document.visibilityState !== "hidden"`); wraps `new Notification(...)` in try/catch; wires `onclick` to `window.focus()` + `notification.close()`
- [ ] 1.5 Default `tag` to `hsselfservice-create` so repeated dispatches replace in place

## 2. Unit tests for notifications helper

- [ ] 2.1 Add `lib/__tests__/notifications.test.ts` (node:test, native TS) with `.ts` imports per project convention
- [ ] 2.2 Test: `isSupported()` returns false when `Notification` is absent from global
- [ ] 2.3 Test: `notify()` is a no-op when unsupported (no throw, no side effects)
- [ ] 2.4 Test: `notify()` is a no-op when permission is `"denied"`
- [ ] 2.5 Test: `notify()` is a no-op when `document.visibilityState === "visible"`
- [ ] 2.6 Test: `notify()` constructs a `Notification` when granted + hidden, and wires `onclick` correctly
- [ ] 2.7 Test: `ensurePermission()` skips the prompt when permission is already `"granted"` or `"denied"`

## 3. i18n strings

- [ ] 3.1 Add `notify.success.title`, `notify.success.body.partner`, `notify.success.body.customer`, `notify.success.body.both`, `notify.error.title` to `locales/en.json`
- [ ] 3.2 Mirror the same keys in `locales/de.json`, using `du`-form and gender-inclusive wording (`Partner:in`, `Kund:in`)
- [ ] 3.3 Add a matching `TranslationKey` union entry per new key in `lib/i18n.ts` if the type is hand-maintained (verify whether it's inferred first)

## 4. Wire into submit flow (app/page.tsx)

- [ ] 4.1 Import the helper and call `ensurePermission()` inside `handleSubmit` at the top of the try block (non-awaited or fire-and-forget — must not delay the create request)
- [ ] 4.2 On success path (after `setResults(data.created)`), compute the success body key from `doPartner` / `doCustomer` and call `notify({ title, body, onClick: () => window.focus() })`
- [ ] 4.3 On error path (inside the catch), call `notify({ title: notify.error.title, body: <friendly error string without rawStatus and without kept-URLs block> })`
- [ ] 4.4 Ensure the error notification body uses only the localized friendly message — not the rawStatus or kept-URLs blocks that are appended for inline display

## 5. Manual verification

- [ ] 5.1 In Chrome/Firefox, load the app, trigger a create with tab visible — verify no notification fires
- [ ] 5.2 Trigger a create, switch to another tab before it completes — verify a single success (or error) notification fires
- [ ] 5.3 Verify clicking the notification focuses the originating tab and closes the notification
- [ ] 5.4 Deny permission on the first prompt, then trigger another create — verify no re-prompt and no notification, inline UI unchanged
- [ ] 5.5 In Safari (best effort) or with `Notification` shimmed to `undefined`, verify the flow still works end-to-end with inline UI only

## 6. Validate change artifacts

- [ ] 6.1 Run `openspec validate add-creation-notifications --strict` and fix any issues
- [ ] 6.2 Run `npm test` and `npm run build` — no regressions
