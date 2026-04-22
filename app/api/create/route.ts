import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getHubSpotToken, AuthError } from "@/lib/hubspot-token";
import { pollCompanyReadiness, PortalStatusError } from "@/lib/portal-status";

export const maxDuration = 300;

const HUBSPOT_API = "https://api.hubapi.com";
const PORTAL_STATUS_POLL_ENABLED = process.env.PORTAL_STATUS_POLL !== "off";

const VALID_ROLES = new Set(["Admin-RW", "User-RW", "User-RO"]);
const DEFAULT_ROLE = "User-RO";

type ContactInput = { firstname: string; lastname: string; email: string };
type CompanyInput = { name: string; domain: string; contact: ContactInput };

type CreatedEntity = {
  type: string;
  id: string;
  name: string;
  url: string;
};

function resolveRole(perEntity?: string, shared?: string): string {
  const role = perEntity ?? shared ?? DEFAULT_ROLE;
  if (!VALID_ROLES.has(role)) {
    throw new ValidationError(`Invalid portal role: ${role}. Valid values: Admin-RW, User-RW, User-RO`);
  }
  return role;
}

class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export async function POST(req: NextRequest) {
  try {
    let token: string;
    try {
      token = await getHubSpotToken();
    } catch (e) {
      if (e instanceof AuthError) {
        return NextResponse.json({ error: e.message }, { status: 401 });
      }
      throw e;
    }

    const session = await getSession();

    const body = await req.json();
    const {
      partner,
      customer,
      portalId,
      portalRole,
      partnerRole,
      customerRole,
    }: {
      partner: CompanyInput | null;
      customer: CompanyInput | null;
      portalId: string | null;
      portalRole?: string;
      partnerRole?: string;
      customerRole?: string;
    } = body;

    // Validate: at least one entity required
    if (!partner && !customer) {
      return NextResponse.json(
        { error: "At least one entity (partner or customer) is required" },
        { status: 400 }
      );
    }

    // Validate: reject mixed role payload shapes
    if (portalRole && (partnerRole || customerRole)) {
      return NextResponse.json(
        { error: "Cannot provide both shared portalRole and per-entity roles. Use one or the other." },
        { status: 400 }
      );
    }

    // Validate entity fields when present
    if (partner && (!partner.name || !partner.contact?.email)) {
      return NextResponse.json(
        { error: "Partner company name and contact email are required" },
        { status: 400 }
      );
    }
    if (customer && (!customer.name || !customer.contact?.email)) {
      return NextResponse.json(
        { error: "Customer company name and contact email are required" },
        { status: 400 }
      );
    }

    // Resolve and validate roles
    let resolvedPartnerRole: string | undefined;
    let resolvedCustomerRole: string | undefined;
    try {
      if (partner) resolvedPartnerRole = resolveRole(partnerRole, portalRole);
      if (customer) resolvedCustomerRole = resolveRole(customerRole, portalRole);
    } catch (e) {
      if (e instanceof ValidationError) {
        return NextResponse.json({ error: e.message }, { status: 400 });
      }
      throw e;
    }

    // Idempotency: reject duplicate submissions within a short window
    const idempotencyKey = req.headers.get("x-idempotency-key");
    if (idempotencyKey && recentKeys.has(idempotencyKey)) {
      return NextResponse.json(
        { error: "Duplicate submission detected. Please wait before retrying." },
        { status: 409 }
      );
    }
    if (idempotencyKey) {
      recentKeys.add(idempotencyKey);
      setTimeout(() => recentKeys.delete(idempotencyKey), 30_000);
    }

    const createdBy = session.userEmail || "unknown";
    const operationType = partner && customer ? "both" : partner ? "partner-only" : "customer-only";
    console.log(`[audit] ${createdBy} creating entities (${operationType}): partner="${partner?.name ?? "—"}", customer="${customer?.name ?? "—"}"`);

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const created: CreatedEntity[] = [];
    const createdIds: { type: "companies" | "contacts"; id: string; label: string }[] = [];
    const recordUrl = (type: string, id: string) =>
      portalId
        ? `https://app.hubspot.com/contacts/${portalId}/${type}/${id}`
        : `#${type}-${id}`;

    try {
      const noteBody = `Created via HS Self-Service tool by ${createdBy} on ${new Date().toISOString().slice(0, 10)}`;

      // Phase 1: Create both companies (+ notes) sequentially up front.
      // Quick operations (~1s each). Doing both before polling lets us
      // run the slow portal-readiness polls in parallel in phase 2.
      let partnerCompany: any = null;
      let customerCompany: any = null;

      if (partner) {
        partnerCompany = await createCompany(headers, partner.name, partner.domain, "PARTNER");
        createdIds.push({ type: "companies", id: partnerCompany.id, label: "partner_company" });
        await createNote(headers, noteBody, "companies", partnerCompany.id);
        created.push({
          type: "Partner Company",
          id: partnerCompany.id,
          name: partner.name,
          url: recordUrl("company", partnerCompany.id),
        });
      }

      if (customer) {
        customerCompany = await createCompany(headers, customer.name, customer.domain, "CUSTOMER");
        createdIds.push({ type: "companies", id: customerCompany.id, label: "customer_company" });
        await createNote(headers, noteBody, "companies", customerCompany.id);
        created.push({
          type: "Customer Company",
          id: customerCompany.id,
          name: customer.name,
          url: recordUrl("company", customerCompany.id),
        });
      }

      // Phase 2: Poll both companies' portal_status_update in parallel.
      // Worst case wall-clock is max(partner budget, customer budget),
      // not the sum. Uses Promise.all so the first failure throws —
      // rollback then cleans up whichever companies exist.
      if (PORTAL_STATUS_POLL_ENABLED) {
        const polls: Promise<void>[] = [];
        if (partnerCompany) {
          polls.push(
            pollCompanyReadiness(
              token,
              partnerCompany.id,
              new Date(partnerCompany.createdAt),
              (line) => console.log(`${line} side=partner`)
            )
          );
        }
        if (customerCompany) {
          polls.push(
            pollCompanyReadiness(
              token,
              customerCompany.id,
              new Date(customerCompany.createdAt),
              (line) => console.log(`${line} side=customer`)
            )
          );
        }
        await Promise.all(polls);
      }

      // Phase 3: Create contacts (+ notes) for each company whose poll succeeded.
      if (partner && partnerCompany) {
        const partnerContact = await createContact(headers, partner.contact, partnerCompany.id, resolvedPartnerRole!);
        createdIds.push({ type: "contacts", id: partnerContact.id, label: "partner_contact" });
        await createNote(headers, noteBody, "contacts", partnerContact.id);
        created.push({
          type: "Partner Contact",
          id: partnerContact.id,
          name: `${partner.contact.firstname} ${partner.contact.lastname}`.trim() || partner.contact.email,
          url: recordUrl("contact", partnerContact.id),
        });
      }

      if (customer && customerCompany) {
        const customerContact = await createContact(headers, customer.contact, customerCompany.id, resolvedCustomerRole!);
        createdIds.push({ type: "contacts", id: customerContact.id, label: "customer_contact" });
        await createNote(headers, noteBody, "contacts", customerContact.id);
        created.push({
          type: "Customer Contact",
          id: customerContact.id,
          name: `${customer.contact.firstname} ${customer.contact.lastname}`.trim() || customer.contact.email,
          url: recordUrl("contact", customerContact.id),
        });
      }

      // Phase 4: Associate partner <-> customer (only when both present)
      if (partner && customer) {
        const partnerCompanyId = createdIds.find(e => e.label === "partner_company")!.id;
        const customerCompanyId = createdIds.find(e => e.label === "customer_company")!.id;
        await associateCompanies(headers, partnerCompanyId, customerCompanyId);
        created.push({
          type: "Association",
          id: `${partnerCompanyId}\u2194${customerCompanyId}`,
          name: `${partner.name} \u2194 ${customer.name}`,
          url: recordUrl("company", partnerCompanyId),
        });
      }
    } catch (stepError: any) {
      // Roll back any entities already created in HubSpot
      const rolledBackLabels = createdIds.map(e => e.label).reverse();
      const portalCode = stepError instanceof PortalStatusError ? stepError.code : undefined;
      if (portalCode) {
        console.error(`[create] Portal status ${portalCode} (raw="${stepError.rawStatus ?? "<empty>"}"), rolling back ${createdIds.length} entities`);
      } else {
        console.error(`[create] Step failed, rolling back ${createdIds.length} entities:`, stepError.message);
      }
      await rollbackEntities(headers, createdIds);

      const rolledBackSummary = rolledBackLabels.length > 0
        ? ` ${rolledBackLabels.map(l => l.replace(/_/g, " ")).join(", ")} ${rolledBackLabels.length === 1 ? "was" : "were"} created but then removed — nothing was saved. You can retry safely.`
        : "";

      return NextResponse.json(
        {
          error: `${stepError.message}${rolledBackSummary}`,
          code: portalCode,
          // Surface the raw portal_status_update so the client can display
          // exactly what Yorizon's automation wrote. Essential for debugging
          // since Vercel's log stream aggregates per request and only keeps
          // the first console.log line — the detailed poll logs aren't
          // queryable after the fact.
          rawStatus: stepError instanceof PortalStatusError ? stepError.rawStatus : undefined,
          rolledBack: rolledBackLabels,
        },
        { status: 500 }
      );
    }

    const roleInfo = partnerRole || customerRole
      ? ` roles: partner=${resolvedPartnerRole ?? "—"}, customer=${resolvedCustomerRole ?? "—"}`
      : ` role: ${portalRole ?? DEFAULT_ROLE}`;
    console.log(`[audit] ${createdBy} created ${created.length} entities (${operationType}):${roleInfo} ${created.map(c => `${c.type}(${c.id})`).join(", ")}`);
    return NextResponse.json({ created });
  } catch (e: any) {
    console.error("[create] Error:", e.message);
    return NextResponse.json(
      { error: e.message || "Internal error" },
      { status: 500 }
    );
  }
}

