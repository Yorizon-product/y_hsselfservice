import { NextRequest, NextResponse } from "next/server";

const HUBSPOT_API = "https://api.hubapi.com";

export async function POST(req: NextRequest) {
  try {
    const { token } = await req.json();
    if (!token) {
      return NextResponse.json({ error: "Token required" }, { status: 400 });
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
      const err = await labelsRes.json().catch(() => ({}));
      return NextResponse.json(
        {
          error: `Failed to fetch labels: ${labelsRes.status} ${err?.message || ""}`,
        },
        { status: labelsRes.status }
      );
    }

    const labelsData = await labelsRes.json();

    // Also fetch portal ID for building record URLs
    let portalId: string | null = null;
    try {
      const meRes = await fetch(`${HUBSPOT_API}/account-info/v3/details`, {
        headers,
      });
      if (meRes.ok) {
        const meData = await meRes.json();
        portalId = String(meData.portalId);
      }
    } catch {
      // non-critical, we just won't have portal-specific URLs
    }

    // Map to a cleaner format
    const labels = (labelsData.results || []).map((r: any) => ({
      typeId: r.typeId,
      label: r.label || "",
      category: r.category || "HUBSPOT_DEFINED",
    }));

    return NextResponse.json({ labels, portalId });
  } catch (e: any) {
    return NextResponse.json(
      { error: e.message || "Internal error" },
      { status: 500 }
    );
  }
}
