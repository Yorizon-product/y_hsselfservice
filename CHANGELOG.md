# Changelog

## Unreleased

**Polling-Schedule entspannt.** Die Wartezeit fuer Yorizons Einrichtungsautomation war zu optimistisch (T=0, +10s, +30s). Neue Zeiten: **30s, 60s, 120s**. Damit faengt das Tool auch die Faelle ab, in denen die Einrichtung laenger dauert, ohne faelschlicherweise als Timeout zu melden. Maximale Request-Dauer auf Vercel hochgesetzt (60s → 300s, braucht Vercel Pro).

**Polling schedule relaxed (EN).** The poll schedule for Yorizon's provisioning automation was too optimistic (T=0, +10s, +30s). New times: **30s, 60s, 120s**. Catches slower-provisioning cases without false-timing them out. Vercel `maxDuration` raised 60s → 300s (requires Vercel Pro).

---

## Unreleased (v1.0.7 scope — merged)

**Wartet auf die Portal-Einrichtung.** Der Tool erstellt jetzt erst dann einen Kontakt, wenn Yorizon die zugehoerige Firma wirklich fertig eingerichtet hat. Dafuer pollen wir das Feld `portal_status_update` mit bis zu zwei Retries (+10s, +30s). Schlaegt die Einrichtung fehl oder dauert sie zu lange, raeumt der bestehende Rollback-Pfad auf und du kannst gefahrlos nochmal. Manuelles Nachgucken im Portal-Status entfaellt.

**Live-Fortschrittsanzeige waehrend des Erstellens.** Statt eines einzelnen Spinners siehst du jetzt die aktuelle Phase — `Erstellt Partnerunternehmen`, `Yorizon richtet ein…`, `Erstellt Kontakt` — inklusive Retry-Zaehler, wenn das Warten auf die Einrichtung laenger dauert.

**Killswitch `PORTAL_STATUS_POLL=off`.** Falls das Polling irgendwo stoert, kann es ohne Redeploy einfach abgeschaltet werden; die Route verhaelt sich dann wieder wie vorher.

---

## Unreleased (EN)

**Waits for portal provisioning.** The tool now only creates a contact once Yorizon has actually finished provisioning the matching company. We poll the `portal_status_update` property with up to two retries (+10s, +30s). If provisioning fails or takes too long, the existing rollback path cleans up and you can safely retry. No more manual Portal Status checks.

**Live progress indicator while creating.** Instead of a single spinner you now see the current phase — `Creating partner company`, `Waiting for Yorizon provisioning…`, `Creating contact` — including a retry counter when the wait gets longer.

**Kill switch `PORTAL_STATUS_POLL=off`.** If the polling gets in the way, it can be turned off without a redeploy; the route reverts to pre-change behaviour.

---

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
