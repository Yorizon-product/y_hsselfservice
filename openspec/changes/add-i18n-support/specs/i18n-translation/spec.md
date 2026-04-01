## ADDED Requirements

### Requirement: Translation JSON files
The system SHALL provide one JSON file per supported locale at `locales/<locale>.json`. Each file MUST contain identical keys. The English file (`en.json`) is the source of truth.

#### Scenario: All locale files have matching keys
- **WHEN** a new key is added to `en.json`
- **THEN** TypeScript compilation SHALL fail if `de.json` does not contain the same key

#### Scenario: Translation file structure
- **WHEN** a developer opens a locale file
- **THEN** the keys SHALL be flat strings with logical prefixes (e.g., `header.title`, `form.email`, `submit.createAll`) and the values SHALL be the translated strings

### Requirement: useTranslation hook
The system SHALL provide a `useTranslation` hook in `lib/i18n.ts` that returns `{ t, locale, setLocale }` where `t` is a function accepting a translation key and returning the localized string.

#### Scenario: Using the t function
- **WHEN** a component calls `t("header.title")`
- **THEN** the hook returns the translated string for the current locale

#### Scenario: Type safety on translation keys
- **WHEN** a component calls `t("nonexistent.key")`
- **THEN** TypeScript SHALL show a compile-time error — only keys from `en.json` are valid

### Requirement: Locale detection priority
The system SHALL detect the locale in this order: (1) `localStorage("locale")`, (2) `navigator.language` prefix match against supported locales, (3) fallback to `"en"`.

#### Scenario: First visit with German browser
- **WHEN** a user visits for the first time with `navigator.language` set to `"de-DE"` and no localStorage value
- **THEN** the UI renders in German

#### Scenario: First visit with unsupported browser language
- **WHEN** a user visits with `navigator.language` set to `"fr-FR"` and no localStorage value
- **THEN** the UI renders in English (fallback)

#### Scenario: Returning visit with saved preference
- **WHEN** a user visits with `localStorage("locale")` set to `"de"`
- **THEN** the UI renders in German regardless of browser language

### Requirement: No flash of wrong language
The system SHALL suppress form rendering until the locale is resolved from localStorage to prevent a flash of the wrong language.

#### Scenario: Locale resolution before render
- **WHEN** the user has `"de"` saved in localStorage and loads the page
- **THEN** the form SHALL NOT briefly render in English before switching to German

### Requirement: All UI strings translated
Every user-facing string in the application SHALL use the `t()` function. No hardcoded user-facing strings SHALL remain in component code.

#### Scenario: Complete string extraction
- **WHEN** the EN translation file is reviewed
- **THEN** it SHALL contain keys for: page title, subtitle variations, auth section, partner/customer section titles and badges, form labels, role options, mode toggle labels, submit button variations, association status messages, all friendlyError() messages, result display labels, hint text, theme toggle aria labels, and language selector aria label

### Requirement: German string length handling
Form labels in German (e.g., "Firmenname", "Vorname", "Nachname") are longer than English equivalents. The layout SHALL handle longer strings without visual breakage.

#### Scenario: German labels in 3-column grid
- **WHEN** the locale is "de" and the contact fields render in the 3-column grid
- **THEN** labels SHALL truncate or the grid SHALL adapt so that no label wraps to create uneven row heights at viewports between 375px and 768px

### Requirement: Error messages fully translated
All user-facing error messages returned by `friendlyError()` SHALL use `t()` keys. The detection logic (matching HubSpot API error strings) stays English.

#### Scenario: Error in German locale
- **WHEN** a HubSpot 502 error occurs and the locale is "de"
- **THEN** the error message displayed to the user SHALL be in German, not English
