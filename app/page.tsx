"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { faker } from "@faker-js/faker/locale/de";
import { useTranslation } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/i18n";
import { ensurePermission, notify } from "@/lib/notifications";

import packageJson from "../package.json";
const APP_VERSION = packageJson.version;

type ContactFields = { firstname: string; lastname: string; email: string };
type CompanyFields = { name: string; domain: string; contact: ContactFields };
type CreatedEntity = { type: string; id: string; name: string; url: string };
type RollbackId = { type: "company" | "contact" | "note"; id: string; label?: string };

const emptyContact = (): ContactFields => ({ firstname: "", lastname: "", email: "" });
const emptyCompany = (): CompanyFields => ({ name: "", domain: "", contact: emptyContact() });

type Mode = "simple" | "advanced";
type Theme = "system" | "light" | "dark";

type ProgressStage =
  | "creatingPartnerCompany"
  | "waitingPartnerProvisioning"
  | "creatingPartnerContact"
  | "creatingCustomerCompany"
  | "waitingCustomerProvisioning"
  | "creatingCustomerContact"
  | "associating";
type Progress = {
  stage: ProgressStage;
  step: number;        // 1-indexed step in the active flow
  totalSteps: number;  // depends on which sides are selected
  retry?: { current: number; total: number };
  secondsUntilNextCheck?: number;
  windowProgress?: number;
};

// Compute the ordered list of stages for the current configuration. Lets us
// derive "Step X of N" without hardcoding offsets per stage.
function stageSequence(doPartner: boolean, doCustomer: boolean): ProgressStage[] {
  const steps: ProgressStage[] = [];
  if (doPartner) steps.push("creatingPartnerCompany", "waitingPartnerProvisioning", "creatingPartnerContact");
  if (doCustomer) steps.push("creatingCustomerCompany", "waitingCustomerProvisioning", "creatingCustomerContact");
  if (doPartner && doCustomer) steps.push("associating");
  return steps;
}

// Stage boundaries match the per-side flow in app/api/create/side/route.ts
// and the default delays in lib/portal-status.ts ([60s, 60s, 120s] per
// side — each side runs in its own 300s Vercel invocation with 240s of
// poll budget).
const CREATE_COMPANY_MS = 1_000;
const CREATE_CONTACT_MS = 1_000;
const POLL_WINDOW_1_MS = 60_000;
const POLL_WINDOW_2_MS = 60_000;
const POLL_WINDOW_3_MS = 120_000;
const SIDE_TOTAL_MS = CREATE_COMPANY_MS + POLL_WINDOW_1_MS + POLL_WINDOW_2_MS + POLL_WINDOW_3_MS + CREATE_CONTACT_MS;

// Partial progress (without step/totalSteps) — the outer computeProgress
// fills those in based on the active side configuration.
type SideProgress = Omit<Progress, "step" | "totalSteps">;

function computeSideProgress(
  sideElapsedMs: number,
  sidePrefix: "Partner" | "Customer"
): SideProgress | null {
  const companyStage = `creating${sidePrefix}Company` as ProgressStage;
  const waitingStage = `waiting${sidePrefix}Provisioning` as ProgressStage;
  const contactStage = `creating${sidePrefix}Contact` as ProgressStage;

  if (sideElapsedMs < CREATE_COMPANY_MS) return { stage: companyStage };

  const pollElapsed = sideElapsedMs - CREATE_COMPANY_MS;
  if (pollElapsed < POLL_WINDOW_1_MS) {
    const remaining = POLL_WINDOW_1_MS - pollElapsed;
    return {
      stage: waitingStage,
      secondsUntilNextCheck: Math.max(0, Math.ceil(remaining / 1000)),
      windowProgress: pollElapsed / POLL_WINDOW_1_MS,
    };
  }
  const afterW1 = pollElapsed - POLL_WINDOW_1_MS;
  if (afterW1 < POLL_WINDOW_2_MS) {
    const remaining = POLL_WINDOW_2_MS - afterW1;
    return {
      stage: waitingStage,
      retry: { current: 1, total: 2 },
      secondsUntilNextCheck: Math.max(0, Math.ceil(remaining / 1000)),
      windowProgress: afterW1 / POLL_WINDOW_2_MS,
    };
  }
  const afterW2 = afterW1 - POLL_WINDOW_2_MS;
  if (afterW2 < POLL_WINDOW_3_MS) {
    const remaining = POLL_WINDOW_3_MS - afterW2;
    return {
      stage: waitingStage,
      retry: { current: 2, total: 2 },
      secondsUntilNextCheck: Math.max(0, Math.ceil(remaining / 1000)),
      windowProgress: afterW2 / POLL_WINDOW_3_MS,
    };
  }
  const afterPoll = afterW2 - POLL_WINDOW_3_MS;
  if (afterPoll < CREATE_CONTACT_MS) return { stage: contactStage };
  return null;
}

type Phase = "partner" | "customer" | "associate";

