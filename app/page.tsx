"use client";

import { useState, useEffect, useCallback } from "react";

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

const APP_VERSION = "0.6.1";

// Random data pools
const FIRST_NAMES = ["Alex", "Jordan", "Sam", "Taylor", "Casey", "Morgan", "Riley", "Quinn", "Avery", "Dakota"];
const LAST_NAMES = ["Smith", "Johnson", "Brown", "Garcia", "Miller", "Davis", "Wilson", "Moore", "Clark", "Hall"];
const COMPANY_PREFIXES = ["Acme", "Nova", "Apex", "Vortex", "Stellar", "Nimbus", "Prism", "Helix", "Cobalt", "Zenith"];
const COMPANY_SUFFIXES = ["Corp", "Solutions", "Industries", "Tech", "Group", "Labs", "Systems", "Digital", "Partners", "Global"];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomSlug(): string {
  return Math.random().toString(36).slice(2, 6);
}

function generateRandomCompany(userEmail: string, role: "partner" | "customer"): CompanyFields {
  const first = pick(FIRST_NAMES);
  const last = pick(LAST_NAMES);
  const prefix = pick(COMPANY_PREFIXES);
  const suffix = pick(COMPANY_SUFFIXES);
  const slug = randomSlug();
  const companyName = `${prefix} ${suffix}`;
  const domain = `${prefix.toLowerCase()}-${slug}.test`;

  // Plus-address: user+acme-partner-a3f2@domain.com
  const [localPart, domainPart] = userEmail.split("@");
  const tag = `${prefix.toLowerCase()}-${role}-${slug}`;
  const contactEmail = `${localPart}+${tag}@${domainPart}`;

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

export default function Home() {
  const [authLoading, setAuthLoading] = useState(true);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [emailInput, setEmailInput] = useState("");
  const [portalId, setPortalId] = useState<string | null>(null);

  const [partner, setPartner] = useState<CompanyFields>(emptyCompany());
  const [customer, setCustomer] = useState<CompanyFields>(emptyCompany());

  const [portalRole, setPortalRole] = useState("Admin-RW");

  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<CreatedEntity[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { theme, cycle: cycleTheme } = useTheme();

  // Check if user already identified
  useEffect(() => {
    fetch("/api/auth/me")
      .then(async (r) => {
        if (!r.ok) return;
        const data = await r.json();
        if (data.loggedIn) setUserEmail(data.userEmail);
      })
      .catch(() => {})
      .finally(() => setAuthLoading(false));
  }, []);

  // Fetch portal ID when identified
  useEffect(() => {
    if (!userEmail) return;
    fetch("/api/labels")
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) return;
        if (data.portalId) setPortalId(data.portalId);
      })
      .catch(() => {});
  }, [userEmail]);

  const isValidEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

  const handleIdentify = async () => {
    if (!isValidEmail(emailInput.trim())) return;
    const res = await fetch("/api/auth/me", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: emailInput.trim() }),
    });
    const data = await res.json();
    if (data.loggedIn) setUserEmail(data.userEmail);
  };

  const handleSignOut = async () => {
    await fetch("/api/auth/me", { method: "DELETE" });
    setUserEmail(null);
    setEmailInput("");
    setResults(null);
    setPortalId(null);
  };

  const handleRandomize = (role: "partner" | "customer") => {
    if (!userEmail) return;
    const company = generateRandomCompany(userEmail, role);
    if (role === "partner") setPartner(company);
    else setCustomer(company);
  };

  const handleSubmit = async () => {
    if (loading) return; // prevent double-click
    setLoading(true);
    setError(null);
    setResults(null);

    try {
      const idempotencyKey = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const res = await fetch("/api/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({
          partner,
          customer,
          portalId,
          portalRole,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong");
      setResults(data.created);
      // Reset form after successful creation
      setPartner(emptyCompany());
      setCustomer(emptyCompany());
    } catch (e: any) {
      setError(e.message);
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

  const isValid =
    partner.name &&
    partner.contact.email &&
    customer.name &&
    customer.contact.email;

  if (authLoading) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-sm text-[var(--text-muted)]">Loading...</p>
      </main>
    );
  }

  return (
    <main id="main-content" className="min-h-screen flex items-start justify-center px-4 py-12 md:py-20">
      <div className="w-full max-w-2xl">
        {/* Header */}
        <div className="animate-in mb-10">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <div className="w-2 h-2 rounded-full bg-[var(--lime-decorative)]" />
              <span className="text-xs font-mono uppercase tracking-widest text-[var(--text-muted)]">
                HubSpot Entity Creator · v{APP_VERSION}
              </span>
            </div>
            <ThemeToggle theme={theme} onCycle={cycleTheme} />
          </div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight font-heading text-[var(--text-heading)]">
            Create test entities
          </h1>
          <p className="text-[var(--text-muted)] mt-2 text-sm leading-relaxed">
            Creates a partner company + contact, a customer company + contact,
            and links them with an association label.
          </p>
        </div>

        {/* Email entry */}
        {!userEmail ? (
          <div className="animate-in animate-in-delay-1">
            <Section title="Who are you?">
              <p className="text-sm text-[var(--text-muted)] mb-4">
                Enter your email address. This is used for audit logging and to
                generate plus-addressed contact emails (e.g.{" "}
                <span className="font-mono text-xs">you+partner-test@company.com</span>)
                that land in your inbox.
              </p>
              <Input
                label="Your email"
                value={emailInput}
                onChange={setEmailInput}
                type="email"
                placeholder="firstname.lastname@yorizon.com"
              />
              <button
                onClick={handleIdentify}
                disabled={!isValidEmail(emailInput.trim())}
                className="mt-4 w-full min-h-[44px] py-2.5 rounded-pill font-button font-semibold text-sm uppercase tracking-wide transition-all
                  bg-[var(--bg-primary)] text-[var(--text-on-primary)] hover:opacity-90
                  disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Continue
              </button>
            </Section>
          </div>
        ) : (
          <>
            {/* User indicator */}
            <div className="animate-in flex items-center justify-between mb-6 px-3 py-2 rounded-lg bg-[var(--bg-card)] border border-[var(--border-default)]">
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-[var(--color-success)]" />
                <span className="text-xs font-mono text-[var(--text-muted)]">
                  {userEmail}
                  {portalId ? ` · Portal ${portalId}` : ""}
                </span>
              </div>
              <button
                onClick={handleSignOut}
                className="text-xs font-button min-h-[44px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
              >
                Switch user
              </button>
            </div>

            {/* Partner */}
            <div className="animate-in animate-in-delay-1">
              <Section
                title="Partner"
                badge="type = PARTNER"
                action={
                  <button
                    onClick={() => handleRandomize("partner")}
                    className="text-xs px-2.5 py-1 rounded-md font-button min-h-[44px] font-medium transition-all
                      bg-[var(--bg-section)] border border-[var(--border-default)]
                      text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--text-accent)]"
                  >
                    Randomize
                  </button>
                }
              >
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    label="Company name"
                    value={partner.name}
                    onChange={(v) => updatePartner({ name: v })}
                    placeholder="Acme Corp"
                  />
                  <Input
                    label="Domain"
                    value={partner.domain}
                    onChange={(v) => updatePartner({ domain: v })}
                    placeholder="acme.com"
                  />
                </div>
                <div className="grid grid-cols-3 gap-3 mt-3">
                  <Input
                    label="First name"
                    value={partner.contact.firstname}
                    onChange={(v) => updatePartnerContact({ firstname: v })}
                  />
                  <Input
                    label="Last name"
                    value={partner.contact.lastname}
                    onChange={(v) => updatePartnerContact({ lastname: v })}
                  />
                  <Input
                    label="Email"
                    value={partner.contact.email}
                    onChange={(v) => updatePartnerContact({ email: v })}
                    type="email"
                    mono
                  />
                </div>
              </Section>
            </div>

            {/* Customer */}
            <div className="animate-in animate-in-delay-2">
              <Section
                title="Customer"
                badge="type = CUSTOMER"
                action={
                  <button
                    onClick={() => handleRandomize("customer")}
                    className="text-xs px-2.5 py-1 rounded-md font-button min-h-[44px] font-medium transition-all
                      bg-[var(--bg-section)] border border-[var(--border-default)]
                      text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--text-accent)]"
                  >
                    Randomize
                  </button>
                }
              >
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    label="Company name"
                    value={customer.name}
                    onChange={(v) => updateCustomer({ name: v })}
                    placeholder="Widget Inc"
                  />
                  <Input
                    label="Domain"
                    value={customer.domain}
                    onChange={(v) => updateCustomer({ domain: v })}
                    placeholder="widget.io"
                  />
                </div>
                <div className="grid grid-cols-3 gap-3 mt-3">
                  <Input
                    label="First name"
                    value={customer.contact.firstname}
                    onChange={(v) => updateCustomerContact({ firstname: v })}
                  />
                  <Input
                    label="Last name"
                    value={customer.contact.lastname}
                    onChange={(v) => updateCustomerContact({ lastname: v })}
                  />
                  <Input
                    label="Email"
                    value={customer.contact.email}
                    onChange={(v) => updateCustomerContact({ email: v })}
                    type="email"
                    mono
                  />
                </div>
              </Section>
            </div>


            {/* Portal Role */}
            <div className="animate-in animate-in-delay-3">
              <Section title="Portal Role">
                <div>
                  <label className="block text-[14px] font-medium text-[var(--text-muted)] mb-1.5">
                    Role assigned to both contacts
                  </label>
                  <select
                    value={portalRole}
                    onChange={(e) => setPortalRole(e.target.value)}
                    className="w-full px-3 h-[50px] rounded-[5px] text-[16px]
                      bg-[var(--bg-input)] border border-[var(--border-default)]
                      text-[var(--text-primary)] transition-colors"
                  >
                    <option value="Admin-RW">Administrator</option>
                    <option value="User-RW">User - Read &amp; Write</option>
                    <option value="User-RO">User - Read Only</option>
                  </select>
                </div>
              </Section>
            </div>

            {/* Submit */}
            <button
              onClick={handleSubmit}
              disabled={!isValid || loading}
              className="w-full min-h-[44px] py-3 rounded-pill font-button font-semibold text-sm uppercase tracking-wide transition-all
                bg-[var(--bg-primary)] text-[var(--text-on-primary)] hover:opacity-90
                disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {loading ? "Creating entities..." : "Create all entities"}
            </button>

            {/* Error */}
            {error && (
              <div className="mt-4 p-4 rounded-lg bg-[var(--color-error)]/10 border border-[var(--color-error)]/20">
                <p className="text-sm text-[var(--color-error)] font-mono">{error}</p>
              </div>
            )}

            {/* Results */}
            {results && (
              <div className="mt-6 animate-in">
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-[var(--color-success)]" />
                  <span className="text-xs font-mono uppercase tracking-widest text-[var(--color-success)]">
                    Created successfully
                  </span>
                </div>
                <div className="space-y-2">
                  {results.map((r, i) => (
                    <a
                      key={i}
                      href={r.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-between p-3 rounded-lg
                        bg-[var(--bg-card)] border border-[var(--border-default)]
                        hover:border-[var(--text-accent)] hover:shadow-md transition-all group"
                    >
                      <div>
                        <span className="text-xs font-mono text-[var(--text-muted)] uppercase">
                          {r.type}
                        </span>
                        <p className="text-sm font-medium">{r.name}</p>
                      </div>
                      <span className="text-xs font-mono text-[var(--text-muted)] group-hover:text-[var(--text-accent)] transition-colors">
                        {r.id} &rarr;
                      </span>
                    </a>
                  ))}
                </div>
                <button
                  onClick={handleSignOut}
                  className="mt-6 w-full min-h-[44px] py-3 rounded-pill font-button font-semibold text-sm uppercase tracking-wide transition-all
                    bg-[var(--bg-section)] border border-[var(--border-default)]
                    text-[var(--text-primary)] hover:border-[var(--text-accent)]"
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

function ThemeToggle({ theme, onCycle }: { theme: Theme; onCycle: () => void }) {
  return (
    <button
      onClick={onCycle}
      aria-label={`Theme: ${theme}. Click to cycle.`}
      title={`Theme: ${theme}`}
      className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg
        border border-[var(--border-default)] text-[var(--text-muted)]
        hover:text-[var(--text-primary)] hover:border-[var(--text-accent)] transition-colors"
    >
      {theme === "dark" ? (
        /* Moon icon */
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      ) : theme === "light" ? (
        /* Sun icon */
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
      ) : (
        /* Monitor/system icon */
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
}: {
  title: string;
  badge?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-6 p-5 rounded-lg shadow-sm bg-[var(--bg-card)] border border-[var(--border-default)]">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold tracking-tight font-heading text-[var(--text-heading)]">{title}</h2>
          {badge && (
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-pill bg-[var(--bg-section)] text-[var(--text-muted)] border border-[var(--border-default)]">
              {badge}
            </span>
          )}
        </div>
        {action}
      </div>
      {children}
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <div>
      <label className="block text-[14px] font-medium text-[var(--text-muted)] mb-1.5">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full px-3 h-[50px] rounded-[5px] text-[16px]
          bg-[var(--bg-input)] border border-[var(--border-default)]
          text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/40
          transition-colors ${mono ? "font-mono text-xs" : ""}`}
      />
    </div>
  );
}
