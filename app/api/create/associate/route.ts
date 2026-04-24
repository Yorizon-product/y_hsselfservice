import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getHubSpotToken, AuthError } from "@/lib/hubspot-token";
import { associateCompanies, hubspotRecordUrl } from "@/lib/hubspot-entities";

export const maxDuration = 60;

const recentKeys = new Set<string>();

function bad(status: number, error: string) {
  return NextResponse.json({ error }, { status });
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

  const body = await req.json();
  const {
    partnerCompanyId,
    customerCompanyId,
    partnerName,
    customerName,
    portalId,
  }: {
    partnerCompanyId: string;
    customerCompanyId: string;
    partnerName?: string;
    customerName?: string;
    portalId?: string | null;
  } = body;

  if (!partnerCompanyId || typeof partnerCompanyId !== "string") {
    return bad(400, "partnerCompanyId is required");
  }
  if (!customerCompanyId || typeof customerCompanyId !== "string") {
    return bad(400, "customerCompanyId is required");
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
  console.log(`[audit] ${createdBy} associating partner=${partnerCompanyId} customer=${customerCompanyId}`);

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  try {
    await associateCompanies(headers, partnerCompanyId, customerCompanyId);
    const displayName = partnerName && customerName
      ? `${partnerName} ↔ ${customerName}`
      : `${partnerCompanyId} ↔ ${customerCompanyId}`;
    return NextResponse.json({
      created: [{
        type: "Association",
        id: `${partnerCompanyId}↔${customerCompanyId}`,
        name: displayName,
        url: hubspotRecordUrl(portalId, "company", partnerCompanyId),
      }],
    });
  } catch (e: any) {
    console.error(`[create/associate] Failed: ${e.message}`);
    return NextResponse.json(
      { error: e.message || "Association failed" },
      { status: 500 }
    );
  }
}
