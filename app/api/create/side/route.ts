import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getHubSpotToken, AuthError } from "@/lib/hubspot-token";
import { pollCompanyReadiness, PortalStatusError } from "@/lib/portal-status";
import {
  createCompany,
  createContact,
  createNote,
  hubspotRecordUrl,
  patchCompanyDomain,
  rollbackEntities,
  type CompanyInput,
  type CreatedEntity,
  type TrackedId,
} from "@/lib/hubspot-entities";

// Doubled the per-side poll budget (240s) vs the old single-route flow —
// each side now owns its own 300s serverless cap.
export const maxDuration = 300;

const PORTAL_STATUS_POLL_ENABLED = process.env.PORTAL_STATUS_POLL !== "off";
const PORTAL_STATUS_POLL_KEEP_ON_FAIL = process.env.PORTAL_STATUS_POLL_KEEP_ON_FAIL === "1";

const VALID_ROLES = new Set(["Admin-RW", "User-RW", "User-RO"]);
const DEFAULT_ROLE = "User-RO";
const VALID_SIDES = new Set(["partner", "customer"] as const);
type Side = "partner" | "customer";

// Same 30s in-memory de-dupe window as the legacy route. Per-route Set —
// a caller reusing the same key across /side and /associate does not
// collide.
const recentKeys = new Set<string>();

function bad(status: number, error: string, extras: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extras }, { status });
}

export async function POST(req: NextRequest) {
  let token: string;
  try {
    token = await getHubSpotToken();
  } catch (e) {
    if (e instanceof AuthError) return bad(401, e.message);
    throw e;
  }

  const session = await getSession();

  // Lazy-populate hubspotOwnerId for sessions that pre-date the capture
  // code in app/api/auth/callback/route.ts.
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
      /* createCompany will fail loudly if the owner is still missing */
    }
  }
  if (!session.hubspotOwnerId) {
    return bad(400, "Could not resolve your HubSpot user ID. Disconnect and reconnect, then try again.");
  }

  const body = await req.json();
  const {
    side,
    payload,
    portalRole,
    portalId,
  }: {
    side: Side;
    payload: CompanyInput;
    portalRole?: string;
    portalId?: string | null;
  } = body;

  if (!VALID_SIDES.has(side)) {
    return bad(400, `Invalid side: ${side}. Must be 'partner' or 'customer'.`);
  }
  if (!payload?.name || !payload.contact?.email) {
    return bad(400, `${side} company name and contact email are required`);
  }
  const resolvedRole = portalRole ?? DEFAULT_ROLE;
  if (!VALID_ROLES.has(resolvedRole)) {
    return bad(400, `Invalid portal role: ${resolvedRole}. Valid values: Admin-RW, User-RW, User-RO`);
  }

  const idempotencyKey = req.headers.get("x-idempotency-key");
  if (idempotencyKey && recentKeys.has(idempotencyKey)) {
    return bad(409, "Duplicate submission detected. Please wait before retrying.");
  }
  if (idempotencyKey) {
    recentKeys.add(idempotencyKey);
    setTimeout(() => recentKeys.delete(idempotencyKey), 30_000);
  }

  const createdBy = session.userEmail || "unknown";
  console.log(`[audit] ${createdBy} creating ${side} entity: "${payload.name}"`);

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const created: CreatedEntity[] = [];
  const createdIds: TrackedId[] = [];
  const sideUpper: "PARTNER" | "CUSTOMER" = side === "partner" ? "PARTNER" : "CUSTOMER";
  const noteBody = `Created via HS Self-Service tool by ${createdBy} on ${new Date().toISOString().slice(0, 10)}`;

  try {
    const company = await createCompany(headers, payload.name, sideUpper, session.hubspotOwnerId!);
    createdIds.push({ type: "companies", id: company.id, label: `${side}_company` });
    await createNote(headers, noteBody, "companies", company.id);
    created.push({
      type: side === "partner" ? "Partner Company" : "Customer Company",
      id: company.id,
      name: payload.name,
      url: hubspotRecordUrl(portalId, "company", company.id),
    });

    if (PORTAL_STATUS_POLL_ENABLED) {
      await pollCompanyReadiness(
        token,
        company.id,
        new Date(company.createdAt),
        (line) => console.log(`${line} side=${side}`)
      );
    }

    // Attach domain AFTER the provisioning poll succeeds — Yorizon's
    // automation rejects companies created with a domain set at create
    // time (see lib/hubspot-entities.ts comment on createCompany). Best
    // effort: log but don't abort on failure.
    if (payload.domain) {
      try {
        await patchCompanyDomain(headers, company.id, payload.domain);
      } catch (e: any) {
        console.error(`[create/side] Domain patch failed for ${side} ${company.id}: ${e.message}`);
      }
    }

    const contact = await createContact(headers, payload.contact, company.id, resolvedRole);
    createdIds.push({ type: "contacts", id: contact.id, label: `${side}_contact` });
    await createNote(headers, noteBody, "contacts", contact.id);
    created.push({
      type: side === "partner" ? "Partner Contact" : "Customer Contact",
      id: contact.id,
      name: `${payload.contact.firstname} ${payload.contact.lastname}`.trim() || payload.contact.email,
      url: hubspotRecordUrl(portalId, "contact", contact.id),
    });

    console.log(`[audit] ${createdBy} created ${side} entities: ${created.map(c => `${c.type}(${c.id})`).join(", ")}`);
    // `trackedIds` lets the client call /api/create/rollback if a LATER
    // phase (other side, or associate) fails. Uses the singular form the
    // rollback endpoint expects.
    const trackedIds = createdIds.map(e => ({
      type: e.type === "companies" ? "company" : e.type === "contacts" ? "contact" : "note",
      id: e.id,
      label: e.label,
    }));
    return NextResponse.json({ created, trackedIds });
  } catch (stepError: any) {
    const portalCode = stepError instanceof PortalStatusError ? stepError.code : undefined;
    const skipRollback = portalCode && PORTAL_STATUS_POLL_KEEP_ON_FAIL;

    if (portalCode) {
      console.error(`[create/side] ${side} ${portalCode} (raw="${stepError.rawStatus ?? "<empty>"}"), ${skipRollback ? "keeping" : "rolling back"} ${createdIds.length} entities`);
    } else {
      console.error(`[create/side] ${side} step failed, rolling back ${createdIds.length} entities:`, stepError.message);
    }

    const rolledBackLabels = createdIds.map(e => e.label).reverse();
    if (!skipRollback && createdIds.length > 0) {
      await rollbackEntities(headers, createdIds, fetch, (line) => console.log(line));
    }

    const rolledBackSummary = skipRollback
      ? ` Records were kept in HubSpot for inspection (PORTAL_STATUS_POLL_KEEP_ON_FAIL=1). You'll need to delete them manually after debugging.`
      : rolledBackLabels.length > 0
      ? ` ${rolledBackLabels.map(l => l.replace(/_/g, " ")).join(", ")} ${rolledBackLabels.length === 1 ? "was" : "were"} created but then removed — nothing was saved. You can retry safely.`
      : "";

    const keptRecords = skipRollback
      ? createdIds.map(e => ({
          type: e.label,
          id: e.id,
          url: hubspotRecordUrl(portalId, e.type === "companies" ? "company" : "contact", e.id),
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
}
