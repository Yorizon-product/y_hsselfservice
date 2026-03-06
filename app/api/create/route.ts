import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";

const HUBSPOT_API = "https://api.hubapi.com";

type ContactInput = { firstname: string; lastname: string; email: string };
type CompanyInput = { name: string; domain: string; contact: ContactInput };

type CreatedEntity = {
  type: string;
  id: string;
  name: string;
  url: string;
};

export async function POST(req: NextRequest) {
  try {
    const token = process.env.HUBSPOT_TOKEN;
    if (!token) {
      return NextResponse.json({ error: "Server misconfigured: missing HUBSPOT_TOKEN" }, { status: 500 });
    }

    const session = await getSession();
    if (!session.userEmail) {
      return NextResponse.json({ error: "Not identified" }, { status: 401 });
    }

    const body = await req.json();
    const {
      partner,
      customer,
      associationLabelId,
      portalId,
    }: {
      partner: CompanyInput;
      customer: CompanyInput;
      associationLabelId: number;
      portalId: string | null;
    } = body;

    if (!partner?.name || !partner?.contact?.email) {
      return NextResponse.json(
        { error: "Partner company name and contact email are required" },
        { status: 400 }
      );
    }
    if (!customer?.name || !customer?.contact?.email) {
      return NextResponse.json(
        { error: "Customer company name and contact email are required" },
        { status: 400 }
      );
    }
    if (!associationLabelId) {
      return NextResponse.json(
        { error: "Association label ID is required" },
        { status: 400 }
      );
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

    console.log(`[audit] ${session.userEmail} creating entities: partner="${partner.name}", customer="${customer.name}"`);

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const created: CreatedEntity[] = [];
    const createdIds: { type: "companies" | "contacts"; id: string }[] = [];
    const recordUrl = (type: string, id: string) =>
      portalId
        ? `https://app.hubspot.com/contacts/${portalId}/${type}/${id}`
        : `#${type}-${id}`;

    try {
      // 1. Create partner company
      const partnerCompany = await createCompany(headers, partner.name, partner.domain, "PARTNER");
      createdIds.push({ type: "companies", id: partnerCompany.id });
      created.push({
        type: "Partner Company",
        id: partnerCompany.id,
        name: partner.name,
        url: recordUrl("company", partnerCompany.id),
      });

      // 2. Create partner contact + associate to company
      const partnerContact = await createContact(headers, partner.contact, partnerCompany.id);
      createdIds.push({ type: "contacts", id: partnerContact.id });
      created.push({
        type: "Partner Contact",
        id: partnerContact.id,
        name: `${partner.contact.firstname} ${partner.contact.lastname}`.trim() || partner.contact.email,
        url: recordUrl("contact", partnerContact.id),
      });

      // 3. Create customer company
      const customerCompany = await createCompany(headers, customer.name, customer.domain, "CUSTOMER");
      createdIds.push({ type: "companies", id: customerCompany.id });
      created.push({
        type: "Customer Company",
        id: customerCompany.id,
        name: customer.name,
        url: recordUrl("company", customerCompany.id),
      });

      // 4. Create customer contact + associate to company
      const customerContact = await createContact(headers, customer.contact, customerCompany.id);
      createdIds.push({ type: "contacts", id: customerContact.id });
      created.push({
        type: "Customer Contact",
        id: customerContact.id,
        name: `${customer.contact.firstname} ${customer.contact.lastname}`.trim() || customer.contact.email,
        url: recordUrl("contact", customerContact.id),
      });

      // 5. Associate partner company <-> customer company with label
      await associateCompanies(headers, partnerCompany.id, customerCompany.id, associationLabelId);
      created.push({
        type: "Association",
        id: `${partnerCompany.id}\u2194${customerCompany.id}`,
        name: `${partner.name} \u2194 ${customer.name}`,
        url: recordUrl("company", partnerCompany.id),
      });
    } catch (stepError: any) {
      // Roll back any entities already created in HubSpot
      console.error(`[create] Step failed, rolling back ${createdIds.length} entities:`, stepError.message);
      await rollbackEntities(headers, createdIds);
      throw stepError;
    }

    console.log(`[audit] ${session.userEmail} created ${created.length} entities: ${created.map(c => `${c.type}(${c.id})`).join(", ")}`);
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
  companyId: string
) {
  const properties: Record<string, string> = { email: contact.email };
  if (contact.firstname) properties.firstname = contact.firstname;
  if (contact.lastname) properties.lastname = contact.lastname;
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

async function associateCompanies(
  headers: Record<string, string>,
  fromId: string,
  toId: string,
  labelTypeId: number
) {
  return hubspotFetch(
    `${HUBSPOT_API}/crm/v4/objects/companies/${fromId}/associations/companies/${toId}`,
    headers,
    [{ associationCategory: "USER_DEFINED", associationTypeId: labelTypeId }],
    "PUT"
  );
}

async function rollbackEntities(
  headers: Record<string, string>,
  entities: { type: "companies" | "contacts"; id: string }[]
) {
  // Delete in reverse order (contacts before companies)
  for (const entity of [...entities].reverse()) {
    try {
      await fetch(`${HUBSPOT_API}/crm/v3/objects/${entity.type}/${entity.id}`, {
        method: "DELETE",
        headers,
      });
      console.log(`[rollback] Deleted ${entity.type}/${entity.id}`);
    } catch (e: any) {
      console.error(`[rollback] Failed to delete ${entity.type}/${entity.id}:`, e.message);
    }
  }
}
