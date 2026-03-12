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

const APP_VERSION = "0.9.2";

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

export default function Home() {
  const [authLoading, setAuthLoading] = useState(true);
  const [loggedIn, setLoggedIn] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [portalId, setPortalId] = useState<string | null>(null);

  const [partner, setPartner] = useState<CompanyFields>(emptyCompany());
  const [customer, setCustomer] = useState<CompanyFields>(emptyCompany());

  const [portalRole, setPortalRole] = useState("Admin-RW");

  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [results, setResults] = useState<CreatedEntity[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { theme, cycle: cycleTheme } = useTheme();

  // Clean up cooldown interval on unmount
  useEffect(() => {
    return () => { if (cooldownRef.current) clearInterval(cooldownRef.current); };
  }, []);

  // Check if user already authenticated via OAuth
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

  const isValid =
    partner.name &&
    partner.contact.email &&
    customer.name &&
    customer.contact.email;

  if (authLoading) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-sm text-[hsl(var(--muted-foreground))]">Loading...</p>
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
              <div className="w-2 h-2 rounded-full bg-[hsl(var(--accent))]" />
              <span className="text-xs font-mono uppercase tracking-widest text-[hsl(var(--muted-foreground))]">
                HubSpot Entity Creator · v{APP_VERSION}
              </span>
            </div>
            <ThemeToggle theme={theme} onCycle={cycleTheme} />
          </div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight font-heading text-[hsl(var(--card-foreground))]">
            Create test entities
          </h1>
          <p className="text-[hsl(var(--muted-foreground))] mt-2 text-sm leading-relaxed">
            Creates a partner company + contact, a customer company + contact,
            and links them with a Parent Company association.
          </p>
        </div>

        {/* Auth */}
        {!loggedIn ? (
          <div className="animate-in animate-in-delay-1">
            <Section title="Connect to HubSpot">
              <p className="text-sm text-[hsl(var(--muted-foreground))] mb-4">
                Sign in with your HubSpot account to get started. This grants
                the tool permission to create entities in your portal.
              </p>
              <a
                href="/api/auth/install"
                className="block w-full min-h-[44px] py-2.5 rounded-pill font-button font-semibold text-sm uppercase tracking-wide transition-all text-center
                  bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:opacity-90"
              >
                Connect to HubSpot
              </a>
            </Section>
          </div>
        ) : (
          <>
            {/* User indicator */}
            <div className="animate-in flex items-center justify-between mb-6 px-3 py-2 rounded-lg bg-[hsl(var(--card))] border border-[hsl(var(--border))]">
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-[hsl(var(--success))]" />
                <span className="text-xs font-mono text-[hsl(var(--muted-foreground))]">
                  {userEmail || "Connected"}
                  {portalId ? ` · Portal ${portalId}` : ""}
                </span>
              </div>
              <button
                onClick={handleSignOut}
                className="text-xs font-button min-h-[44px] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] transition-colors"
              >
                Disconnect
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
                      bg-[hsl(var(--muted))] border border-[hsl(var(--border))]
                      text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:border-[hsl(var(--accent))]"
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
                      bg-[hsl(var(--muted))] border border-[hsl(var(--border))]
                      text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:border-[hsl(var(--accent))]"
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
                  <label className="block text-[14px] font-medium text-[hsl(var(--muted-foreground))] mb-1.5">
                    Role assigned to both contacts
                  </label>
                  <select
                    value={portalRole}
                    onChange={(e) => setPortalRole(e.target.value)}
                    className="w-full px-3 h-[50px] rounded-[5px] text-[16px]
                      bg-[hsl(var(--card))] border border-[hsl(var(--border))]
                      text-[hsl(var(--foreground))] transition-colors"
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
              disabled={!isValid || loading || cooldown > 0}
              className="w-full min-h-[44px] py-3 rounded-pill font-button font-semibold text-sm uppercase tracking-wide transition-all
                bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:opacity-90
                disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {loading
                ? "Creating entities..."
                : cooldown > 0
                  ? `Retry in ${cooldown}s`
                  : "Create all entities"}
            </button>

            {/* Error */}
            {error && (
              <div className="mt-4 p-4 rounded-lg bg-[hsl(var(--destructive))]/10 border border-[hsl(var(--destructive))]/20">
                <p className="text-sm text-[hsl(var(--destructive))] font-mono">{error}</p>
              </div>
            )}

            {/* Results */}
            {results && (
              <div className="mt-6 animate-in">
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-[hsl(var(--success))]" />
                  <span className="text-xs font-mono uppercase tracking-widest text-[hsl(var(--success))]">
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
                        bg-[hsl(var(--card))] border border-[hsl(var(--border))]
                        hover:border-[hsl(var(--accent))] hover:shadow-md transition-all group"
                    >
                      <div>
                        <span className="text-xs font-mono text-[hsl(var(--muted-foreground))] uppercase">
                          {r.type}
                        </span>
                        <p className="text-sm font-medium">{r.name}</p>
                      </div>
                      <span className="text-xs font-mono text-[hsl(var(--muted-foreground))] group-hover:text-[hsl(var(--accent))] transition-colors">
                        {r.id} &rarr;
                      </span>
                    </a>
                  ))}
                </div>
                <button
                  onClick={handleSignOut}
                  className="mt-6 w-full min-h-[44px] py-3 rounded-pill font-button font-semibold text-sm uppercase tracking-wide transition-all
                    bg-[hsl(var(--muted))] border border-[hsl(var(--border))]
                    text-[hsl(var(--foreground))] hover:border-[hsl(var(--accent))]"
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
        border border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))]
        hover:text-[hsl(var(--foreground))] hover:border-[hsl(var(--accent))] transition-colors"
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
    <div className="mb-6 p-5 rounded-lg shadow-sm bg-[hsl(var(--card))] border border-[hsl(var(--border))]">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold tracking-tight font-heading text-[hsl(var(--card-foreground))]">{title}</h2>
          {badge && (
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-pill bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] border border-[hsl(var(--border))]">
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
      <label className="block text-[14px] font-medium text-[hsl(var(--muted-foreground))] mb-1.5">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full px-3 h-[50px] rounded-[5px] text-[16px]
          bg-[hsl(var(--card))] border border-[hsl(var(--border))]
          text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))]/40
          transition-colors ${mono ? "font-mono text-xs" : ""}`}
      />
    </div>
  );
}
