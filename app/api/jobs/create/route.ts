import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getHubSpotToken, AuthError } from "@/lib/hubspot-token";
import { claimIdempotencyKey, getDb } from "@/lib/db";
import type { JobPayload } from "@/lib/job-runner";
import type { CompanyInput } from "@/lib/hubspot-entities";

// Thin enqueue route. Validates input, captures the current HubSpot
// access token (after any refresh), writes a pending job row, and
// returns the jobId immediately. The in-process worker picks it up on
// its next tick (~500ms). Client polls /api/jobs/:id for progress.

const VALID_ROLES = new Set(["Admin-RW", "User-RW", "User-RO"]);

function bad(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

function newJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
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

  // Lazy-populate hubspotOwnerId for sessions pre-dating the owner
  // capture code in the OAuth callback.
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

  if (!partner && !customer) {
    return bad(400, "At least one entity (partner or customer) is required");
  }
  if (portalRole && (partnerRole || customerRole)) {
    return bad(400, "Cannot provide both shared portalRole and per-entity roles. Use one or the other.");
  }
  // Domain is required: it's the only stable cross-system identity field
  // for the y_prmcrm flows sync (Impartner Customer.website ↔ HubSpot
  // Company.domain). Without a domain, every property-change webhook
  // creates a fresh Impartner Customer (no dedup possible).
  if (partner && (!partner.name || !partner.domain?.trim() || !partner.contact?.email)) {
    return bad(400, "Partner company name, domain, and contact email are required");
  }
  if (customer && (!customer.name || !customer.domain?.trim() || !customer.contact?.email)) {
    return bad(400, "Customer company name, domain, and contact email are required");
  }
  for (const r of [portalRole, partnerRole, customerRole]) {
    if (r && !VALID_ROLES.has(r)) {
      return bad(400, `Invalid portal role: ${r}. Valid values: Admin-RW, User-RW, User-RO`);
    }
  }

  const idempotencyKey = req.headers.get("x-idempotency-key");
  if (idempotencyKey && !claimIdempotencyKey(idempotencyKey)) {
    return bad(409, "Duplicate submission detected. Please wait before retrying.");
  }

  const id = newJobId();
  const jobPayload: JobPayload = {
    partner,
    customer,
    portalRole,
    partnerRole,
    customerRole,
    portalId,
    userEmail: session.userEmail ?? null,
    hubspotOwnerId: session.hubspotOwnerId!,
    accessToken: token,
  };

  getDb()
    .prepare(
      `INSERT INTO jobs (id, user_email, status, payload_json)
       VALUES (?, ?, 'pending', ?)`
    )
    .run(id, session.userEmail ?? null, JSON.stringify(jobPayload));

  const op = partner && customer ? "both" : partner ? "partner-only" : "customer-only";
  console.log(`[audit] ${session.userEmail ?? "unknown"} enqueued job ${id} (${op})`);

  return NextResponse.json({ jobId: id, status: "pending" });
}
