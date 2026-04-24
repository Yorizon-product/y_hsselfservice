import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HUBSPOT_API,
  associateCompanies,
  createCompany,
  createContact,
  createNote,
  hubspotRecordUrl,
  rollbackEntities,
  type TrackedId,
} from "../hubspot-entities.ts";

// Minimal fetch fake. Records each call, returns a scripted response.
type FakeCall = { url: string; method: string; body: any; headers: Record<string, string> };
function fakeFetch(
  handler: (call: FakeCall) => { status: number; json?: any; text?: string }
) {
  const calls: FakeCall[] = [];
  const impl = async (url: string, init?: any): Promise<Response> => {
    const body = init?.body ? JSON.parse(init.body) : null;
    const call: FakeCall = {
      url,
      method: init?.method ?? "GET",
      body,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const r = handler(call);
    const text = r.text ?? (r.json ? JSON.stringify(r.json) : "");
    return new Response(text, { status: r.status });
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

const headers = { Authorization: "Bearer test", "Content-Type": "application/json" };

/* hubspotRecordUrl */

test("hubspotRecordUrl builds a portal URL when portalId is present", () => {
  assert.equal(
    hubspotRecordUrl("12345", "company", "67890"),
    "https://app.hubspot.com/contacts/12345/company/67890"
  );
  assert.equal(
    hubspotRecordUrl("12345", "contact", "67890"),
    "https://app.hubspot.com/contacts/12345/contact/67890"
  );
});

test("hubspotRecordUrl falls back to a hash anchor when portalId is missing", () => {
  assert.equal(hubspotRecordUrl(null, "company", "abc"), "#company-abc");
  assert.equal(hubspotRecordUrl(undefined, "contact", "xyz"), "#contact-xyz");
});

/* createCompany */

test("createCompany POSTs name + type + owner and does NOT include domain", async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 200, json: { id: "c1", createdAt: "2026-04-24T00:00:00Z" } }));
  await createCompany(headers, "Acme", "PARTNER", "owner-42", impl);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${HUBSPOT_API}/crm/v3/objects/companies`);
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body, {
    properties: { name: "Acme", type: "PARTNER", hubspot_owner_id: "owner-42" },
  });
  assert.ok(!("domain" in calls[0].body.properties));
});

/* createContact */

test("createContact associates to the company via associationTypeId 1 and sets portal_role", async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 200, json: { id: "ct1" } }));
  await createContact(
    headers,
    { firstname: "Ada", lastname: "Lovelace", email: "ada@example.com" },
    "co-99",
    "Admin-RW",
    impl
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${HUBSPOT_API}/crm/v3/objects/contacts`);
  assert.equal(calls[0].body.properties.firstname, "Ada");
  assert.equal(calls[0].body.properties.lastname, "Lovelace");
  assert.equal(calls[0].body.properties.email, "ada@example.com");
  assert.equal(calls[0].body.properties.portal_role, "Admin-RW");
  assert.equal(calls[0].body.associations[0].to.id, "co-99");
  assert.equal(calls[0].body.associations[0].types[0].associationTypeId, 1);
});

/* createNote */

test("createNote attaches to a company with association type 190", async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 200, json: { id: "n1" } }));
  await createNote(headers, "hello", "companies", "co-1", impl);
  assert.equal(calls[0].url, `${HUBSPOT_API}/crm/v3/objects/notes`);
  assert.equal(calls[0].body.associations[0].types[0].associationTypeId, 190);
  assert.equal(calls[0].body.properties.hs_note_body, "hello");
});

test("createNote attaches to a contact with association type 202", async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 200, json: { id: "n2" } }));
  await createNote(headers, "hello", "contacts", "ct-1", impl);
  assert.equal(calls[0].body.associations[0].types[0].associationTypeId, 202);
});

/* associateCompanies */

test("associateCompanies PUTs to the v4 associations endpoint with type 13", async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 200, text: "" }));
  await associateCompanies(headers, "p1", "c1", impl);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "PUT");
  assert.equal(
    calls[0].url,
    `${HUBSPOT_API}/crm/v4/objects/companies/p1/associations/companies/c1`
  );
  assert.ok(Array.isArray(calls[0].body));
  assert.equal(calls[0].body[0].associationTypeId, 13);
});

/* rollbackEntities */

test("rollbackEntities deletes in reverse order (last created first)", async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 200, text: "" }));
  const entities: TrackedId[] = [
    { type: "companies", id: "co-1", label: "partner_company" },
    { type: "contacts", id: "ct-1", label: "partner_contact" },
  ];
  const result = await rollbackEntities(headers, entities, impl);
  assert.equal(calls.length, 2);
  // Reverse order: contact first, company last
  assert.ok(calls[0].url.endsWith("/contacts/ct-1"));
  assert.ok(calls[1].url.endsWith("/companies/co-1"));
  assert.equal(calls[0].method, "DELETE");
  assert.equal(result.deleted.length, 2);
  assert.equal(result.failed.length, 0);
});

test("rollbackEntities treats 404 as already-gone and counts as success", async () => {
  const { impl } = fakeFetch(() => ({ status: 404, text: "" }));
  const entities: TrackedId[] = [{ type: "companies", id: "gone", label: "stale" }];
  const result = await rollbackEntities(headers, entities, impl);
  assert.equal(result.deleted.length, 1);
  assert.equal(result.failed.length, 0);
});

test("rollbackEntities accumulates successes and failures separately", async () => {
  let i = 0;
  const { impl } = fakeFetch(() => {
    i++;
    // First DELETE hits success, second hits 500
    return i === 1 ? { status: 200, text: "" } : { status: 500, text: "boom" };
  });
  const entities: TrackedId[] = [
    { type: "companies", id: "a", label: "a" },
    { type: "contacts", id: "b", label: "b" },
  ];
  const result = await rollbackEntities(headers, entities, impl);
  assert.equal(result.deleted.length, 1);
  assert.equal(result.failed.length, 1);
  assert.ok(result.failed[0].error.includes("500"));
});
