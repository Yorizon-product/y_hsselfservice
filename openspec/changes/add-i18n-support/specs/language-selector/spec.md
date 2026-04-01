## ADDED Requirements

### Requirement: Language selector in header
The system SHALL display a language selector button in the header row, next to the ThemeToggle. The button shows the current locale as a 2-letter uppercase code (e.g., "EN", "DE") with a swap icon to indicate interactivity. The selector SHALL be visible before and after login.

#### Scenario: Language selector visible before login
- **WHEN** the page loads and the user is not logged in
- **THEN** the language selector button is visible in the header row, allowing the user to switch the auth section language

#### Scenario: Toggling language
- **WHEN** the user clicks the language selector showing "EN"
- **THEN** the locale switches to "DE", the button updates to show "DE", all UI strings re-render in German, and `document.documentElement.lang` is set to `"de"`

#### Scenario: Toggling back
- **WHEN** the user clicks the language selector showing "DE"
- **THEN** the locale switches to "EN", the button updates to show "EN", all UI strings re-render in English, and `document.documentElement.lang` is set to `"en"`

### Requirement: Language preference persistence
The system SHALL persist the selected locale to localStorage and restore it on subsequent page loads.

#### Scenario: Language remembered across sessions
- **WHEN** the user selects "DE" and reloads the page
- **THEN** the page loads in German with the selector showing "DE"

### Requirement: Language selector accessibility
The language selector SHALL have appropriate ARIA attributes and update the HTML lang attribute.

#### Scenario: Screen reader announces language
- **WHEN** a screen reader focuses the language selector
- **THEN** it announces the current language and the action (e.g., "Language: English. Click to switch.")

#### Scenario: HTML lang attribute updated
- **WHEN** the locale changes to "de"
- **THEN** `document.documentElement.lang` is set to `"de"` so screen readers use the correct pronunciation engine

### Requirement: Language selector sizing
The language selector SHALL maintain a minimum touch target of 44x44px, matching the ThemeToggle pattern.

#### Scenario: Touch target compliance
- **WHEN** the language selector is rendered on mobile
- **THEN** the button has at least 44px height and 44px width
