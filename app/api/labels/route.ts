import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";

const HUBSPOT_API = "https://api.hubapi.com";

export async function GET() {
  try {
    const token = process.env.HUBSPOT_TOKEN;
    if (!token) {
      return NextResponse.json({ error: "Server misconfigured: missing HUBSPOT_TOKEN" }, { status: 500 });
    }

    const session = await getSession();
    if (!session.userEmail) {
      return NextResponse.json({ error: "Not identified" }, { status: 401 });
    }

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    // Fetch company-to-company association labels
    const labelsRes = await fetch(
      `${HUBSPOT_API}/crm/v4/associations/companies/companies/labels`,
      { headers }
    );

    if (!labelsRes.ok) {
      const errText = await labelsRes.text();
      let err: any = {};
      try { err = JSON.parse(errText); } catch {}
      return NextResponse.json(
        { error: `Failed to fetch labels: ${labelsRes.status} ${err?.message || ""}` },
        { status: labelsRes.status }
      );
    }

    const labelsData = await labelsRes.json();

    // Fetch portal ID for building record URLs
    let portalId: string | null = null;
    try {
      const meRes = await fetch(`${HUBSPOT_API}/account-info/v3/details`, { headers });
      if (meRes.ok) {
        const meData = await meRes.json();
        portalId = String(meData.portalId);
      }
    } catch {
      // Non-critical
    }

    const labels = (labelsData.results || []).map((r: any) => ({
      typeId: r.typeId,
      label: r.label || "",
      category: r.category || "HUBSPOT_DEFINED",
    }));

    console.log(`[audit] ${session.userEmail} fetched ${labels.length} association labels`);
    return NextResponse.json({ labels, portalId });
  } catch (e: any) {
    console.error("[labels] Error:", e.message);
    return NextResponse.json(
      { error: e.message || "Internal error" },
      { status: 500 }
    );
  }
}
