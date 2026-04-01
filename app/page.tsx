"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { faker } from "@faker-js/faker/locale/de";

type ContactFields = {
  firstname: string;
  lastname: string;
  email: string;
};

type CompanyFields = {
  name: string;
  domain: string;
  contact: ContactFields;
};

type CreatedEntity = {
  type: string;
  id: string;
  name: string;
  url: string;
};

const emptyContact = (): ContactFields => ({ firstname: "", lastname: "", email: "" });
const emptyCompany = (): CompanyFields => ({
  name: "",
  domain: "",
  contact: emptyContact(),
});

const APP_VERSION = "1.0.0";

type Mode = "simple" | "advanced";

function generateRandomCompany(userEmail: string | null, role: "partner" | "customer"): CompanyFields {
  const first = faker.person.firstName();
  const last = faker.person.lastName();
  const companyName = faker.company.name();
  const slug = faker.string.alphanumeric(4);
  const domain = `${faker.helpers.slugify(companyName).toLowerCase()}-${slug}.test`;

  const tag = `${faker.helpers.slugify(companyName).toLowerCase()}-${role}-${slug}`;
  let contactEmail: string;
  if (userEmail && userEmail.includes("@")) {
    const [localPart, domainPart] = userEmail.split("@");
    contactEmail = `${localPart}+${tag}@${domainPart}`;
  } else {
    contactEmail = `${first.toLowerCase()}.${last.toLowerCase()}+${tag}@example.com`;
  }

  return {
    name: companyName,
    domain,
    contact: {
      firstname: first,
      lastname: last,
      email: contactEmail,
    },
  };
}

type Theme = "system" | "light" | "dark";

