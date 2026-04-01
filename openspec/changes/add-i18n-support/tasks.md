## 1. Translation Files

- [x] 1.1 Create `locales/en.json` with all UI strings extracted from `app/page.tsx` using flat keys with logical prefixes
- [x] 1.2 Create `locales/de.json` with German translations for all keys
- [x] 1.3 Verify both files have identical key sets

## 2. Translation Hook

- [x] 2.1 Create `lib/i18n.ts` with `useTranslation` hook: imports both locale files, returns `{ t, locale, setLocale }`
- [x] 2.2 Type `t()` function so only valid keys from `en.json` are accepted (compile-time safety)
- [x] 2.3 Implement locale detection: localStorage → navigator.language prefix → "en" fallback
- [x] 2.4 Persist locale to localStorage on change
- [x] 2.5 Update `document.documentElement.lang` on locale change
- [x] 2.6 Return `null` locale until resolved (suppress render)

## 3. Language Selector Component

- [x] 3.1 Create `LanguageSelector` component: 44x44px button showing "EN"/"DE" with swap icon (↔), toggles on click
- [x] 3.2 Style matching ThemeToggle: `border border-border`, `text-muted-foreground`, `hover:text-foreground hover:border-accent`
- [x] 3.3 Add `aria-label` (e.g., "Language: English. Click to switch.")
- [x] 3.4 Place in header row next to ThemeToggle — visible before AND after login

## 4. Replace All Hardcoded Strings

- [x] 4.1 Wire `useTranslation` hook into `Home` component
- [x] 4.2 Replace header strings: title, subtitle variations
- [x] 4.3 Replace auth strings: connect button, disconnect, connected status
- [x] 4.4 Replace entity section strings: titles, badges, Randomize
- [x] 4.5 Replace form label strings: Company name, Domain, First name, Last name, Email
- [x] 4.6 Replace role strings: Administrator, Read & Write, Read Only, label
- [x] 4.7 Replace mode toggle labels: Simple, Advanced
- [x] 4.8 Replace submit button labels: all variations
- [x] 4.9 Replace association status strings
- [x] 4.10 Replace all friendlyError() return strings with t() calls
- [x] 4.11 Replace results strings: success, start over, association status
- [x] 4.12 Replace hint text and dismiss
- [x] 4.13 Replace retry countdown text
- [x] 4.14 Update ThemeToggle and LanguageSelector aria-labels

## 5. Layout Fixes for German Strings

- [x] 5.1 Add `truncate` to form labels to handle longer German strings in 3-column grid
- [ ] 5.2 Test label rendering at 375px–768px viewports

## 6. Suppress Flash of Wrong Language

- [x] 6.1 Add `locale === null` check to the loading gate (alongside `authLoading` and `mode === null`)

## 7. Testing

- [ ] 7.1 Verify EN renders correctly (all strings present)
- [ ] 7.2 Verify DE renders correctly (all strings translated, no English leaking)
- [ ] 7.3 Verify browser language detection works
- [ ] 7.4 Verify localStorage persistence
- [ ] 7.5 Verify `<html lang="">` updates on locale change
- [ ] 7.6 Verify no flash of wrong language on load
- [ ] 7.7 Verify language selector visible before login
- [ ] 7.8 Push to staging, verify Vercel preview
