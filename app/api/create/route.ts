import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getHubSpotToken, AuthError } from "@/lib/hubspot-token";
import { pollCompanyReadiness, PortalStatusError } from "@/lib/portal-status";

export const maxDuration = 300;

const HUBSPOT_API = "https://api.hubapi.com";
const PORTAL_STATUS_POLL_ENABLED = process.env.PORTAL_STATUS_POLL !== "off";
// Debug flag. When `PORTAL_STATUS_POLL_KEEP_ON_FAIL=1`, poll failures
// skip the rollback so the failed company stays in HubSpot for manual
// inspection (checking notes, timeline events, or Yorizon-specific
// fields that might carry a failure reason the textarea doesn't).
// Leave off in normal production — it leaves orphan records on failure.
const PORTAL_STATUS_POLL_KEEP_ON_FAIL = process.env.PORTAL_STATUS_POLL_KEEP_ON_FAIL === "1";

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

    // Lazy-populate hubspotOwnerId for sessions that pre-date the owner-capture
    // code in app/api/auth/callback/route.ts. Skips the lookup if already
    // cached. Cheap: one GET to HubSpot's token-info endpoint.
    if (!session.hubspotOwnerId) {
      try {
        const tokenInfoRes = await fetch(
          `https://api.hubapi.com/oauth/v1/access-tokens/${token}`
        );
        if (tokenInfoRes.ok) {
          const info = await tokenInfoRes.json();
          if (info.user_id) {
            session.hubspotOwnerId = String(info.user_id);
            await session.save();
          }
        }
      } catch {
        // Non-critical — createCompany will fail loudly below if owner is missing
      }
    }
    if (!session.hubspotOwnerId) {
      return NextResponse.json(
        { error: "Could not resolve your HubSpot user ID. Disconnect and reconnect, then try again." },
        { status: 400 }
      );
    }

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

      // Sequential per-side flow, matching how this is done manually:
      //   partner company → partner poll → partner contact
      //   customer company → customer poll → customer contact
      //   association (parent ↔ child) at the end
      // Avoids the Yorizon concurrency collision we observed when two
      // company-create events landed within ~1 second of each other.

      // Phase 1: Partner side
      if (partner) {
        const partnerCompany = await createCompany(headers, partner.name, "PARTNER", session.hubspotOwnerId!);
        createdIds.push({ type: "companies", id: partnerCompany.id, label: "partner_company" });
        await createNote(headers, noteBody, "companies", partnerCompany.id);
        created.push({
          type: "Partner Company",
          id: partnerCompany.id,
          name: partner.name,
          url: recordUrl("company", partnerCompany.id),
        });

        if (PORTAL_STATUS_POLL_ENABLED) {
          await pollCompanyReadiness(
            token,
            partnerCompany.id,
            new Date(partnerCompany.createdAt),
            (line) => console.log(`${line} side=partner`)
          );
        }

        // Attach domain AFTER the provisioning poll succeeds — see the comment
        // on createCompany for why this can't happen at create time. Best
        // effort; if the update fails, the company+contact are still usable
        // and we log rather than abort the whole flow.
        if (partner.domain) {
          try {
            await patchCompanyDomain(headers, partnerCompany.id, partner.domain);
          } catch (e: any) {
            console.error(`[create] Domain patch failed for partner ${partnerCompany.id}: ${e.message}`);
          }
        }

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

      // Phase 2: Customer side (only starts after partner fully completed)
      if (customer) {
        const customerCompany = await createCompany(headers, customer.name, "CUSTOMER", session.hubspotOwnerId!);
        createdIds.push({ type: "companies", id: customerCompany.id, label: "customer_company" });
        await createNote(headers, noteBody, "companies", customerCompany.id);
        created.push({
          type: "Customer Company",
          id: customerCompany.id,
          name: customer.name,
          url: recordUrl("company", customerCompany.id),
        });

        if (PORTAL_STATUS_POLL_ENABLED) {
          await pollCompanyReadiness(
            token,
            customerCompany.id,
            new Date(customerCompany.createdAt),
            (line) => console.log(`${line} side=customer`)
          );
        }

        if (customer.domain) {
          try {
            await patchCompanyDomain(headers, customerCompany.id, customer.domain);
          } catch (e: any) {
            console.error(`[create] Domain patch failed for customer ${customerCompany.id}: ${e.message}`);
          }
        }

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

      // Phase 3: Associate partner ↔ customer (parent/child tag) — last step, only when both present
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
      const rolledBackLabels = createdIds.map(e => e.label).reverse();
      const portalCode = stepError instanceof PortalStatusError ? stepError.code : undefined;
      const skipRollback = portalCode && PORTAL_STATUS_POLL_KEEP_ON_FAIL;

      if (portalCode) {
        console.error(`[create] Portal status ${portalCode} (raw="${stepError.rawStatus ?? "<empty>"}"), ${skipRollback ? "keeping" : "rolling back"} ${createdIds.length} entities`);
      } else {
        console.error(`[create] Step failed, rolling back ${createdIds.length} entities:`, stepError.message);
      }

      // When the debug flag is on, keep the created records in HubSpot so
      // the user can inspect them. Otherwise the normal rollback runs.
      if (!skipRollback) {
        await rollbackEntities(headers, createdIds);
      }

      const rolledBackSummary = skipRollback
        ? ` Records were kept in HubSpot for inspection (PORTAL_STATUS_POLL_KEEP_ON_FAIL=1). You'll need to delete them manually after debugging.`
        : rolledBackLabels.length > 0
        ? ` ${rolledBackLabels.map(l => l.replace(/_/g, " ")).join(", ")} ${rolledBackLabels.length === 1 ? "was" : "were"} created but then removed — nothing was saved. You can retry safely.`
        : "";

      // When we're keeping records, list the URLs so the user can click
      // through to HubSpot and inspect the failed records directly.
      const keptRecords = skipRollback
        ? createdIds.map(e => ({
            type: e.label,
            id: e.id,
            url: recordUrl(e.type === "companies" ? "company" : "contact", e.id),
          }))
        : undefined;

      return NextResponse.json(
        {
          error: `${stepError.message}${rolledBackSummary}`,
          code: portalCode,
          rawStatus: stepError instanceof PortalStatusError ? stepError.rawStatus : undefined,
          rolledBack: skipRollback ? [] : rolledBackLabels,
          kept: keptRecords,
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
  type: "PARTNER" | "CUSTOMER",
  ownerId: string
) {
  // Yorizon's provisioning automation (integration 27850292) requires BOTH:
  //   1. `hubspot_owner_id` set to a real HubSpot user ID
  //   2. NO `domain` field at create time
  // Controlled Private-App POSTs against the live portal 2026-04-23 gave:
  //   owner=no,  domain=no   → "Company creation failed"
  //   owner=no,  domain=yes  → "Company creation failed"
  //   owner=yes, domain=no   → "Company created successfully" ✓
  //   owner=yes, domain=yes  → "Company creation failed"
  // The domain is attached separately after the poll confirms provisioning
  // succeeded, via patchCompanyDomain — Yorizon re-fires on that update and
  // writes "Company updated successfully".
  const properties: Record<string, string> = { name, type, hubspot_owner_id: ownerId };
  return hubspotFetch(`${HUBSPOT_API}/crm/v3/objects/companies`, headers, { properties });
}

async function patchCompanyDomain(
  headers: Record<string, string>,
  companyId: string,
  domain: string
) {
  return hubspotFetch(
    `${HUBSPOT_API}/crm/v3/objects/companies/${companyId}`,
    headers,
    { properties: { domain } },
    "PATCH"
  );
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