// Simple in-memory idempotency guard (resets on deploy, good enough for this use case)
const recentKeys = new Set<string>();

/* HubSpot API helpers */

async function hubspotFetch(url: string, headers: Record<string, string>, body: any, method: string = "POST") {
  const res = await fetch(url, {
    method,
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`HubSpot returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg = data?.message || data?.errors?.[0]?.message || `HTTP ${res.status}`;
    throw new Error(`HubSpot API error: ${msg}`);
  }
  return data;
}

async function createCompany(
  headers: Record<string, string>,
  name: string,
  domain: string,
  type: "PARTNER" | "CUSTOMER"
) {
  const properties: Record<string, string> = { name, type };
  if (domain) properties.domain = domain;
  return hubspotFetch(`${HUBSPOT_API}/crm/v3/objects/companies`, headers, { properties });
}

async function createContact(
  headers: Record<string, string>,
  contact: ContactInput,
  companyId: string,
  portalRole: string
) {
  const properties: Record<string, string> = { email: contact.email };
  if (contact.firstname) properties.firstname = contact.firstname;
  if (contact.lastname) properties.lastname = contact.lastname;
  if (portalRole) properties.portal_role = portalRole;
  return hubspotFetch(`${HUBSPOT_API}/crm/v3/objects/contacts`, headers, {
    properties,
    associations: [
      {
        to: { id: companyId },
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 1 }],
      },
    ],
  });
}

async function createNote(
  headers: Record<string, string>,
  body: string,
  objectType: "companies" | "contacts",
  objectId: string
) {
  return hubspotFetch(`${HUBSPOT_API}/crm/v3/objects/notes`, headers, {
    properties: {
      hs_note_body: body,
      hs_timestamp: new Date().toISOString(),
    },
    associations: [
      {
        to: { id: objectId },
        types: [
          {
            associationCategory: "HUBSPOT_DEFINED",
            associationTypeId: objectType === "contacts" ? 202 : 190,
          },
        ],
      },
    ],
  });
}

async function associateCompanies(
  headers: Record<string, string>,
  fromId: string,
  toId: string
) {
  return hubspotFetch(
    `${HUBSPOT_API}/crm/v4/objects/companies/${fromId}/associations/companies/${toId}`,
    headers,
    [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 13 }],
    "PUT"
  );
}

async function rollbackEntities(
  headers: Record<string, string>,
  entities: { type: "companies" | "contacts"; id: string; label: string }[]
) {
  // Delete in reverse order (contacts before companies)
  for (const entity of [...entities].reverse()) {
    try {
      await fetch(`${HUBSPOT_API}/crm/v3/objects/${entity.type}/${entity.id}`, {
        method: "DELETE",
        headers,
      });
      console.log(`[rollback] Deleted ${entity.label} (${entity.type}/${entity.id})`);
    } catch (e: any) {
      console.error(`[rollback] Failed to delete ${entity.label} (${entity.type}/${entity.id}):`, e.message);
    }
  }
}
