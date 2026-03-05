import { NextRequest, NextResponse } from "next/server";
import { getHubSpotToken, AuthError } from "@/lib/hubspot-token";

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
    let token: string;
    try {
      token = await getHubSpotToken();
    } catch (e) {
      if (e instanceof AuthError) {
        return NextResponse.json({ error: e.message }, { status: 401 });
      }
      throw e;
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

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const created: CreatedEntity[] = [];
    const recordUrl = (type: string, id: string) =>
      portalId
        ? `https://app.hubspot.com/contacts/${portalId}/${type}/${id}`
        : `#${type}-${id}`;

    // 1. Create partner company
    const partnerCompany = await createCompany(headers, partner.name, partner.domain, "partner");
    created.push({
      type: "Partner Company",
      id: partnerCompany.id,
      name: partner.name,
      url: recordUrl("company", partnerCompany.id),
    });

    // 2. Create partner contact + associate to company
    const partnerContact = await createContact(headers, partner.contact, partnerCompany.id);
    created.push({
      type: "Partner Contact",
      id: partnerContact.id,
      name: `${partner.contact.firstname} ${partner.contact.lastname}`.trim() || partner.contact.email,
      url: recordUrl("contact", partnerContact.id),
    });

    // 3. Create customer company
    const customerCompany = await createCompany(headers, customer.name, customer.domain, "customer");
    created.push({
      type: "Customer Company",
      id: customerCompany.id,
      name: customer.name,
      url: recordUrl("company", customerCompany.id),
    });

    // 4. Create customer contact + associate to company
    const customerContact = await createContact(headers, customer.contact, customerCompany.id);
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

    return NextResponse.json({ created });
  } catch (e: any) {
    console.error("[create] Error:", e.message);
    return NextResponse.json(
      { error: e.message || "Internal error" },
      { status: 500 }
    );
  }
}

/* HubSpot API helpers */

async function hubspotFetch(url: string, headers: Record<string, string>, body: any) {
  const res = await fetch(url, {
    method: "POST",
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
  companytype: "partner" | "customer"
) {
  const properties: Record<string, string> = { name, companytype };
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
    [{ associationCategory: "USER_DEFINED", associationTypeId: labelTypeId }]
  );
}