// `elapsedInPhaseMs` is time since the CURRENT phase started, not since
// submit — the client resets its clock at each phase transition so the
// UI snaps forward when a side completes early. `phase` is the real
// server phase the client is awaiting, driven by which /api/create/side
// call is in flight.
function computeProgress(
  elapsedInPhaseMs: number,
  phase: Phase,
  doPartner: boolean,
  doCustomer: boolean
): Progress | null {
  const sequence = stageSequence(doPartner, doCustomer);
  let inner: SideProgress | null = null;
  if (phase === "partner") {
    inner = computeSideProgress(elapsedInPhaseMs, "Partner");
    if (!inner) inner = { stage: "creatingPartnerContact" };
  } else if (phase === "customer") {
    inner = computeSideProgress(elapsedInPhaseMs, "Customer");
    if (!inner) inner = { stage: "creatingCustomerContact" };
  } else {
    inner = { stage: "associating" };
  }
  const idx = sequence.indexOf(inner.stage);
  return {
    ...inner,
    step: idx >= 0 ? idx + 1 : sequence.length,
    totalSteps: sequence.length,
  };
}

const PORTAL_ERROR_CODES = ["PORTAL_TIMEOUT", "PORTAL_CREATION_FAILED", "PORTAL_UNEXPECTED_STATE"] as const;
type PortalErrorCode = typeof PORTAL_ERROR_CODES[number];

function generateRandomCompany(userEmail: string | null, role: "partner" | "customer"): CompanyFields {
  const first = faker.person.firstName();
  const last = faker.person.lastName();
  // Company name includes the role tag ("PARTNER" or "CUSTOMER") as a
  // suffix so you can tell at a glance in HubSpot which form slot a
  // record came from — helpful when the sequential flow fails mid-way
  // and only one of a pair shows up in the portal.
  const suffix = faker.helpers.arrayElement(["GmbH", "AG", "UG", "Gruppe", "KG"]);
  const companyName = `${last} ${suffix} ${role.toUpperCase()}`;
  const slug = faker.string.alphanumeric(4);
  // Keep the domain slug short — long subdomain labels may hit separate
  // provisioning limits. Slugify the core name (without the role tag) so
  // domains stay compact.
  const firstWord = faker.helpers
    .slugify(`${last} ${suffix}`)
    .toLowerCase()
    .split("-")[0]
    .slice(0, 12);
  const domain = `${firstWord}-${slug}.example.com`;
  // Email tag leads with the role so the +alias in the inbox is
  // immediately identifiable as partner vs customer, regardless of
  // the trailing random slug.
  const tag = `${role}-${firstWord}-${slug}`;
  let contactEmail: string;
  if (userEmail && userEmail.includes("@")) {
    const [localPart, domainPart] = userEmail.split("@");
    contactEmail = `${localPart}+${tag}@${domainPart}`;
  } else {
    contactEmail = `${first.toLowerCase()}.${last.toLowerCase()}+${tag}@example.com`;
  }
  return { name: companyName, domain, contact: { firstname: first, lastname: last, email: contactEmail } };
}

function useTheme() {
  const [theme, setThemeState] = useState<Theme>("system");
  useEffect(() => {
    const stored = localStorage.getItem("theme") as Theme | null;
    if (stored === "light" || stored === "dark") setThemeState(stored);
  }, []);
  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    const html = document.documentElement;
    html.classList.remove("dark", "light");
    if (t === "dark") { html.classList.add("dark"); localStorage.setItem("theme", "dark"); }
    else if (t === "light") { html.classList.add("light"); localStorage.setItem("theme", "light"); }
    else { localStorage.removeItem("theme"); }
  }, []);
  const cycle = useCallback(() => {
    setTheme(theme === "system" ? "light" : theme === "light" ? "dark" : "system");
  }, [theme, setTheme]);
  return { theme, cycle };
}

function useMode() {
  const [mode, setModeState] = useState<Mode | null>(null);
  useEffect(() => {
    const stored = localStorage.getItem("mode") as Mode | null;
    setModeState(stored === "advanced" ? "advanced" : "simple");
  }, []);
  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    localStorage.setItem("mode", m);
    if (m === "advanced") localStorage.setItem("hint-dismissed", "true");
  }, []);
  return { mode, setMode };
}