function useTheme() {
  const [theme, setThemeState] = useState<Theme>("system");

  useEffect(() => {
    const stored = localStorage.getItem("theme") as Theme | null;
    if (stored === "light" || stored === "dark") {
      setThemeState(stored);
    }
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    const html = document.documentElement;
    html.classList.remove("dark", "light");
    if (t === "dark") {
      html.classList.add("dark");
      localStorage.setItem("theme", "dark");
    } else if (t === "light") {
      html.classList.add("light");
      localStorage.setItem("theme", "light");
    } else {
      localStorage.removeItem("theme");
    }
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
    if (m === "advanced") {
      localStorage.setItem("hint-dismissed", "true");
    }
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

  const { theme, cycle: cycleTheme } = useTheme();
  const { mode, setMode } = useMode();

  const [hintDismissed, setHintDismissed] = useState(true);
  useEffect(() => {
    setHintDismissed(localStorage.getItem("hint-dismissed") === "true");
  }, []);

  const isAdvanced = mode === "advanced";

  useEffect(() => {
    return () => { if (cooldownRef.current) clearInterval(cooldownRef.current); };
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

  const handleSignOut = () => {
    window.location.href = "/api/auth/logout";
  };

  const handleStartOver = () => {
    setPartner(emptyCompany());
    setCustomer(emptyCompany());
    setPartnerRole("User-RO");
    setCustomerRole("User-RO");
    setPortalRole("User-RO");
    setPartnerEnabled(true);
    setCustomerEnabled(true);
    setResults(null);
    setError(null);
  };

  const handleRandomize = (role: "partner" | "customer") => {
    const company = generateRandomCompany(userEmail, role);
    if (role === "partner") setPartner(company);
    else setCustomer(company);
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

  const friendlyError = (msg: string): string => {
    if (msg.includes("Not authenticated") || msg.includes("expired"))
      return "Your HubSpot session has expired. Please reconnect.";
    if (msg.includes("502") || msg.includes("Bad Gateway"))
      return "HubSpot is temporarily unreachable (502). This is on their end — please try again in a moment.";
    if (msg.includes("503") || msg.includes("Service Unavailable"))
      return "HubSpot is temporarily unavailable (503). Please try again shortly.";
    if (msg.includes("429") || msg.includes("rate limit"))
      return "Too many requests — HubSpot rate limit hit. Please wait before retrying.";
    if (msg.includes("non-JSON"))
      return "HubSpot returned an unexpected response. Their API may be experiencing issues — try again shortly.";
    return msg;
  };

  const handleSubmit = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    setResults(null);

    const activePartner = isAdvanced && !partnerEnabled ? null : partner;
    const activeCustomer = isAdvanced && !customerEnabled ? null : customer;

    try {
      const idempotencyKey = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const payload: Record<string, any> = {
        partner: activePartner,
        customer: activeCustomer,
        portalId,
      };

      if (isAdvanced) {
        if (activePartner) payload.partnerRole = partnerRole;
        if (activeCustomer) payload.customerRole = customerRole;
      } else {
        payload.portalRole = portalRole;
      }

      const res = await fetch("/api/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong");
      setResults(data.created);
      setPartner(emptyCompany());
      setCustomer(emptyCompany());
    } catch (e: any) {
      setError(friendlyError(e.message));
      startCooldown();
    } finally {
      setLoading(false);
    }
  };

  const updatePartner = (patch: Partial<CompanyFields>) =>
    setPartner((p) => ({ ...p, ...patch }));
  const updatePartnerContact = (patch: Partial<ContactFields>) =>
    setPartner((p) => ({ ...p, contact: { ...p.contact, ...patch } }));
  const updateCustomer = (patch: Partial<CompanyFields>) =>
    setCustomer((c) => ({ ...c, ...patch }));
  const updateCustomerContact = (patch: Partial<ContactFields>) =>
    setCustomer((c) => ({ ...c, contact: { ...c.contact, ...patch } }));

  const isValid = isAdvanced
    ? (partnerEnabled ? partner.name && partner.contact.email : true) &&
      (customerEnabled ? customer.name && customer.contact.email : true) &&
      (partnerEnabled || customerEnabled)
    : partner.name && partner.contact.email && customer.name && customer.contact.email;

  const submitLabel = isAdvanced
    ? partnerEnabled && customerEnabled
      ? "Create partner + customer"
      : partnerEnabled
        ? "Create partner"
        : customerEnabled
          ? "Create customer"
          : "Create entities"
    : "Create all entities";

  const subtitleText = isAdvanced
    ? partnerEnabled && customerEnabled
      ? "Creates selected entities and links them with a Parent Company association."
      : "Creates a single entity (company + contact)."
    : "Creates a partner company + contact, a customer company + contact, and links them with a Parent Company association.";

  if (authLoading || mode === null) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading...</p>
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
                HubSpot Entity Creator · v{APP_VERSION}
              </span>
            </div>
            <ThemeToggle theme={theme} onCycle={cycleTheme} />
          </div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight font-heading text-card-foreground">
            Create test entities
          </h1>
          <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
            {subtitleText}
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
                { value: "simple", label: "Simple" },
                { value: "advanced", label: "Advanced" },
              ]}
            />
          </div>
        )}

        {/* Auth */}
        {!loggedIn ? (
          <div className="animate-in animate-in-delay-1">
            <Section title="Connect to HubSpot">
              <p className="text-sm text-muted-foreground mb-4">
                Sign in with your HubSpot account to get started. This grants
                the tool permission to create entities in your portal.
              </p>
              <a
                href="/api/auth/install"
                className="block w-full min-h-[44px] py-2.5 rounded-pill font-button font-semibold text-sm uppercase tracking-wide transition-all text-center
                  bg-primary text-primary-foreground hover:opacity-90"
              >
                Connect to HubSpot
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
                  {userEmail || "Connected"}
                  {portalId ? ` · Portal ${portalId}` : ""}
                </span>
              </div>
              <button
                onClick={handleSignOut}
                className="text-xs font-button min-h-[44px] text-muted-foreground hover:text-foreground transition-colors"
              >
                Disconnect
              </button>
            </div>

            {/* Partner */}
            <div className="animate-in animate-in-delay-1">
              <Section
                title="Partner"
                badge="type = PARTNER"
                showCheckbox={isAdvanced}
                checked={partnerEnabled}
                onCheckedChange={setPartnerEnabled}
                disabled={!partnerEnabled && isAdvanced}
                action={
                  <div className="flex flex-wrap items-center gap-2">
                    {isAdvanced && (
                      <RoleSelect
                        value={partnerRole}
                        onChange={setPartnerRole}
                        disabled={!partnerEnabled}
                      />
                    )}
                    {(!isAdvanced || partnerEnabled) && (
                      <button
                        onClick={() => handleRandomize("partner")}
                        className="text-xs px-2.5 py-1 rounded-md font-button min-h-[44px] font-medium transition-all
                          bg-muted border border-border
                          text-muted-foreground hover:text-foreground hover:border-accent"
                      >
                        Randomize
                      </button>
                    )}
                  </div>
                }
              >
                <EntityFields
                  company={partner}
                  onCompanyChange={updatePartner}
                  onContactChange={updatePartnerContact}
                  disabled={isAdvanced && !partnerEnabled}
                  namePlaceholder="Acme Corp"
                  domainPlaceholder="acme.com"
                />
              </Section>
            </div>

            {/* Customer */}
            <div className="animate-in animate-in-delay-2">
              <Section
                title="Customer"
                badge="type = CUSTOMER"
                showCheckbox={isAdvanced}
                checked={customerEnabled}
                onCheckedChange={setCustomerEnabled}
                disabled={!customerEnabled && isAdvanced}
                action={
                  <div className="flex flex-wrap items-center gap-2">
                    {isAdvanced && (
                      <RoleSelect
                        value={customerRole}
                        onChange={setCustomerRole}
                        disabled={!customerEnabled}
                      />
                    )}
                    {(!isAdvanced || customerEnabled) && (
                      <button
                        onClick={() => handleRandomize("customer")}
                        className="text-xs px-2.5 py-1 rounded-md font-button min-h-[44px] font-medium transition-all
                          bg-muted border border-border
                          text-muted-foreground hover:text-foreground hover:border-accent"
                      >
                        Randomize
                      </button>
                    )}
                  </div>
                }
              >
                <EntityFields
                  company={customer}
                  onCompanyChange={updateCustomer}
                  onContactChange={updateCustomerContact}
                  disabled={isAdvanced && !customerEnabled}
                  namePlaceholder="Widget Inc"
                  domainPlaceholder="widget.io"
                />
              </Section>
            </div>

            {/* Portal Role (Simple mode only) */}
            {!isAdvanced && (
              <div className="animate-in animate-in-delay-3">
                <Section title="Portal Role">
                  <div>
                    <label className="block text-sm font-medium text-muted-foreground mb-1.5">
                      Role assigned to both contacts
                    </label>
                    <select
                      value={portalRole}
                      onChange={(e) => setPortalRole(e.target.value)}
                      className="w-full px-3 h-[50px] rounded-sm text-base
                        bg-card border border-border
                        text-foreground transition-colors"
                    >
                      <option value="Admin-RW">Administrator</option>
                      <option value="User-RW">User - Read &amp; Write</option>
                      <option value="User-RO">User - Read Only</option>
                    </select>
                  </div>
                </Section>
              </div>
            )}

            {/* Association Status Indicator (Advanced mode) */}
            {isAdvanced && (
              <div className="animate-in flex items-center gap-2 mb-4 px-1">
                <div className={`w-1.5 h-1.5 rounded-full ${
                  partnerEnabled && customerEnabled ? "bg-success" : "bg-muted-foreground"
                }`} />
                <span className={`text-xs font-mono ${
                  partnerEnabled && customerEnabled ? "text-success" : "text-muted-foreground"
                }`}>
                  {partnerEnabled && customerEnabled
                    ? "Partner-Customer association will be created"
                    : "No association — single entity mode"}
                </span>
              </div>
            )}

            {/* First-visit hint */}
            {!isAdvanced && !hintDismissed && (
              <div className="animate-in flex items-center justify-between mb-4 px-3 py-2 rounded-lg bg-muted border border-border">
                <span className="text-xs text-muted-foreground">
                  Need to create just one entity? Try Advanced mode.
                </span>
                <button
                  onClick={() => {
                    setHintDismissed(true);
                    localStorage.setItem("hint-dismissed", "true");
                  }}
                  className="text-xs font-button min-h-[44px] text-muted-foreground hover:text-foreground transition-colors ml-2"
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* Submit */}
            <button
              onClick={handleSubmit}
              disabled={!isValid || loading || cooldown > 0}
              className="w-full min-h-[44px] py-3 rounded-pill font-button font-semibold text-sm uppercase tracking-wide transition-all
                bg-primary text-primary-foreground hover:opacity-90
                disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {loading
                ? "Creating entities..."
                : cooldown > 0
                  ? `Retry in ${cooldown}s`
                  : submitLabel}
            </button>

            {/* Error */}
            {error && (
              <div className="mt-4 p-4 rounded-lg bg-destructive/10 border border-destructive/20" role="alert">
                <p className="text-sm text-destructive font-mono">{error}</p>
              </div>
            )}

            {/* Results */}
            {results && (
              <div className="mt-6 animate-in">
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-success" />
                  <span className="text-xs font-mono uppercase tracking-widest text-success">
                    Created successfully
                  </span>
                </div>
                <ResultsDisplay results={results} />
                <button
                  onClick={handleStartOver}
                  className="mt-6 w-full min-h-[44px] py-3 rounded-pill font-button font-semibold text-sm uppercase tracking-wide transition-all
                    bg-muted border border-border
                    text-foreground hover:border-accent"
                >
                  Start over
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}

/* Reusable components */

function ResultsDisplay({ results }: { results: CreatedEntity[] }) {
  const partnerResults = results.filter(r => r.type.startsWith("Partner"));
  const customerResults = results.filter(r => r.type.startsWith("Customer"));
  const associationResult = results.find(r => r.type === "Association");
  const hasPartner = partnerResults.length > 0;
  const hasCustomer = customerResults.length > 0;

  return (
    <div className="space-y-4">
      {hasPartner && (
        <div>
          <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-2 block">
            Partner
          </span>
          <div className="space-y-2">
            {partnerResults.map((r, i) => (
              <ResultRow key={i} entity={r} />
            ))}
          </div>
        </div>
      )}
      {hasCustomer && (
        <div>
          <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-2 block">
            Customer
          </span>
          <div className="space-y-2">
            {customerResults.map((r, i) => (
              <ResultRow key={i} entity={r} />
            ))}
          </div>
        </div>
      )}
      <div className="flex items-center gap-2 pt-2">
        <div className={`w-1.5 h-1.5 rounded-full ${
          associationResult ? "bg-success" : "bg-muted-foreground"
        }`} />
        <span className={`text-xs font-mono ${
          associationResult ? "text-success" : "text-muted-foreground"
        }`}>
          {associationResult
            ? `Association: created (${associationResult.name})`
            : "Association: not created — single entity mode"}
        </span>
      </div>
      {associationResult && (
        <ResultRow entity={associationResult} />
      )}
    </div>
  );
}

function ResultRow({ entity }: { entity: CreatedEntity }) {
  return (
    <a
      href={entity.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center justify-between p-3 rounded-lg
        bg-card border border-border
        hover:border-accent hover:shadow-md transition-all group cursor-pointer"
    >
      <div>
        <span className="text-xs font-mono text-muted-foreground uppercase">
          {entity.type}
        </span>
        <p className="text-sm font-medium">{entity.name}</p>
      </div>
      <span className="text-xs font-mono text-muted-foreground group-hover:text-accent transition-colors">
        {entity.id} &rarr;
      </span>
    </a>
  );
}

function EntityFields({
  company,
  onCompanyChange,
  onContactChange,
  disabled,
  namePlaceholder,
  domainPlaceholder,
}: {
  company: CompanyFields;
  onCompanyChange: (patch: Partial<CompanyFields>) => void;
  onContactChange: (patch: Partial<ContactFields>) => void;
  disabled?: boolean;
  namePlaceholder: string;
  domainPlaceholder: string;
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Company name"
          value={company.name}
          onChange={(v) => onCompanyChange({ name: v })}
          placeholder={namePlaceholder}
          disabled={disabled}
        />
        <Input
          label="Domain"
          value={company.domain}
          onChange={(v) => onCompanyChange({ domain: v })}
          placeholder={domainPlaceholder}
          disabled={disabled}
        />
      </div>
      <div className="grid grid-cols-3 gap-3 mt-3">
        <Input
          label="First name"
          value={company.contact.firstname}
          onChange={(v) => onContactChange({ firstname: v })}
          disabled={disabled}
        />
        <Input
          label="Last name"
          value={company.contact.lastname}
          onChange={(v) => onContactChange({ lastname: v })}
          disabled={disabled}
        />
        <Input
          label="Email"
          value={company.contact.email}
          onChange={(v) => onContactChange({ email: v })}
          type="email"
          mono
          disabled={disabled}
        />
      </div>
    </>
  );
}

function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  disabled,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  disabled?: boolean;
}) {
  return (
    <div
      className={`flex w-full rounded-pill bg-muted p-1 ${disabled ? "opacity-50 pointer-events-none" : ""}`}
      role="radiogroup"
      aria-label="Mode selection"
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          role="radio"
          aria-checked={value === opt.value}
          onClick={() => onChange(opt.value)}
          disabled={disabled}
          className={`flex-1 min-h-[44px] rounded-pill font-button text-xs uppercase tracking-wide transition-all
            ${value === opt.value
              ? "bg-card border border-border shadow-sm text-foreground"
              : "text-muted-foreground hover:text-foreground"
            }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function RoleSelect({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className="h-[44px] px-3 text-xs font-mono rounded-md
        bg-muted border border-border
        text-foreground transition-colors
        disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <option value="Admin-RW">Administrator</option>
      <option value="User-RW">Read &amp; Write</option>
      <option value="User-RO">Read Only</option>
    </select>
  );
}

function ThemeToggle({ theme, onCycle }: { theme: Theme; onCycle: () => void }) {
  return (
    <button
      onClick={onCycle}
      aria-label={`Theme: ${theme}. Click to cycle.`}
      title={`Theme: ${theme}`}
      className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg
        border border-border text-muted-foreground
        hover:text-foreground hover:border-accent transition-colors"
    >
      {theme === "dark" ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      ) : theme === "light" ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
        </svg>
      )}
    </button>
  );
}

function Section({
  title,
  badge,
  action,
  children,
  showCheckbox,
  checked,
  onCheckedChange,
  disabled,
}: {
  title: string;
  badge?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  showCheckbox?: boolean;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className={`mb-6 p-5 rounded-lg shadow-sm bg-card transition-all duration-200
        ${disabled
          ? "opacity-50 border border-dashed border-border"
          : "border border-border"
        }`}
      aria-disabled={disabled || undefined}
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          {showCheckbox ? (
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => onCheckedChange?.(e.target.checked)}
              className="w-4 h-4 rounded accent-primary cursor-pointer"
              aria-label={`Enable ${title}`}
            />
          ) : (
            <div className="w-2 h-2 rounded-full bg-accent" />
          )}
          <h2 className="text-sm font-semibold tracking-tight font-heading text-card-foreground">{title}</h2>
          {badge && (
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-pill bg-muted text-muted-foreground border border-border">
              {badge}
            </span>
          )}
        </div>
        {action}
      </div>
      <div className={disabled ? "pointer-events-none" : ""}>
        {children}
      </div>
    </div>
  );
}

function Input({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  mono,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  mono?: boolean;
  disabled?: boolean;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-muted-foreground mb-1.5">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        tabIndex={disabled ? -1 : undefined}
        className={`w-full px-3 h-[50px] rounded-sm text-base
          bg-card border border-border
          text-foreground placeholder:text-muted-foreground/40
          transition-colors disabled:opacity-50 disabled:cursor-not-allowed
          ${mono ? "font-mono text-xs" : ""}`}
      />
    </div>
  );
}
