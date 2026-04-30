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
type PhaseTiming = { startedAt: string; finishedAt?: string };
type JobSummary = {
  id: string;
  status: "pending" | "running" | "succeeded" | "failed";
  phase: string | null;
  phase_started_at: string | null;
  created: CreatedEntity[];
  error: string | null;
  code: string | null;
  raw_status: string | null;
  kept: Array<{ type: string; id: string; url: string }> | null;
  timings?: Record<string, PhaseTiming>;
  created_at: string;
  updated_at: string;
};

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

  // Dashboard data — loaded from /api/jobs.
  const [dashboardActive, setDashboardActive] = useState<JobSummary[]>([]);
  const [dashboardRecent, setDashboardRecent] = useState<JobSummary[]>([]);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  // The polling effect publishes its `refresh()` here so handleSubmit
  // can kick an immediate fetch right after enqueue (otherwise the user
  // waits up to the 30s idle interval before the dashboard reflects
  // their new job).
  const dashboardRefreshRef = useRef<(() => void) | null>(null);

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

  // Dashboard polling. Refresh every 5s while there's at least one
  // active job (tighter loop), every 30s otherwise. Stops when not
  // logged in.
  useEffect(() => {
    if (!loggedIn) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = async () => {
      if (cancelled) return;
      if (timer) { clearTimeout(timer); timer = null; }
      try {
        const res = await fetch("/api/jobs");
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        setDashboardActive(data.active ?? []);
        setDashboardRecent(data.recent ?? []);
        const nextDelay = (data.active?.length ?? 0) > 0 ? 5_000 : 30_000;
        timer = setTimeout(refresh, nextDelay);
      } catch {
        if (!cancelled) timer = setTimeout(refresh, 30_000);
      }
    };
    dashboardRefreshRef.current = refresh;
    refresh();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      dashboardRefreshRef.current = null;
    };
  }, [loggedIn]);

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
    // Phase-local progress clock. The server is authoritative: each
    // /api/jobs/:id poll reports the current `phase` and when it last
    // transitioned — we reset our local clock on phase change so the
    // UI snaps forward as soon as the server moves on.
    progressStartRef.current = performance.now();
    progressPhaseRef.current = doPartner ? "partner" : "customer";
    setProgress(computeProgress(0, progressPhaseRef.current, doPartner, doCustomer));
    if (progressTickRef.current) clearInterval(progressTickRef.current);
    progressTickRef.current = setInterval(() => {
      const elapsed = performance.now() - progressStartRef.current;
      setProgress(computeProgress(elapsed, progressPhaseRef.current, doPartner, doCustomer));
    }, 250);

    const applyServerPhase = (nextPhase: Phase | null, phaseStartedAtIso: string | null) => {
      if (!nextPhase) return;
      if (nextPhase === progressPhaseRef.current) return;
      progressPhaseRef.current = nextPhase;
      // Align local clock to server's phase-start wall time. Browser
      // and server clocks are close enough for our sub-second needs.
      const serverMs = phaseStartedAtIso ? new Date(phaseStartedAtIso).getTime() : Date.now();
      const elapsedInPhaseAtServer = Math.max(0, Date.now() - serverMs);
      progressStartRef.current = performance.now() - elapsedInPhaseAtServer;
      setProgress(computeProgress(elapsedInPhaseAtServer, nextPhase, doPartner, doCustomer));
    };

    const rolePayload = () => {
      if (isAdvanced) {
        const p: Record<string, string> = {};
        if (activePartner) p.partnerRole = partnerRole;
        if (activeCustomer) p.customerRole = customerRole;
        return p;
      }
      return { portalRole };
    };

    const idempotencyKey = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const pollIntervalMs = 2000;

    try {
      const enqueue = await fetch("/api/jobs/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-idempotency-key": idempotencyKey },
        body: JSON.stringify({
          partner: activePartner,
          customer: activeCustomer,
          portalId,
          ...rolePayload(),
        }),
      });
      const enqueueData = await enqueue.json();
      if (!enqueue.ok) {
        throw new Error(enqueueData.error || t("error.generic"));
      }
      const jobId = enqueueData.jobId as string;
      // Make the dashboard panel show the new running job immediately
      // (otherwise the user waits up to the 30s idle poll cycle).
      dashboardRefreshRef.current?.();

      // Poll until terminal. The `new Promise` shape lets us reject from
      // inside the inner setTimeout chain without wrapping the whole
      // handler in nested try/catch.
      const terminalJob = await new Promise<any>((resolve, reject) => {
        const pollOnce = async () => {
          try {
            const res = await fetch(`/api/jobs/${jobId}`);
            const data = await res.json();
            if (!res.ok) {
              reject(new Error(data.error || t("error.generic")));
              return;
            }
            applyServerPhase(data.phase as Phase | null, data.phase_started_at);
            if (data.status === "succeeded" || data.status === "failed") {
              resolve(data);
              return;
            }
            setTimeout(pollOnce, pollIntervalMs);
          } catch (e) {
            reject(e);
          }
        };
        pollOnce();
      });

      if (terminalJob.status === "failed") {
        const err = new Error(terminalJob.error || t("error.generic"));
        (err as any).code = terminalJob.code;
        (err as any).rawStatus = terminalJob.raw_status;
        (err as any).kept = terminalJob.kept;
        throw err;
      }

      setResults(terminalJob.created as CreatedEntity[]);
      setPartner(emptyCompany()); setCustomer(emptyCompany());
      // Pull the freshly-completed job into "recent" right away.
      dashboardRefreshRef.current?.();
      // Only fires when the tab is hidden — see lib/notifications.ts.
      const bodyKey: TranslationKey =
        doPartner && doCustomer ? "notify.success.body.both"
        : doPartner ? "notify.success.body.partner"
        : "notify.success.body.customer";
      notify({ title: t("notify.success.title"), body: t(bodyKey) });
    } catch (e: any) {
      const code = PORTAL_ERROR_CODES.includes(e.code) ? (e.code as PortalErrorCode) : undefined;
      const base = friendlyError(e.message, code);
      notify({ title: t("notify.error.title"), body: base });
      const withRaw = e.rawStatus
        ? `${base}\n\nHubSpot reported: ${e.rawStatus}`
        : base;
      const withKept = Array.isArray(e.kept) && e.kept.length > 0
        ? `${withRaw}\n\nKept in HubSpot for inspection:\n${e.kept.map((k: any) => `· ${String(k.type).replace(/_/g, " ")} → ${k.url}`).join("\n")}`
        : withRaw;
      setError(withKept);
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

  // Domain is required for both sides: see /api/jobs/create — without a
  // domain the downstream PRM sync can't dedup, and every webhook creates
  // a fresh Impartner Customer/Account.
  const isValid = isAdvanced
    ? (partnerEnabled ? partner.name && partner.domain.trim() && partner.contact.email : true) &&
      (customerEnabled ? customer.name && customer.domain.trim() && customer.contact.email : true) &&
      (partnerEnabled || customerEnabled)
    : partner.name && partner.domain.trim() && partner.contact.email &&
      customer.name && customer.domain.trim() && customer.contact.email;

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

  // When a job is in flight, point the dashboard's running row at the
  // live `progress` shape so it can render the existing
  // <ProgressIndicator> inline. Avoids two surfaces showing the same
  // progress (dashboard panel + inline block under the form).
  const liveProgressJobId = loading && dashboardActive.length > 0 ? dashboardActive[0].id : null;

  if (!loggedIn) {
    return (
      <main id="main-content" className="min-h-screen flex flex-col">
        <TopBar
          version={APP_VERSION}
          t={t}
          theme={theme}
          themeAriaKey={themeAriaKey}
          locale={locale}
          cycleTheme={cycleTheme}
          cycleLocale={cycleLocale}
          rightSlot={null}
        />
        <div className="flex-1 flex items-start justify-center px-4 py-16 md:py-24">
          <div className="w-full max-w-md">
            <div className="animate-in">
              <h1 className="text-3xl md:text-4xl font-bold tracking-tight font-heading text-card-foreground mb-3">
                {t("header.title")}
              </h1>
              <p className="text-sm text-muted-foreground leading-relaxed mb-8">
                {t("auth.connectDescription")}
              </p>
              <a href="/api/auth/install"
                className="block w-full min-h-[44px] py-3 rounded-md font-button font-semibold text-sm uppercase tracking-wide transition-colors text-center bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer">
                {t("auth.connect")}
              </a>
            </div>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main id="main-content" className="min-h-screen flex flex-col">
      <TopBar
        version={APP_VERSION}
        t={t}
        theme={theme}
        themeAriaKey={themeAriaKey}
        locale={locale}
        cycleTheme={cycleTheme}
        cycleLocale={cycleLocale}
        rightSlot={
          <UserPill
            email={userEmail}
            portalId={portalId}
            connected={t("auth.connected")}
            portal={t("auth.portal")}
            disconnect={t("auth.disconnect")}
            onSignOut={handleSignOut}
          />
        }
      />

      <div className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 lg:px-8 pt-8 pb-16">
        {/* Page intro */}
        <div className="animate-in mb-8">
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight font-heading text-card-foreground">
            {t("header.title")}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {t(subtitleKey)}
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Create form — primary action, ~66% on lg+ */}
          <section className="lg:col-span-2 order-1">
            <div className="animate-in">
              <CreateForm
                mode={mode}
                setMode={setMode}
                isAdvanced={isAdvanced}
                partner={partner}
                customer={customer}
                partnerEnabled={partnerEnabled}
                customerEnabled={customerEnabled}
                setPartnerEnabled={setPartnerEnabled}
                setCustomerEnabled={setCustomerEnabled}
                portalRole={portalRole}
                setPortalRole={setPortalRole}
                partnerRole={partnerRole}
                setPartnerRole={setPartnerRole}
                customerRole={customerRole}
                setCustomerRole={setCustomerRole}
                updatePartner={updatePartner}
                updatePartnerContact={updatePartnerContact}
                updateCustomer={updateCustomer}
                updateCustomerContact={updateCustomerContact}
                handleRandomize={handleRandomize}
                onSubmit={handleSubmit}
                isValid={!!isValid}
                loading={loading}
                cooldown={cooldown}
                submitLabel={submitLabel}
                error={error}
                t={t}
              />
            </div>
          </section>

          {/* Dashboard — observation surface, ~33% on lg+ */}
          <aside className="lg:col-span-1 order-2">
            <div className="animate-in">
              <DashboardPanel
                active={dashboardActive}
                recent={dashboardRecent}
                expandedJobId={expandedJobId}
                setExpandedJobId={setExpandedJobId}
                liveProgressJobId={liveProgressJobId}
                liveProgress={progress}
                t={t}
              />
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}

/* --- Components --- */

type TFunc = (key: TranslationKey, vars?: Record<string, string | number>) => string;

function TopBar({
  version, t, theme, themeAriaKey, locale, cycleTheme, cycleLocale, rightSlot,
}: {
  version: string;
  t: TFunc;
  theme: Theme;
  themeAriaKey: TranslationKey;
  locale: string;
  cycleTheme: () => void;
  cycleLocale: () => void;
  rightSlot: React.ReactNode;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-border dark:border-white/10 bg-background dark:bg-zinc-950">
      <div className="max-w-6xl mx-auto h-14 px-4 sm:px-6 lg:px-8 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="text-sm font-semibold tracking-tight text-foreground">
            {t("header.appName")}
          </span>
          <span className="text-xs font-mono text-muted-foreground/70 hidden sm:inline">v{version}</span>
        </div>
        <div className="flex items-center gap-2">
          {rightSlot}
          <div className="hidden sm:flex items-center gap-1.5 ml-1">
            <LanguageSelector locale={locale} onCycle={cycleLocale} ariaLabel={t("language.switch")} />
            <ThemeToggle theme={theme} onCycle={cycleTheme} ariaLabel={t(themeAriaKey)} />
          </div>
        </div>
      </div>
    </header>
  );
}

function UserPill({
  email, portalId, connected, portal, disconnect, onSignOut,
}: {
  email: string | null;
  portalId: string | null;
  connected: string;
  portal: string;
  disconnect: string;
  onSignOut: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-sm bg-card border border-border">
      <div className="w-1.5 h-1.5 rounded-sm bg-success shrink-0" />
      <span className="text-xs font-mono text-muted-foreground hidden sm:inline truncate max-w-[200px]">
        {email || connected}
        {portalId ? ` · ${portal} ${portalId}` : ""}
      </span>
      <span className="text-xs font-mono text-muted-foreground sm:hidden">
        {portalId ? portalId : connected}
      </span>
      <button onClick={onSignOut}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer pl-2 border-l border-border dark:border-white/10"
        aria-label={disconnect}>
        {disconnect}
      </button>
    </div>
  );
}

function DashboardPanel({
  active, recent, expandedJobId, setExpandedJobId, liveProgressJobId, liveProgress, t,
}: {
  active: JobSummary[];
  recent: JobSummary[];
  expandedJobId: string | null;
  setExpandedJobId: (id: string | null) => void;
  liveProgressJobId: string | null;
  liveProgress: Progress | null;
  t: TFunc;
}) {
  if (active.length === 0 && recent.length === 0) {
    return (
      <div className="rounded-md border border-border dark:border-white/10 p-6">
        <p className="text-sm text-muted-foreground">{t("dashboard.empty")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {active.length > 0 && (
        <div>
          <SectionLabel
            label={t("dashboard.active")}
            count={active.length}
            indicator={null}
          />
          <div className="space-y-2">
            {active.map(j => (
              <JobRow
                key={j.id}
                job={j}
                expanded={expandedJobId === j.id || j.id === liveProgressJobId}
                onToggle={() => setExpandedJobId(expandedJobId === j.id ? null : j.id)}
                liveProgress={j.id === liveProgressJobId ? liveProgress : null}
                t={t}
              />
            ))}
          </div>
        </div>
      )}
      {recent.length > 0 && (
        <div>
          <SectionLabel label={t("dashboard.recent")} count={recent.length} />
          <div className="space-y-2">
            {recent.slice(0, 10).map(j => (
              <JobRow
                key={j.id}
                job={j}
                expanded={expandedJobId === j.id}
                onToggle={() => setExpandedJobId(expandedJobId === j.id ? null : j.id)}
                liveProgress={null}
                t={t}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SectionLabel({ label, count, indicator }: { label: string; count?: number; indicator?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-2 px-1">
      {indicator}
      <span className="text-xs font-medium text-muted-foreground">
        {label}{typeof count === "number" ? ` (${count})` : ""}
      </span>
    </div>
  );
}

function CreateForm(props: {
  mode: Mode | null;
  setMode: (m: Mode) => void;
  isAdvanced: boolean;
  partner: CompanyFields;
  customer: CompanyFields;
  partnerEnabled: boolean;
  customerEnabled: boolean;
  setPartnerEnabled: (b: boolean) => void;
  setCustomerEnabled: (b: boolean) => void;
  portalRole: string;
  setPortalRole: (s: string) => void;
  partnerRole: string;
  setPartnerRole: (s: string) => void;
  customerRole: string;
  setCustomerRole: (s: string) => void;
  updatePartner: (p: Partial<CompanyFields>) => void;
  updatePartnerContact: (p: Partial<ContactFields>) => void;
  updateCustomer: (c: Partial<CompanyFields>) => void;
  updateCustomerContact: (p: Partial<ContactFields>) => void;
  handleRandomize: (role: "partner" | "customer") => void;
  onSubmit: () => void;
  isValid: boolean;
  loading: boolean;
  cooldown: number;
  submitLabel: string;
  error: string | null;
  t: TFunc;
}) {
  const {
    mode, setMode, isAdvanced, partner, customer, partnerEnabled, customerEnabled,
    setPartnerEnabled, setCustomerEnabled, portalRole, setPortalRole, partnerRole, setPartnerRole,
    customerRole, setCustomerRole, updatePartner, updatePartnerContact, updateCustomer,
    updateCustomerContact, handleRandomize, onSubmit, isValid, loading, cooldown, submitLabel, error, t,
  } = props;

  return (
    <div className="rounded-md border border-border dark:border-white/10 bg-card overflow-hidden">
      {/* Header strip */}
      <div className="px-5 py-4 border-b border-border dark:border-white/10 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-tight font-heading text-card-foreground">
          {t("create.title")}
        </h2>
        {mode && (
          <SegmentedControl
            value={mode}
            onChange={setMode}
            disabled={loading}
            options={[
              { value: "simple" as Mode, label: t("mode.simple") },
              { value: "advanced" as Mode, label: t("mode.advanced") },
            ]}
            compact
          />
        )}
      </div>

      <div className="p-5 space-y-5">
        {/* Role (simple mode shows shared role here; advanced mode tucks role into each side) */}
        {!isAdvanced && (
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              {t("role.label")}
            </label>
            <select value={portalRole} onChange={(e) => setPortalRole(e.target.value)}
              className="w-full px-3 h-10 rounded-md text-sm bg-background border border-border text-foreground transition-colors hover:border-accent focus:border-accent focus:outline-none cursor-pointer">
              <option value="Admin-RW">{t("role.admin")}</option>
              <option value="User-RW">{t("role.rw")}</option>
              <option value="User-RO">{t("role.ro")}</option>
            </select>
          </div>
        )}

        <SidePanel
          title={t("partner.title")}
          badge={t("partner.badge")}
          showCheckbox={isAdvanced}
          checked={partnerEnabled}
          onCheckedChange={setPartnerEnabled}
          enableLabel={`${t("entity.enable")} ${t("partner.title")}`}
          actionSlot={
            (!isAdvanced || partnerEnabled) ? (
              <button onClick={() => handleRandomize("partner")} type="button"
                className="text-xs px-2 py-1 rounded-md bg-muted/40 border border-border text-muted-foreground hover:text-foreground hover:border-accent transition-colors cursor-pointer">
                {t("entity.randomize")}
              </button>
            ) : null
          }
          roleSlot={isAdvanced ? <RoleSelect value={partnerRole} onChange={setPartnerRole} disabled={!partnerEnabled} t={t} /> : null}
          disabled={isAdvanced && !partnerEnabled}
        >
          <EntityFields company={partner} onCompanyChange={updatePartner} onContactChange={updatePartnerContact}
            disabled={isAdvanced && !partnerEnabled} t={t} namePlaceholder="Acme Corp" domainPlaceholder="acme.com" />
        </SidePanel>

        <SidePanel
          title={t("customer.title")}
          badge={t("customer.badge")}
          showCheckbox={isAdvanced}
          checked={customerEnabled}
          onCheckedChange={setCustomerEnabled}
          enableLabel={`${t("entity.enable")} ${t("customer.title")}`}
          actionSlot={
            (!isAdvanced || customerEnabled) ? (
              <button onClick={() => handleRandomize("customer")} type="button"
                className="text-xs px-2 py-1 rounded-md bg-muted/40 border border-border text-muted-foreground hover:text-foreground hover:border-accent transition-colors cursor-pointer">
                {t("entity.randomize")}
              </button>
            ) : null
          }
          roleSlot={isAdvanced ? <RoleSelect value={customerRole} onChange={setCustomerRole} disabled={!customerEnabled} t={t} /> : null}
          disabled={isAdvanced && !customerEnabled}
        >
          <EntityFields company={customer} onCompanyChange={updateCustomer} onContactChange={updateCustomerContact}
            disabled={isAdvanced && !customerEnabled} t={t} namePlaceholder="Widget Inc" domainPlaceholder="widget.io" />
        </SidePanel>

        {isAdvanced && (
          <div className="flex items-center gap-2 px-1">
            <div className={`w-1.5 h-1.5 rounded-sm ${partnerEnabled && customerEnabled ? "bg-success" : "bg-muted-foreground"}`} />
            <span className={`text-xs ${partnerEnabled && customerEnabled ? "text-success" : "text-muted-foreground"}`}>
              {partnerEnabled && customerEnabled ? t("association.willCreate") : t("association.singleEntity")}
            </span>
          </div>
        )}

        <button onClick={onSubmit} disabled={!isValid || loading || cooldown > 0}
          className="w-full min-h-[44px] py-2.5 rounded-md font-button font-semibold text-sm uppercase tracking-wide transition-colors bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer">
          {loading ? t("submit.creating") : cooldown > 0 ? t("submit.retryIn", { seconds: cooldown }) : submitLabel}
        </button>

        {error && (
          <div className="p-3 rounded-md bg-destructive/10 border border-destructive/20" role="alert">
            <p className="text-xs text-destructive font-mono whitespace-pre-wrap break-words leading-relaxed">{error}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function SidePanel({
  title, badge, showCheckbox, checked, onCheckedChange, enableLabel,
  actionSlot, roleSlot, disabled, children,
}: {
  title: string;
  badge?: string;
  showCheckbox?: boolean;
  checked?: boolean;
  onCheckedChange?: (c: boolean) => void;
  enableLabel?: string;
  actionSlot?: React.ReactNode;
  roleSlot?: React.ReactNode;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-md border ${disabled ? "border-border dark:border-white/10 opacity-60" : "border-border dark:border-white/10"} bg-background/40 transition-colors`}
      aria-disabled={disabled || undefined}>
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-border dark:border-white/10">
        <div className="flex items-center gap-2 min-w-0">
          {showCheckbox ? (
            <input type="checkbox" checked={checked} onChange={(e) => onCheckedChange?.(e.target.checked)}
              className="w-3.5 h-3.5 rounded accent-primary cursor-pointer" aria-label={enableLabel || `Enable ${title}`} />
          ) : (
            <div className="w-1.5 h-1.5 rounded-sm bg-accent" />
          )}
          <span className="text-xs font-semibold tracking-tight font-heading text-card-foreground truncate">{title}</span>
          {badge && <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border hidden sm:inline">{badge}</span>}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {roleSlot}
          {actionSlot}
        </div>
      </div>
      <div className={`p-4 ${disabled ? "pointer-events-none" : ""}`}>{children}</div>
    </div>
  );
}

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
      className="mt-4 px-3 py-3 rounded-md bg-muted/50 border border-border"
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
                className={`w-1.5 h-1.5 rounded-sm transition-colors ${
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
            <div className="w-3 h-3 rounded-sm bg-primary animate-pulse" />
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
          <span className="text-xs font-medium text-muted-foreground mb-2 block">{t("results.partner")}</span>
          <div className="space-y-2">{partnerResults.map((r, i) => <ResultRow key={i} entity={r} />)}</div>
        </div>
      )}
      {customerResults.length > 0 && (
        <div>
          <span className="text-xs font-medium text-muted-foreground mb-2 block">{t("results.customer")}</span>
          <div className="space-y-2">{customerResults.map((r, i) => <ResultRow key={i} entity={r} />)}</div>
        </div>
      )}
      <div className="flex items-center gap-2 pt-2">
        <div className={`w-1.5 h-1.5 rounded-sm ${associationResult ? "bg-success" : "bg-muted-foreground"}`} />
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
      className="flex items-center justify-between p-3 rounded-md bg-card border border-border hover:border-accent hover:shadow-md transition-all group cursor-pointer">
      <div>
        <span className="text-xs font-mono text-muted-foreground uppercase">{entity.type}</span>
        <p className="text-sm font-medium">{entity.name}</p>
      </div>
      <span className="text-xs font-mono text-muted-foreground group-hover:text-accent transition-colors">{entity.id} &rarr;</span>
    </a>
  );
}

function statusDot(status: JobSummary["status"]): string {
  if (status === "succeeded") return "bg-success";
  if (status === "failed") return "bg-destructive";
  if (status === "running") return "bg-primary animate-pulse";
  return "bg-muted-foreground";
}

function relativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// Compact "1m 30s" / "12s" / "1h 4m" formatter for elapsed durations.
function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalS = Math.round(ms / 1000);
  if (totalS < 60) return `${totalS}s`;
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// For an active phase the finishedAt isn't set yet — measure against now.
function phaseElapsedMs(timing: PhaseTiming, now = Date.now()): number {
  const start = new Date(timing.startedAt).getTime();
  const end = timing.finishedAt ? new Date(timing.finishedAt).getTime() : now;
  return end - start;
}

// Wall-clock duration of the whole job. Falls back to (now - created_at)
// when the job is still running so the UI can tick the elapsed counter.
function totalDurationMs(job: JobSummary, now = Date.now()): number {
  const start = new Date(job.created_at).getTime();
  const end = job.status === "succeeded" || job.status === "failed"
    ? new Date(job.updated_at).getTime()
    : now;
  return end - start;
}

function PhaseTimingsTable({ timings, t }: { timings: Record<string, PhaseTiming>; t: TFunc }) {
  const order: Array<"partner" | "customer" | "associate"> = ["partner", "customer", "associate"];
  const present = order.filter(p => timings[p]);
  if (present.length === 0) return null;
  const labelOf = (p: string): string => {
    if (p === "partner") return t("partner.title");
    if (p === "customer") return t("customer.title");
    if (p === "associate") return t("dashboard.phase.associate");
    return p;
  };
  return (
    <div className="pt-3 grid grid-cols-2 gap-x-4 gap-y-1">
      {present.map(p => {
        const tg = timings[p];
        const ms = phaseElapsedMs(tg);
        const inFlight = !tg.finishedAt;
        return (
          <div key={p} className="flex items-center justify-between text-xs">
            <span className={`font-mono ${inFlight ? "text-primary" : "text-muted-foreground"}`}>
              {labelOf(p)}
              {inFlight && <span className="ml-1 text-[10px] uppercase tracking-wider">live</span>}
            </span>
            <span className="font-mono tabular-nums text-foreground">{formatDuration(ms)}</span>
          </div>
        );
      })}
    </div>
  );
}

function StatusPill({ status }: { status: JobSummary["status"] }) {
  const styles: Record<JobSummary["status"], string> = {
    pending: "bg-muted text-muted-foreground border-border",
    running: "bg-primary/15 text-primary border-primary/30",
    succeeded: "bg-success/15 text-success border-success/30",
    failed: "bg-destructive/10 text-destructive border-destructive/30",
  };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm border text-[10px] font-mono uppercase tracking-wider shrink-0 ${styles[status]}`}>
      {status === "running" && <span className="w-1 h-1 rounded-sm bg-current animate-pulse" />}
      {status}
    </span>
  );
}

function JobRow({ job, expanded, onToggle, liveProgress, t }: {
  job: JobSummary;
  expanded: boolean;
  onToggle: () => void;
  liveProgress: Progress | null;
  t: TFunc;
}) {
  const summary = job.created.length > 0
    ? job.created.map(c => c.name).slice(0, 2).join(" · ") + (job.created.length > 2 ? ` +${job.created.length - 2}` : "")
    : job.status === "failed"
      ? (job.error?.split("\n")[0]?.slice(0, 80) ?? "—")
      : job.status === "running"
        ? t(("poll.stage." + ({
            partner: "creatingPartnerCompany",
            customer: "creatingCustomerCompany",
            associate: "associating",
          }[job.phase ?? ""] ?? "creatingPartnerCompany")) as TranslationKey)
        : t("dashboard.queued");
  const isActive = job.status === "running" || job.status === "pending";
  return (
    <div className={`rounded-md border overflow-hidden transition-colors ${
      isActive ? "border-primary/30 bg-card" : "border-border bg-card hover:border-accent"
    }`}>
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-3 px-3.5 py-3 text-left cursor-pointer hover:bg-muted/30 transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <StatusPill status={job.status} />
          <div className="min-w-0 flex-1">
            <div className="text-sm text-foreground truncate">{summary}</div>
            {job.phase && isActive && (
              <div className="text-xs text-muted-foreground mt-0.5">
                {t(("poll.stage." + ({
                  partner: "creatingPartnerCompany",
                  customer: "creatingCustomerCompany",
                  associate: "associating",
                }[job.phase] ?? "associating")) as TranslationKey)}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex flex-col items-end leading-tight">
            <span className="text-[11px] font-mono text-muted-foreground">{relativeAge(job.created_at)}</span>
            <span className="text-[10px] font-mono text-muted-foreground/70 tabular-nums">
              {formatDuration(totalDurationMs(job))}
            </span>
          </div>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round"
            className={`text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`}
            aria-hidden="true"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </button>
      {expanded && (
        <div className="px-3.5 pb-3.5 border-t border-border bg-muted/20 space-y-3">
          {liveProgress && (
            <div className="pt-3">
              <ProgressIndicator progress={liveProgress} t={t} />
            </div>
          )}
          {job.timings && Object.keys(job.timings).length > 0 && (
            <PhaseTimingsTable timings={job.timings} t={t} />
          )}
          {job.created.length > 0 && (
            <div className="pt-3 space-y-2">
              {job.created.map((e, i) => <ResultRow key={i} entity={e} />)}
            </div>
          )}
          {job.error && (
            <div className="p-3 rounded-md bg-destructive/10 border border-destructive/20">
              <p className="text-xs text-destructive font-mono whitespace-pre-wrap break-words leading-relaxed">
                {job.error}
                {job.raw_status ? `\n\nHubSpot: ${job.raw_status}` : ""}
              </p>
            </div>
          )}
          {job.kept && job.kept.length > 0 && (
            <div>
              <span className="text-xs font-medium text-muted-foreground mb-2 block">
                {t("dashboard.kept")}
              </span>
              <div className="space-y-1">
                {job.kept.map((k, i) => (
                  <a key={i} href={k.url} target="_blank" rel="noopener noreferrer"
                    className="block text-xs font-mono text-muted-foreground hover:text-accent transition-colors truncate cursor-pointer">
                    {String(k.type).replace(/_/g, " ")} → {k.url}
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EntityFields({ company, onCompanyChange, onContactChange, disabled, t, namePlaceholder, domainPlaceholder }: {
  company: CompanyFields; onCompanyChange: (p: Partial<CompanyFields>) => void; onContactChange: (p: Partial<ContactFields>) => void;
  disabled?: boolean; t: TFunc; namePlaceholder: string; domainPlaceholder: string;
}) {
  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 gap-2.5">
        <Input label={t("form.companyName")} value={company.name} onChange={(v) => onCompanyChange({ name: v })} placeholder={namePlaceholder} disabled={disabled} />
        <Input label={t("form.domain")} value={company.domain} onChange={(v) => onCompanyChange({ domain: v })} placeholder={domainPlaceholder} disabled={disabled} />
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <Input label={t("form.firstName")} value={company.contact.firstname} onChange={(v) => onContactChange({ firstname: v })} disabled={disabled} />
        <Input label={t("form.lastName")} value={company.contact.lastname} onChange={(v) => onContactChange({ lastname: v })} disabled={disabled} />
      </div>
      <Input label={t("form.email")} value={company.contact.email} onChange={(v) => onContactChange({ email: v })} type="email" mono disabled={disabled} />
    </div>
  );
}

function SegmentedControl<T extends string>({ value, onChange, options, disabled, compact }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; disabled?: boolean; compact?: boolean;
}) {
  const buttonH = compact ? "h-7" : "min-h-[44px]";
  const wrapW = compact ? "" : "w-full";
  return (
    <div className={`flex ${wrapW} rounded-md bg-muted p-0.5 ${disabled ? "opacity-50 pointer-events-none" : ""}`} role="radiogroup" aria-label="Mode selection">
      {options.map((opt) => (
        <button key={opt.value} role="radio" aria-checked={value === opt.value} onClick={() => onChange(opt.value)} disabled={disabled}
          className={`${buttonH} px-3 rounded font-button text-[10px] uppercase tracking-wider transition-colors cursor-pointer ${
            value === opt.value ? "bg-card border border-border text-foreground" : "text-muted-foreground hover:text-foreground"
          } ${compact ? "" : "flex-1"}`}>
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function RoleSelect({ value, onChange, disabled, t }: { value: string; onChange: (v: string) => void; disabled?: boolean; t: TFunc }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}
      className="h-7 px-2 text-[10px] font-mono uppercase tracking-wider rounded-md bg-muted border border-border text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer hover:border-accent focus:border-accent focus:outline-none">
      <option value="Admin-RW">{t("role.admin")}</option>
      <option value="User-RW">{t("role.rw")}</option>
      <option value="User-RO">{t("role.ro")}</option>
    </select>
  );
}

function LanguageSelector({ locale, onCycle, ariaLabel }: { locale: string; onCycle: () => void; ariaLabel: string }) {
  return (
    <button onClick={onCycle} aria-label={ariaLabel} title={ariaLabel}
      className="h-8 px-2 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer">
      <span className="text-[11px] font-mono font-semibold uppercase tracking-wider">{locale}</span>
    </button>
  );
}

function ThemeToggle({ theme, onCycle, ariaLabel }: { theme: Theme; onCycle: () => void; ariaLabel: string }) {
  return (
    <button onClick={onCycle} aria-label={ariaLabel} title={ariaLabel}
      className="h-8 w-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer">
      {theme === "dark" ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
      ) : theme === "light" ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" /></svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2" ry="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></svg>
      )}
    </button>
  );
}

function Input({ label, value, onChange, type = "text", placeholder, mono, disabled }: {
  label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string; mono?: boolean; disabled?: boolean;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-muted-foreground mb-1">{label}</label>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        disabled={disabled} tabIndex={disabled ? -1 : undefined}
        className={`w-full px-3 h-9 rounded-md text-sm bg-background border border-border text-foreground placeholder:text-muted-foreground/40 transition-colors hover:border-accent focus:border-accent focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed ${mono ? "font-mono text-xs" : ""}`} />
    </div>
  );
}
