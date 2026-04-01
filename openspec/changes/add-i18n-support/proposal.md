## Why

The tool is used by Yorizon team members across Germany and internationally. All UI strings are currently hardcoded in English with no way to translate. Adding i18n support with German as the first translation allows native-language usage and makes the tool accessible to non-English-speaking team members.

## What Changes

- Extract all hardcoded UI strings into a structured JSON translation file
- Default language: EN, first additional language: DE
- Auto-detect browser language (`navigator.language`) to set initial locale
- Allow per-session language switching via a language selector in the UI
- Persist language preference to localStorage
- No external i18n library — lightweight custom hook reading from JSON

## Capabilities

### New Capabilities
- `i18n-translation`: JSON-based translation system with locale detection, session switching, and a `useTranslation` hook that returns typed translation keys
- `language-selector`: UI component for switching language, persisted to localStorage

### Modified Capabilities
- None

## Impact

- **UI** (`app/page.tsx`): All hardcoded strings replaced with `t('key')` calls
- **New files**: `locales/en.json`, `locales/de.json`, `lib/i18n.ts` (hook + types)
- **Components**: Language selector added to header area (next to theme toggle)
- **No API changes** — translations are client-side only
- **No new dependencies** — pure React hook + JSON imports
