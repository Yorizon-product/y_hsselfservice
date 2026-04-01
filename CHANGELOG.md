# Changelog

## v1.0.6 — 2026-04-01

**Advanced Mode** ermoeglicht es, Partner:in oder Kund:in unabhaengig voneinander anzulegen — jeweils mit eigener Rolle (RO, RW, Admin). Die Zuordnung wird nur erstellt, wenn beide vorhanden sind.

**i18n ist live.** Englisch als Standard, Deutsch inklusive. Die App erkennt deine Browsersprache und laesst dich pro Sitzung wechseln. Alle Strings — auch Fehlermeldungen — laufen ueber eine einzige Uebersetzungsdatei.

**Dark Mode funktioniert jetzt wirklich.** Der Theme-Toggle wechselt zwischen Hell, Dunkel und System — und der Seitenhintergrund zieht mit. Spoiler: oklch-Werte in hsl() zu wrappen bringt genau nichts.

**Sicherheit gehaertet.** Portal-Rollen werden serverseitig gegen eine Allowlist validiert. Ungueltige oder gemischte Rollen-Payloads bekommen eine saubere 400. Rollback-Fehler sagen dir jetzt genau, was erstellt und wieder entfernt wurde.

**Version bumpt automatisch beim Commit.** Ein Pre-Commit-Hook erhoeht die Patch-Version, sobald sich App-Code aendert. Die UI liest sie direkt aus der package.json — eine einzige Quelle der Wahrheit.

---

## v1.0.6 — 2026-04-01 (EN)

**Advanced Mode** lets you create a partner or customer independently, each with its own role (RO, RW, Admin) — the association only fires when both are present.

**i18n is live.** EN default, DE included. The app picks up your browser language and lets you switch per session. All strings — including error messages — run through a single translation file.

**Dark mode actually works now.** The theme toggle cycles light/dark/system, and the page background follows. Turns out wrapping oklch values in hsl() does nothing good.

**Security hardened.** Portal roles are validated server-side against an allowlist. Mixed or invalid role payloads get a clean 400. Rollback errors now tell you exactly what was created and removed.

**Version auto-bumps on commit.** A pre-commit hook bumps the patch version whenever app code changes. The UI reads it from package.json — one source of truth.
