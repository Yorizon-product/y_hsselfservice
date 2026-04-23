# Changelog

## Unreleased

**Owner wird jetzt gesetzt** (Fix für „Company creation failed" — Teil 2). v1.0.15 hatte nur die Hälfte der Arbeit erledigt: Domain wird zwar nicht mehr beim Create gesendet, aber Yorizons Automatik braucht auch `hubspot_owner_id` gesetzt. Wir holen die HubSpot-User-ID jetzt aus dem OAuth-Token-Info und geben sie beim Company-Create mit.

**Owner is now set on create (EN) — Part 2 of the "Company creation failed" fix.** v1.0.15 only did half the job: omitting the domain was necessary but not sufficient. Yorizon's automation requires `hubspot_owner_id` to be set too. We now pull the HubSpot user ID from the OAuth token-info response (captured at login; lazy-loaded for pre-existing sessions) and include it in the create payload.

---

## v1.0.15 (merged)

**Root-Cause-Fix für Yorizons „Company creation failed".** Unter direkter Beobachtung festgestellt: Yorizons Provisionierungs-Automatik weist integrations-erstellte Unternehmen mit gesetztem `domain`-Feld im Create-Call ab — still, ohne Begründung. Dieselbe Integration akzeptiert die Domain als _Update_ direkt nach dem Create. Der Fix: Unternehmen werden jetzt ohne Domain angelegt, nach dem erfolgreichen Poll wird die Domain per `PATCH` auf das Record gesetzt. Yorizon feuert auf das Update und schreibt „Company updated successfully".

**Root-cause fix for Yorizon's "Company creation failed" (EN).** Direct testing isolated the real blocker: Yorizon's provisioning automation silently rejects integration-created companies that have a `domain` populated at create time — and happily accepts the same domain as an _update_ immediately after. Fix: companies are now created with no `domain` field, and the domain is PATCHed on after the provisioning poll succeeds. Yorizon re-fires on the update and writes "Company updated successfully".

---

## v1.0.14 (merged)

**Sequentielle Verarbeitung pro Seite.** Partner und Kund:in werden jetzt nacheinander durchgezogen — erst Partner-Unternehmen komplett (Anlegen → Warten → Kontakt), dann Kund:innen-Unternehmen komplett, dann erst die Verknüpfung. Matcht, wie wir es manuell machen. Vermeidet nebenbei die Rennbedingungen in Yorizons Provisionierung, die wir beobachtet haben, wenn zwei Unternehmens-Events im Sekundentakt ankommen.

**Poll-Budget wieder bei T=30/60/120s pro Seite.** Zwei Seiten sequenziell ergibt ~245s Worst-Case — passt in Vercels 300s-`maxDuration`-Limit.

**Progress-Indikator zeigt jetzt pro Seite**, welche Phase gerade läuft (z. B. „Partnerunternehmen wird angelegt" → „Yorizon richtet die Partner-Umgebung ein" → „Partner-Kontakt wird angelegt" → dann dasselbe für Kund:in).

**Sequential per-side processing (EN).** Partner and customer are now run to completion one after the other — partner company fully done (create → wait → contact) before customer company even starts, then association at the end. Matches how this is done manually. Side benefit: avoids the race condition in Yorizon's provisioning we observed when two company-create events arrived ~1 second apart.

**Poll budget back to T=30/60/120s per side.** Sequential × 2 sides = ~245s worst case — fits under Vercel's 300s `maxDuration` cap.

**Progress indicator now per-side** (e.g. "Creating partner company" → "Waiting for Yorizon to provision the partner" → "Creating partner contact" → same for customer, then "Linking partner and customer").

---

## v1.0.13 (merged)

**Countdown-Timer und paralleles Polling.** Die Wartezeit wird jetzt sichtbar — ein runder Countdown zaehlt die Sekunden bis zur naechsten Pruefung herunter, pro Wiederholung frisch. Partner und Kund:in werden parallel ueberwacht, sodass die Wall-Clock-Zeit bei beiden Seiten nicht verdoppelt wird.

**Letztes Zeitfenster verdoppelt (T=30s, T=60s, T=240s).** Damit fangen wir auch die Faelle ab, in denen Yorizons Einrichtung ueber zwei Minuten braucht.

**Bessere Debug-Logs.** Jede Statusabfrage loggt jetzt auch `hs_lastmodifieddate`, sodass man im Vercel-Log auf einen Blick sieht, ob das HubSpot-Record ueberhaupt angefasst wurde (Trigger hat nicht gefeuert) oder ob der Status-Text unerwartet aussieht.

**Countdown timer and parallel polling (EN).** The wait is now visible — a circular countdown ring ticks down to the next check, fresh for each retry. Partner and customer are monitored in parallel so wall-clock time doesn't double when creating both.

**Final wait window extended (T=30s, T=60s, T=240s).** Catches the cases where Yorizon's provisioning takes longer than two minutes.

**Better debug logs.** Every status poll now also logs `hs_lastmodifieddate`, so you can tell at a glance in Vercel logs whether the HubSpot record was touched at all (trigger didn't fire) or whether the status text is unexpected.

---

## v1.0.8 (merged)

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