export default function Home() {
  const [authLoading, setAuthLoading] = useState(true);
  const [loggedIn, setLoggedIn] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [portalId, setPortalId] = useState<string | null>(null);

  const [partner, setPartner] = useState<CompanyFields>(emptyCompany());
  const [customer, setCustomer] = useState<CompanyFields>(emptyCompany());

  const [portalRole, setPortalRole] = useState("User-RO");
  const [partnerRole, setPartnerRole] = useState("User-RO");
  const [customerRole, setCustomerRole] = useState("User-RO");

  const [partnerEnabled, setPartnerEnabled] = useState(true);
  const [customerEnabled, setCustomerEnabled] = useState(true);

  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [results, setResults] = useState<CreatedEntity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const progressStartRef = useRef<number>(0);
  const progressPhaseRef = useRef<Phase>("partner");
  const progressTickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { theme, cycle: cycleTheme } = useTheme();
  const { mode, setMode } = useMode();
  const { t, locale, cycleLocale } = useTranslation();

  const [hintDismissed, setHintDismissed] = useState(true);
  useEffect(() => {
    setHintDismissed(localStorage.getItem("hint-dismissed") === "true");
  }, []);

  const isAdvanced = mode === "advanced";

  useEffect(() => {
    return () => {
      if (cooldownRef.current) clearInterval(cooldownRef.current);
      if (progressTickRef.current) clearInterval(progressTickRef.current);
    };
  }, []);

  useEffect(() => {
    fetch("/api/auth/me")
      .then(async (r) => {
        if (!r.ok) return;
        const data = await r.json();
        if (data.loggedIn) {
          setLoggedIn(true);
          setUserEmail(data.userEmail);
          if (data.portalId) setPortalId(data.portalId);
        }
      })
      .catch(() => {})
      .finally(() => setAuthLoading(false));
  }, []);

  const handleSignOut = () => { window.location.href = "/api/auth/logout"; };

  const handleStartOver = () => {
    setPartner(emptyCompany()); setCustomer(emptyCompany());
    setPartnerRole("User-RO"); setCustomerRole("User-RO"); setPortalRole("User-RO");
    setPartnerEnabled(true); setCustomerEnabled(true);
    setResults(null); setError(null);
  };

  const handleRandomize = (role: "partner" | "customer") => {
    const company = generateRandomCompany(userEmail, role);
    if (role === "partner") setPartner(company); else setCustomer(company);
  };

  const startCooldown = () => {
    if (cooldownRef.current) clearInterval(cooldownRef.current);
    setCooldown(10);
    cooldownRef.current = setInterval(() => {
      setCooldown((c) => {
        if (c <= 1) { clearInterval(cooldownRef.current!); cooldownRef.current = null; return 0; }
        return c - 1;
      });
    }, 1000);
  };

  const friendlyError = (msg: string, code?: PortalErrorCode): string => {
    if (code === "PORTAL_TIMEOUT") return t("poll.error.timeout" as TranslationKey) || msg;
    if (code === "PORTAL_CREATION_FAILED") return t("poll.error.creationFailed" as TranslationKey) || msg;
    if (code === "PORTAL_UNEXPECTED_STATE") return t("poll.error.unexpectedState" as TranslationKey) || msg;
    if (msg.includes("Not authenticated") || msg.includes("expired")) return t("error.sessionExpired");
    if (msg.includes("502") || msg.includes("Bad Gateway")) return t("error.502");
    if (msg.includes("503") || msg.includes("Service Unavailable")) return t("error.503");
    if (msg.includes("429") || msg.includes("rate limit")) return t("error.rateLimit");
    if (msg.includes("non-JSON")) return t("error.nonJson");
    return msg;
  };

  const handleSubmit = async () => {
    if (loading) return;
    // Fire-and-forget permission prompt — never blocks submit. Ties the
    // browser prompt to an explicit user action (the click) instead of
    // page load, which browsers heavily penalize.
    void ensurePermission();
    setLoading(true); setError(null); setResults(null);
    const activePartner = isAdvanced && !partnerEnabled ? null : partner;
    const activeCustomer = isAdvanced && !customerEnabled ? null : customer;
    const doPartner = !!activePartner;
    const doCustomer = !!activeCustomer;
    // Progress clock is phase-local: reset on each phase transition so
    // the UI snaps forward when a side completes earlier than the
    // worst-case budget would predict.
    progressStartRef.current = performance.now();
    progressPhaseRef.current = doPartner ? "partner" : "customer";
    setProgress(computeProgress(0, progressPhaseRef.current, doPartner, doCustomer));
    if (progressTickRef.current) clearInterval(progressTickRef.current);
    // 250ms tick keeps the per-second countdown readable without
    // over-rendering. The progress ring is CSS-animated, not JS-driven.
    progressTickRef.current = setInterval(() => {
      const elapsed = performance.now() - progressStartRef.current;
      setProgress(computeProgress(elapsed, progressPhaseRef.current, doPartner, doCustomer));
    }, 250);

    const advancePhase = (next: Phase) => {
      progressPhaseRef.current = next;
      progressStartRef.current = performance.now();
      setProgress(computeProgress(0, next, doPartner, doCustomer));
    };

    // Accumulators across the (up to) three phase calls. If a later
    // phase fails, we POST these to /api/create/rollback so the user
    // never sees orphan records from earlier-succeeded phases.
    const allCreated: CreatedEntity[] = [];
    const allTrackedIds: RollbackId[] = [];
    const idemKey = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const rolePayload = (side: "partner" | "customer") => {
      if (isAdvanced) return { portalRole: side === "partner" ? partnerRole : customerRole };
      return { portalRole };
    };

    const callSide = async (side: "partner" | "customer", payload: CompanyFields) => {
      const res = await fetch("/api/create/side", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-idempotency-key": idemKey() },
        body: JSON.stringify({ side, payload, portalId, ...rolePayload(side) }),
      });
      const data = await res.json();
      if (!res.ok) {
        const err = new Error(data.error || t("error.generic"));
        (err as any).code = data.code;
        (err as any).rawStatus = data.rawStatus;
        (err as any).kept = data.kept;
        throw err;
      }
      allCreated.push(...(data.created as CreatedEntity[]));
      if (Array.isArray(data.trackedIds)) {
        allTrackedIds.push(...(data.trackedIds as RollbackId[]));
      }
    };

    const callAssociate = async (partnerCompanyId: string, customerCompanyId: string) => {
      const res = await fetch("/api/create/associate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-idempotency-key": idemKey() },
        body: JSON.stringify({
          partnerCompanyId,
          customerCompanyId,
          partnerName: activePartner?.name,
          customerName: activeCustomer?.name,
          portalId,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        const err = new Error(data.error || t("error.generic"));
        (err as any).code = data.code;
        throw err;
      }
      allCreated.push(...(data.created as CreatedEntity[]));
    };

    // Only fires when we have something to clean up — the server's
    // per-side route already rolled back its own in-flight failures.
    const clientRollback = async () => {
      if (allTrackedIds.length === 0) return [] as string[];
      try {
        const res = await fetch("/api/create/rollback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: allTrackedIds }),
        });
        if (!res.ok) return allTrackedIds.map(t => t.label || `${t.type}_${t.id}`);
        const data = await res.json();
        return (data.deleted as Array<{ label?: string; type: string; id: string }>).map(
          d => d.label || `${d.type}_${d.id}`
        );
      } catch {
        return allTrackedIds.map(t => t.label || `${t.type}_${t.id}`);
      }
    };

    try {
      if (doPartner) {
        await callSide("partner", activePartner!);
        // Partner finished; advance the client clock so the UI doesn't
        // linger on "waiting for partner" while the customer call is
        // already in flight.
        if (doCustomer) advancePhase("customer");
      }
      if (doCustomer) await callSide("customer", activeCustomer!);
      if (doPartner && doCustomer) {
        advancePhase("associate");
        const partnerCompanyId = allTrackedIds.find(t => t.label === "partner_company")?.id;
        const customerCompanyId = allTrackedIds.find(t => t.label === "customer_company")?.id;
        if (!partnerCompanyId || !customerCompanyId) {
          throw new Error("Internal: missing company IDs for association");
        }
        await callAssociate(partnerCompanyId, customerCompanyId);
      }
      setResults(allCreated);
      setPartner(emptyCompany()); setCustomer(emptyCompany());
      // Only fires when the tab is hidden — see lib/notifications.ts.
      const bodyKey: TranslationKey =
        doPartner && doCustomer ? "notify.success.body.both"
        : doPartner ? "notify.success.body.partner"
        : "notify.success.body.customer";
      notify({ title: t("notify.success.title"), body: t(bodyKey) });
    } catch (e: any) {
      const code = PORTAL_ERROR_CODES.includes(e.code) ? (e.code as PortalErrorCode) : undefined;
      const base = friendlyError(e.message, code);
      // Notification body uses the clean friendly message — no rawStatus,
      // no kept-URL debug block. Those stay inline-only.
      notify({ title: t("notify.error.title"), body: base });
      // If the server reported the raw Yorizon status, append it so the
      // user sees exactly what the automation wrote.
      const withRaw = e.rawStatus
        ? `${base}\n\nHubSpot reported: ${e.rawStatus}`
        : base;
      // When debug mode (PORTAL_STATUS_POLL_KEEP_ON_FAIL=1) kept the
      // failed records in HubSpot, show their direct URLs.
      const withKept = e.kept && e.kept.length > 0
        ? `${withRaw}\n\nKept in HubSpot for inspection:\n${e.kept.map((k: any) => `· ${k.type.replace(/_/g, " ")} → ${k.url}`).join("\n")}`
        : withRaw;
      // If earlier phases already succeeded, tell the rollback endpoint
      // to clean them up before we surface the error.
      const rolledBackLabels = await clientRollback();
      const withRollback = rolledBackLabels.length > 0
        ? `${withKept}\n\nPreviously-created records were removed: ${rolledBackLabels.map(l => l.replace(/_/g, " ")).join(", ")}`
        : withKept;
      setError(withRollback);
      startCooldown();
    } finally {
      setLoading(false);
      if (progressTickRef.current) { clearInterval(progressTickRef.current); progressTickRef.current = null; }
      setProgress(null);
    }
  };

  const updatePartner = (patch: Partial<CompanyFields>) => setPartner((p) => ({ ...p, ...patch }));
  const updatePartnerContact = (patch: Partial<ContactFields>) => setPartner((p) => ({ ...p, contact: { ...p.contact, ...patch } }));
  const updateCustomer = (patch: Partial<CompanyFields>) => setCustomer((c) => ({ ...c, ...patch }));
  const updateCustomerContact = (patch: Partial<ContactFields>) => setCustomer((c) => ({ ...c, contact: { ...c.contact, ...patch } }));

  const isValid = isAdvanced
    ? (partnerEnabled ? partner.name && partner.contact.email : true) &&
      (customerEnabled ? customer.name && customer.contact.email : true) &&
      (partnerEnabled || customerEnabled)
    : partner.name && partner.contact.email && customer.name && customer.contact.email;

  const submitLabel = isAdvanced
    ? partnerEnabled && customerEnabled ? t("submit.createPartnerCustomer")
      : partnerEnabled ? t("submit.createPartner")
      : customerEnabled ? t("submit.createCustomer")
      : t("submit.createAll")
    : t("submit.createAll");

  const subtitleKey: TranslationKey = isAdvanced
    ? partnerEnabled && customerEnabled ? "header.subtitle.advanced.both" : "header.subtitle.advanced.single"
    : "header.subtitle.simple";

  const themeAriaKey: TranslationKey = theme === "dark" ? "theme.dark" : theme === "light" ? "theme.light" : "theme.system";

  // Suppress render until all preferences resolved
  if (authLoading || mode === null || locale === null) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-sm text-muted-foreground">{t("loading") || "Loading..."}</p>
      </main>
    );
  }

  return (
    <main id="main-content" className="min-h-screen flex items-start justify-center px-4 py-12 md:py-20">
      <div className="w-full max-w-2xl">
        {/* Header */}
        <div className="animate-in mb-6">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <div className="w-2 h-2 rounded-full bg-accent" />
              <span className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
                {t("header.appName")} · v{APP_VERSION}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <LanguageSelector locale={locale} onCycle={cycleLocale} ariaLabel={t("language.switch")} />
              <ThemeToggle theme={theme} onCycle={cycleTheme} ariaLabel={t(themeAriaKey)} />
            </div>
          </div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight font-heading text-card-foreground">
            {t("header.title")}
          </h1>
          <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
            {t(subtitleKey)}
          </p>
        </div>

        {/* Mode Toggle */}
        {loggedIn && (
          <div className="animate-in mb-6">
            <SegmentedControl
              value={mode}
              onChange={setMode}
              disabled={loading}
              options={[
                { value: "simple" as Mode, label: t("mode.simple") },
                { value: "advanced" as Mode, label: t("mode.advanced") },
              ]}
            />
          </div>
        )}

        {/* Auth */}
        {!loggedIn ? (
          <div className="animate-in animate-in-delay-1">
            <Section title={t("auth.connect")}>
              <p className="text-sm text-muted-foreground mb-4">{t("auth.connectDescription")}</p>
              <a href="/api/auth/install"
                className="block w-full min-h-[44px] py-2.5 rounded-pill font-button font-semibold text-sm uppercase tracking-wide transition-all text-center bg-primary text-primary-foreground hover:opacity-90">
                {t("auth.connect")}
              </a>
            </Section>
          </div>
        ) : (
          <>
            {/* User indicator */}
            <div className="animate-in flex items-center justify-between mb-6 px-3 py-2 rounded-lg bg-card border border-border">
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-success" />
                <span className="text-xs font-mono text-muted-foreground">
                  {userEmail || t("auth.connected")}
                  {portalId ? ` · ${t("auth.portal")} ${portalId}` : ""}
                </span>
              </div>
              <button onClick={handleSignOut}
                className="text-xs font-button min-h-[44px] text-muted-foreground hover:text-foreground transition-colors">
                {t("auth.disconnect")}
              </button>
            </div>

            {/* Partner */}
            <div className="animate-in animate-in-delay-1">
              <Section title={t("partner.title")} badge={t("partner.badge")}
                showCheckbox={isAdvanced} checked={partnerEnabled} onCheckedChange={setPartnerEnabled}
                disabled={!partnerEnabled && isAdvanced} enableLabel={`${t("entity.enable")} ${t("partner.title")}`}
                action={
                  <div className="flex flex-wrap items-center gap-2">
                    {isAdvanced && <RoleSelect value={partnerRole} onChange={setPartnerRole} disabled={!partnerEnabled} t={t} />}
                    {(!isAdvanced || partnerEnabled) && (
                      <button onClick={() => handleRandomize("partner")}
                        className="text-xs px-2.5 py-1 rounded-md font-button min-h-[44px] font-medium transition-all bg-muted border border-border text-muted-foreground hover:text-foreground hover:border-accent">
                        {t("entity.randomize")}
                      </button>
                    )}
                  </div>
                }>
                <EntityFields company={partner} onCompanyChange={updatePartner} onContactChange={updatePartnerContact}
                  disabled={isAdvanced && !partnerEnabled} t={t} namePlaceholder="Acme Corp" domainPlaceholder="acme.com" />
              </Section>
            </div>

            {/* Customer */}
            <div className="animate-in animate-in-delay-2">
              <Section title={t("customer.title")} badge={t("customer.badge")}
                showCheckbox={isAdvanced} checked={customerEnabled} onCheckedChange={setCustomerEnabled}
                disabled={!customerEnabled && isAdvanced} enableLabel={`${t("entity.enable")} ${t("customer.title")}`}
                action={
                  <div className="flex flex-wrap items-center gap-2">
                    {isAdvanced && <RoleSelect value={customerRole} onChange={setCustomerRole} disabled={!customerEnabled} t={t} />}
                    {(!isAdvanced || customerEnabled) && (
                      <button onClick={() => handleRandomize("customer")}
                        className="text-xs px-2.5 py-1 rounded-md font-button min-h-[44px] font-medium transition-all bg-muted border border-border text-muted-foreground hover:text-foreground hover:border-accent">
                        {t("entity.randomize")}
                      </button>
                    )}
                  </div>
                }>
                <EntityFields company={customer} onCompanyChange={updateCustomer} onContactChange={updateCustomerContact}
                  disabled={isAdvanced && !customerEnabled} t={t} namePlaceholder="Widget Inc" domainPlaceholder="widget.io" />
              </Section>
            </div>

            {/* Portal Role (Simple mode only) */}
            {!isAdvanced && (
              <div className="animate-in animate-in-delay-3">
                <Section title={t("role.sectionTitle")}>
                  <div>
                    <label className="block text-sm font-medium text-muted-foreground mb-1.5 truncate">{t("role.label")}</label>
                    <select value={portalRole} onChange={(e) => setPortalRole(e.target.value)}
                      className="w-full px-3 h-[50px] rounded-sm text-base bg-card border border-border text-foreground transition-colors">
                      <option value="Admin-RW">{t("role.admin")}</option>
                      <option value="User-RW">{t("role.rw")}</option>
                      <option value="User-RO">{t("role.ro")}</option>
                    </select>
                  </div>
                </Section>
              </div>
            )}

            {/* Association Status (Advanced mode) */}
            {isAdvanced && (
              <div className="animate-in flex items-center gap-2 mb-4 px-1">
                <div className={`w-1.5 h-1.5 rounded-full ${partnerEnabled && customerEnabled ? "bg-success" : "bg-muted-foreground"}`} />
                <span className={`text-xs font-mono ${partnerEnabled && customerEnabled ? "text-success" : "text-muted-foreground"}`}>
                  {partnerEnabled && customerEnabled ? t("association.willCreate") : t("association.singleEntity")}
                </span>
              </div>
            )}

            {/* First-visit hint */}
            {!isAdvanced && !hintDismissed && (
              <div className="animate-in flex items-center justify-between mb-4 px-3 py-2 rounded-lg bg-muted border border-border">
                <span className="text-xs text-muted-foreground">{t("hint.advancedMode")}</span>
                <button onClick={() => { setHintDismissed(true); localStorage.setItem("hint-dismissed", "true"); }}
                  className="text-xs font-button min-h-[44px] text-muted-foreground hover:text-foreground transition-colors ml-2">
                  {t("hint.dismiss")}
                </button>
              </div>
            )}

            {/* Submit */}
            <button onClick={handleSubmit} disabled={!isValid || loading || cooldown > 0}
              className="w-full min-h-[44px] py-3 rounded-pill font-button font-semibold text-sm uppercase tracking-wide transition-all bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed">
              {loading ? t("submit.creating") : cooldown > 0 ? t("submit.retryIn", { seconds: cooldown }) : submitLabel}
            </button>

            {/* Progress (while loading) */}
            {loading && progress && (
              <ProgressIndicator progress={progress} t={t} />
            )}

            {/* Error */}
            {error && (
              <div className="mt-4 p-4 rounded-lg bg-destructive/10 border border-destructive/20" role="alert">
                <p className="text-sm text-destructive font-mono whitespace-pre-wrap break-words">{error}</p>
              </div>
            )}

            {/* Results */}
            {results && (
              <div className="mt-6 animate-in">
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-success" />
                  <span className="text-xs font-mono uppercase tracking-widest text-success">{t("results.success")}</span>
                </div>
                <ResultsDisplay results={results} t={t} />
                <button onClick={handleStartOver}
                  className="mt-6 w-full min-h-[44px] py-3 rounded-pill font-button font-semibold text-sm uppercase tracking-wide transition-all bg-muted border border-border text-foreground hover:border-accent">
                  {t("results.startOver")}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}

/* --- Components --- */

type TFunc = (key: TranslationKey, vars?: Record<string, string | number>) => string;

function ProgressIndicator({ progress, t }: { progress: Progress; t: TFunc }) {
  const isWaiting = progress.stage === "waitingPartnerProvisioning" || progress.stage === "waitingCustomerProvisioning";
  const label = t(("poll.stage." + progress.stage) as TranslationKey);
  const retryLabel = progress.retry
    ? t("poll.retry" as TranslationKey, { current: progress.retry.current, total: progress.retry.total })
    : null;

  // SVG ring: circumference = 2 * π * r. r=20 → C ≈ 125.66.
  const RADIUS = 20;
  const CIRC = 2 * Math.PI * RADIUS;
  const fillFraction = isWaiting && progress.windowProgress !== undefined ? progress.windowProgress : 0;
  const dashOffset = CIRC * (1 - Math.min(1, Math.max(0, fillFraction)));

  return (
    <div
      className="mt-4 px-3 py-3 rounded-lg bg-muted/50 border border-border"
      role="status"
      aria-live="polite"
    >
      {/* Step header: "Step X of N" above the stage row */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-[0.7rem] font-mono uppercase tracking-wider text-muted-foreground">
          {t("poll.stepOf" as TranslationKey, { step: progress.step, total: progress.totalSteps })}
        </span>
        {/* Horizontal step pips */}
        <div className="flex items-center gap-1">
          {Array.from({ length: progress.totalSteps }).map((_, i) => {
            const isDone = i + 1 < progress.step;
            const isCurrent = i + 1 === progress.step;
            return (
              <div
                key={i}
                className={`w-1.5 h-1.5 rounded-full transition-colors ${
                  isDone ? "bg-primary" : isCurrent ? "bg-primary animate-pulse" : "bg-border"
                }`}
                aria-hidden="true"
              />
            );
          })}
        </div>
      </div>
      <div className="flex items-center gap-3">
        {isWaiting ? (
          <div className="relative w-12 h-12 shrink-0">
            <svg className="w-12 h-12 -rotate-90" viewBox="0 0 48 48" aria-hidden="true">
              <circle cx="24" cy="24" r={RADIUS} fill="none" stroke="currentColor" strokeWidth="3" className="text-border" />
              <circle
                cx="24"
                cy="24"
                r={RADIUS}
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeDasharray={CIRC}
                strokeDashoffset={dashOffset}
                strokeLinecap="round"
                className="text-primary transition-all duration-250 ease-linear"
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-xs font-mono font-semibold tabular-nums text-foreground">
                {progress.secondsUntilNextCheck ?? 0}
                <span className="text-[0.6em] text-muted-foreground">s</span>
              </span>
            </div>
          </div>
        ) : (
          <div className="w-12 h-12 shrink-0 flex items-center justify-center">
            <div className="w-3 h-3 rounded-full bg-primary animate-pulse" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-foreground">{label}</div>
          {isWaiting && (
            <div className="text-xs font-mono text-muted-foreground mt-0.5">
              {retryLabel ? <>{retryLabel} · </> : null}
              {t("poll.nextCheckIn" as TranslationKey, { seconds: progress.secondsUntilNextCheck ?? 0 })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ResultsDisplay({ results, t }: { results: CreatedEntity[]; t: TFunc }) {
  const partnerResults = results.filter(r => r.type.startsWith("Partner"));
  const customerResults = results.filter(r => r.type.startsWith("Customer"));
  const associationResult = results.find(r => r.type === "Association");
  return (
    <div className="space-y-4">
      {partnerResults.length > 0 && (
        <div>
          <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-2 block">{t("results.partner")}</span>
          <div className="space-y-2">{partnerResults.map((r, i) => <ResultRow key={i} entity={r} />)}</div>
        </div>
      )}
      {customerResults.length > 0 && (
        <div>
          <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-2 block">{t("results.customer")}</span>
          <div className="space-y-2">{customerResults.map((r, i) => <ResultRow key={i} entity={r} />)}</div>
        </div>
      )}
      <div className="flex items-center gap-2 pt-2">
        <div className={`w-1.5 h-1.5 rounded-full ${associationResult ? "bg-success" : "bg-muted-foreground"}`} />
        <span className={`text-xs font-mono ${associationResult ? "text-success" : "text-muted-foreground"}`}>
          {associationResult ? `${t("results.associationCreated")} (${associationResult.name})` : t("results.associationSkipped")}
        </span>
      </div>
      {associationResult && <ResultRow entity={associationResult} />}
    </div>
  );
}

function ResultRow({ entity }: { entity: CreatedEntity }) {
  return (
    <a href={entity.url} target="_blank" rel="noopener noreferrer"
      className="flex items-center justify-between p-3 rounded-lg bg-card border border-border hover:border-accent hover:shadow-md transition-all group cursor-pointer">
      <div>
        <span className="text-xs font-mono text-muted-foreground uppercase">{entity.type}</span>
        <p className="text-sm font-medium">{entity.name}</p>
      </div>
      <span className="text-xs font-mono text-muted-foreground group-hover:text-accent transition-colors">{entity.id} &rarr;</span>
    </a>
  );
}

function EntityFields({ company, onCompanyChange, onContactChange, disabled, t, namePlaceholder, domainPlaceholder }: {
  company: CompanyFields; onCompanyChange: (p: Partial<CompanyFields>) => void; onContactChange: (p: Partial<ContactFields>) => void;
  disabled?: boolean; t: TFunc; namePlaceholder: string; domainPlaceholder: string;
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Input label={t("form.companyName")} value={company.name} onChange={(v) => onCompanyChange({ name: v })} placeholder={namePlaceholder} disabled={disabled} />
        <Input label={t("form.domain")} value={company.domain} onChange={(v) => onCompanyChange({ domain: v })} placeholder={domainPlaceholder} disabled={disabled} />
      </div>
      <div className="grid grid-cols-3 gap-3 mt-3">
        <Input label={t("form.firstName")} value={company.contact.firstname} onChange={(v) => onContactChange({ firstname: v })} disabled={disabled} />
        <Input label={t("form.lastName")} value={company.contact.lastname} onChange={(v) => onContactChange({ lastname: v })} disabled={disabled} />
        <Input label={t("form.email")} value={company.contact.email} onChange={(v) => onContactChange({ email: v })} type="email" mono disabled={disabled} />
      </div>
    </>
  );
}

function SegmentedControl<T extends string>({ value, onChange, options, disabled }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; disabled?: boolean;
}) {
  return (
    <div className={`flex w-full rounded-pill bg-muted p-1 ${disabled ? "opacity-50 pointer-events-none" : ""}`} role="radiogroup" aria-label="Mode selection">
      {options.map((opt) => (
        <button key={opt.value} role="radio" aria-checked={value === opt.value} onClick={() => onChange(opt.value)} disabled={disabled}
          className={`flex-1 min-h-[44px] rounded-pill font-button text-xs uppercase tracking-wide transition-all ${
            value === opt.value ? "bg-card border border-border shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
          }`}>
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function RoleSelect({ value, onChange, disabled, t }: { value: string; onChange: (v: string) => void; disabled?: boolean; t: TFunc }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}
      className="h-[44px] px-3 text-xs font-mono rounded-md bg-muted border border-border text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
      <option value="Admin-RW">{t("role.admin")}</option>
      <option value="User-RW">{t("role.rw")}</option>
      <option value="User-RO">{t("role.ro")}</option>
    </select>
  );
}

function LanguageSelector({ locale, onCycle, ariaLabel }: { locale: string; onCycle: () => void; ariaLabel: string }) {
  return (
    <button onClick={onCycle} aria-label={ariaLabel} title={ariaLabel}
      className="min-h-[44px] min-w-[44px] flex items-center justify-center gap-1 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:border-accent transition-colors">
      <span className="text-xs font-mono font-semibold uppercase">{locale}</span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" />
        <polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
      </svg>
    </button>
  );
}

function ThemeToggle({ theme, onCycle, ariaLabel }: { theme: Theme; onCycle: () => void; ariaLabel: string }) {
  return (
    <button onClick={onCycle} aria-label={ariaLabel} title={ariaLabel}
      className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg border border-border text-muted-foreground hover:text-foreground hover:border-accent transition-colors">
      {theme === "dark" ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
      ) : theme === "light" ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" /></svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></svg>
      )}
    </button>
  );
}

function Section({ title, badge, action, children, showCheckbox, checked, onCheckedChange, disabled, enableLabel }: {
  title: string; badge?: string; action?: React.ReactNode; children: React.ReactNode;
  showCheckbox?: boolean; checked?: boolean; onCheckedChange?: (c: boolean) => void; disabled?: boolean; enableLabel?: string;
}) {
  return (
    <div className={`mb-6 p-5 rounded-lg shadow-sm bg-card transition-all duration-200 ${disabled ? "opacity-50 border border-dashed border-border" : "border border-border"}`}
      aria-disabled={disabled || undefined}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          {showCheckbox ? (
            <input type="checkbox" checked={checked} onChange={(e) => onCheckedChange?.(e.target.checked)}
              className="w-4 h-4 rounded accent-primary cursor-pointer" aria-label={enableLabel || `Enable ${title}`} />
          ) : (
            <div className="w-2 h-2 rounded-full bg-accent" />
          )}
          <h2 className="text-sm font-semibold tracking-tight font-heading text-card-foreground">{title}</h2>
          {badge && <span className="text-[10px] font-mono px-2 py-0.5 rounded-pill bg-muted text-muted-foreground border border-border">{badge}</span>}
        </div>
        {action}
      </div>
      <div className={disabled ? "pointer-events-none" : ""}>{children}</div>
    </div>
  );
}

function Input({ label, value, onChange, type = "text", placeholder, mono, disabled }: {
  label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string; mono?: boolean; disabled?: boolean;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-muted-foreground mb-1.5 truncate">{label}</label>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        disabled={disabled} tabIndex={disabled ? -1 : undefined}
        className={`w-full px-3 h-[50px] rounded-sm text-base bg-card border border-border text-foreground placeholder:text-muted-foreground/40 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${mono ? "font-mono text-xs" : ""}`} />
    </div>
  );
}
