## Context

The HubSpot Entity Creator is a single-page client-side React app (`"use client"`) with ~40 user-facing strings across headers, labels, buttons, error messages, status indicators, and placeholders. All strings are currently hardcoded in English in `app/page.tsx`.

## Goals / Non-Goals

**Goals:**
- Extract all UI strings into structured JSON translation files
- Auto-detect browser language, default to EN
- Per-session language switch via UI selector
- Persist language preference to localStorage
- Type-safe translation keys (TypeScript autocompletion)
- Update `<html lang="">` attribute on locale change for screen readers

**Non-Goals:**
- Server-side translation (API error messages stay English — they come from HubSpot)
- RTL language support
- Pluralization rules (not needed for current string set)
- Using next-intl, i18next, or any external i18n library

## Decisions

### 1. No External Library — Custom `useTranslation` Hook

**Decision:** Build a lightweight `useTranslation` hook in `lib/i18n.ts` that imports JSON files and returns a `t(key)` function.

**Why not next-intl or i18next:** The app has ~40 strings, no pluralization, no server components needing translation, and no routing-based locale switching. A custom hook is ~30 lines of code vs adding a dependency. If the app grows significantly, migrating to next-intl is straightforward since the JSON files and key convention stay the same.

**Implementation:**
```ts
// lib/i18n.ts
import en from "@/locales/en.json";
import de from "@/locales/de.json";

type Translations = typeof en;
type Locale = "en" | "de";

const locales: Record<Locale, Translations> = { en, de };

function useTranslation() {
  const [locale, setLocaleState] = useState<Locale | null>(null);
  // ... detect from localStorage, then navigator.language, then "en"
  const t = (key: keyof Translations) => locales[locale][key];
  return { t, locale, setLocale };
}
```

### 2. JSON File Structure — Flat Keys with Logical Prefixes

**Decision:** Use flat keys with dot-notation-style prefixes in a single JSON file per locale. No nested objects — keeps type inference simple and grep-friendly.

**Key naming convention:**
- `header.title`, `header.subtitle.simple`, `header.subtitle.advanced.both`
- `auth.connect`, `auth.disconnect`, `auth.connected`, `auth.expired`
- `partner.title`, `partner.badge`, `partner.randomize`
- `customer.title`, `customer.badge`
- `form.companyName`, `form.domain`, `form.firstName`, `form.lastName`, `form.email`
- `role.admin`, `role.rw`, `role.ro`, `role.label`
- `mode.simple`, `mode.advanced`
- `submit.createAll`, `submit.createPartnerCustomer`, `submit.createPartner`, `submit.createCustomer`, `submit.creating`
- `association.willCreate`, `association.singleEntity`
- `results.success`, `results.startOver`, `results.associationCreated`, `results.associationSkipped`
- `error.*` for friendly error messages
- `hint.advancedMode`, `hint.dismiss`

**Why flat keys:** Nested JSON requires complex TypeScript generics for type-safe dot-path access. Flat keys with string prefixes are simpler, fully type-safe via `keyof`, and easily searchable.

### 3. Locale Detection Priority

**Decision:** `localStorage("locale")` → `navigator.language` prefix match → `"en"` fallback.

**Steps:**
1. Check `localStorage.getItem("locale")` — user's explicit choice
2. If not set, check `navigator.language` (e.g., `"de-DE"` → `"de"`, `"en-US"` → `"en"`)
3. If no match, fall back to `"en"`

Suppress form render until locale is resolved (same pattern as `useMode`) to prevent flash of wrong language.

### 4. Consolidate localStorage Reads

**Decision:** Merge `useTheme`, `useMode`, and `useTranslation` localStorage reads into the same render cycle. All three read synchronously from localStorage in their respective `useEffect` hooks — but triggering three separate re-renders compounds the loading gate. Instead, read all three preferences in the `useTranslation` hook's `useEffect` since locale is the last one added, and gate render on `locale === null` which implicitly waits for all preferences.

### 5. Language Selector — Toggle Button with Swap Icon

**Decision:** Add a language selector button in the header row, next to the ThemeToggle. Shows current locale as a 2-letter uppercase code (EN/DE) with a small swap/arrows icon to indicate interactivity. Clicking toggles to the next locale.

**Why not a plain cycle button:** A text label reading "EN" looks like an informational badge, not a control — especially on mobile with no hover state. Adding a swap icon (↔ or a small arrows SVG) makes it visually read as a button.

**Why not a dropdown:** With only 2 languages, a dropdown adds unnecessary UI weight. If a 3rd language is added, convert to a dropdown at that point.

**Visible before login:** The language selector SHALL be visible even before OAuth login, since the auth section ("Connect to HubSpot", description text) contains translatable strings.

**Styling:** Same as ThemeToggle — `min-h-[44px] min-w-[44px]`, `border border-border`, `text-muted-foreground`, `hover:text-foreground hover:border-accent`.

### 6. Update `<html lang="">` on Locale Change

**Decision:** When the locale changes, update `document.documentElement.lang` to the current locale code. Screen readers depend on this attribute to select the correct pronunciation engine.

### 7. Handle German String Length in Grid Layout

**Decision:** German labels (e.g., "Firmenname", "Vorname", "Nachname") are longer than English equivalents and may cause wrapping in the 3-column contact fields grid at mid-range viewports. Apply `truncate` to form labels and test at 375px–768px to ensure no visual breakage.

### 8. Error Messages — Fully Translated

**Decision:** All `friendlyError()` return strings will be translated. The detection logic (checking for "502", "rate limit", etc.) stays English since it matches against HubSpot API response strings, but the user-facing messages returned by `friendlyError()` will use `t()` keys.

## Risks / Trade-offs

- **[Risk] Flash of wrong language on load** → Mitigation: suppress render until locale resolves from localStorage
- **[Risk] Missing translation key** → Mitigation: TypeScript enforces all keys exist in all locale files at compile time
- **[Risk] German strings break grid layout** → Mitigation: `truncate` on labels, test at mobile widths
- **[Risk] Adding a third language later** → Mitigation: add a new JSON file, add to the `locales` map, convert selector to dropdown

## Open Questions

- None — all reviewer feedback incorporated.
