// Shared HubSpot CRM primitives used by the three create-flow routes
// (/api/create/side, /api/create/associate, /api/create/rollback).
//
// Each primitive accepts an injected Authorization header map and an
// optional fetch implementation, so it can be unit-tested without hitting
// the live HubSpot API.

export const HUBSPOT_API = "https://api.hubapi.com";

export type ContactInput = { firstname: string; lastname: string; email: string };
export type CompanyInput = { name: string; domain: string; contact: ContactInput };

// Shape returned to the client for display in the results list.
export type CreatedEntity = {
  type: string;
  id: string;
  name: string;
  url: string;
};

// Internal tracking for rollback. Uses HubSpot's plural object-type path
// segment ("companies" / "contacts" / "notes") so the delete URL is
// trivially constructable.
export type TrackedId = {
  type: "companies" | "contacts" | "notes";
  id: string;
  label: string;
};

type FetchImpl = typeof fetch;

export function hubspotRecordUrl(
  portalId: string | null | undefined,
  kind: "company" | "contact",
  id: string
): string {
  return portalId
    ? `https://app.hubspot.com/contacts/${portalId}/${kind}/${id}`
    : `#${kind}-${id}`;
}

// Per-call timeout for HubSpot CRUD. Far longer than any healthy HubSpot
// response (p99 well under 5s) but short enough that a hung call can't
// burn the entire 300s Vercel invocation. The polling loop in
// lib/portal-status.ts uses raw fetch and its own 60s+ windows — this
// only applies to non-poll CRUD primitives.
const HUBSPOT_CALL_TIMEOUT_MS = 30_000;

async function hubspotFetch(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  method: string = "POST",
  fetchImpl: FetchImpl = fetch
) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), HUBSPOT_CALL_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method,
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new Error(`HubSpot API timeout after ${HUBSPOT_CALL_TIMEOUT_MS}ms: ${method} ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`HubSpot returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg = data?.message || data?.errors?.[0]?.message || `HTTP ${res.status}`;
    throw new Error(`HubSpot API error: ${msg}`);
  }
  return data;
}

// Yorizon's provisioning automation (integration 27850292) requires BOTH:
//   1. `hubspot_owner_id` set to a real HubSpot user ID
//   2. NO `domain` field at create time
// The domain is attached separately after the poll confirms provisioning
// succeeded — see patchCompanyDomain.
export async function createCompany(
  headers: Record<string, string>,
  name: string,
  type: "PARTNER" | "CUSTOMER",
  ownerId: string,
  fetchImpl: FetchImpl = fetch
): Promise<{ id: string; createdAt: string; properties?: Record<string, string> }> {
  const properties: Record<string, string> = { name, type, hubspot_owner_id: ownerId };
  return hubspotFetch(
    `${HUBSPOT_API}/crm/v3/objects/companies`,
    headers,
    { properties },
    "POST",
    fetchImpl
  );
}

export async function patchCompanyDomain(
  headers: Record<string, string>,
  companyId: string,
  domain: string,
  fetchImpl: FetchImpl = fetch
) {
  return hubspotFetch(
    `${HUBSPOT_API}/crm/v3/objects/companies/${companyId}`,
    headers,
    { properties: { domain } },
    "PATCH",
    fetchImpl
  );
}

export async function createContact(
  headers: Record<string, string>,
  contact: ContactInput,
  companyId: string,
  portalRole: string,
  fetchImpl: FetchImpl = fetch
): Promise<{ id: string }> {
  const properties: Record<string, string> = { email: contact.email };
  if (contact.firstname) properties.firstname = contact.firstname;
  if (contact.lastname) properties.lastname = contact.lastname;
  if (portalRole) properties.portal_role = portalRole;
  return hubspotFetch(
    `${HUBSPOT_API}/crm/v3/objects/contacts`,
    headers,
    {
      properties,
      associations: [
        {
          to: { id: companyId },
          types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 1 }],
        },
      ],
    },
    "POST",
    fetchImpl
  );
}

// Association type IDs 190 (company↔note) and 202 (contact↔note) are
// from HubSpot's HUBSPOT_DEFINED catalogue.
export async function createNote(
  headers: Record<string, string>,
  body: string,
  objectType: "companies" | "contacts",
  objectId: string,
  fetchImpl: FetchImpl = fetch
) {
  return hubspotFetch(
    `${HUBSPOT_API}/crm/v3/objects/notes`,
    headers,
    {
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
    },
    "POST",
    fetchImpl
  );
}

// Parent-company association (type ID 13).
export async function associateCompanies(
  headers: Record<string, string>,
  fromId: string,
  toId: string,
  fetchImpl: FetchImpl = fetch
) {
  return hubspotFetch(
    `${HUBSPOT_API}/crm/v4/objects/companies/${fromId}/associations/companies/${toId}`,
    headers,
    [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 13 }],
    "PUT",
    fetchImpl
  );
}

export type RollbackResult = {
  deleted: TrackedId[];
  failed: { entity: TrackedId; error: string }[];
};

// Deletes in reverse order (last-created first). 404s are treated as
// already-gone and counted as success, so double-rollback is idempotent.
export async function rollbackEntities(
  headers: Record<string, string>,
  entities: TrackedId[],
  fetchImpl: FetchImpl = fetch,
  logger: (line: string) => void = () => {}
): Promise<RollbackResult> {
  const deleted: TrackedId[] = [];
  const failed: { entity: TrackedId; error: string }[] = [];
  for (const entity of [...entities].reverse()) {
    try {
      const res = await fetchImpl(
        `${HUBSPOT_API}/crm/v3/objects/${entity.type}/${entity.id}`,
        { method: "DELETE", headers }
      );
      if (res.ok || res.status === 404) {
        logger(`[rollback] deleted ${entity.label} (${entity.type}/${entity.id})${res.status === 404 ? " [already gone]" : ""}`);
        deleted.push(entity);
      } else {
        const text = await res.text().catch(() => "");
        const err = `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`;
        logger(`[rollback] failed ${entity.label} (${entity.type}/${entity.id}): ${err}`);
        failed.push({ entity, error: err });
      }
    } catch (e: any) {
      logger(`[rollback] failed ${entity.label} (${entity.type}/${entity.id}): ${e.message}`);
      failed.push({ entity, error: e.message });
    }
  }
  return { deleted, failed };
}
