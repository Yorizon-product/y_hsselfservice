import { NextRequest, NextResponse } from "next/server";
import { verifySignature } from "@/lib/hmac";
import { recordWebhookEvent } from "@/lib/db";
import { emitPortalStatusEvent } from "@/lib/portal-status-events";

// HubSpot webhook ingestion. Mirrors the y_prmcrm/flows pattern:
//
//   1. Read the raw body (HMAC is over the exact bytes — never re-serialize).
//   2. Verify X-HubSpot-Signature-V3 against secret + method + URL + body
//      + timestamp. URL is constructed from a configured public origin so
//      Caddy header rewrites can't break verification.
//   3. Parse the body (array of events, sometimes a single event).
//   4. For each event: dedup on eventId, persist to webhook_events, and
//      if it's a propertyChange we care about, emit on the in-process
//      bus so any waiting worker resolves.
//   5. Respond 200 with handled/skipped/failed counts. We intentionally
//      do NOT 5xx on per-event handler errors — HubSpot would retry the
//      whole batch and that's worse than just dropping a few.

export const dynamic = "force-dynamic";

const DEFAULT_PUBLIC_URL = "https://hsselfservice.cdit-dev.de/webhooks/hubspot";

function publicWebhookUrl(): string {
  return process.env.WEBHOOK_PUBLIC_URL || DEFAULT_PUBLIC_URL;
}

export async function POST(req: NextRequest) {
  const secret = process.env.HUBSPOT_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[webhook] HUBSPOT_WEBHOOK_SECRET not set; rejecting all webhooks");
    return new NextResponse(null, { status: 503 });
  }

  const body = await req.text();
  const signatureHeader = req.headers.get("x-hubspot-signature-v3");
  const timestampHeader = req.headers.get("x-hubspot-request-timestamp");

  const ok = verifySignature({
    secret,
    method: "POST",
    url: publicWebhookUrl(),
    body,
    signatureHeader,
    timestampHeader,
  });
  if (!ok) {
    console.warn(
      `[webhook] signature invalid (sig_present=${!!signatureHeader} ts_present=${!!timestampHeader})`
    );
    return new NextResponse(null, { status: 401 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    console.warn("[webhook] body is not valid JSON");
    return new NextResponse(null, { status: 400 });
  }
  const events: any[] = Array.isArray(parsed) ? parsed : [parsed];

  let handled = 0;
  let dedup = 0;
  let skipped = 0;
  for (const e of events) {
    try {
      const eventId = e?.eventId != null ? String(e.eventId) : null;
      const subscriptionType = typeof e?.subscriptionType === "string" ? e.subscriptionType : null;
      const objectId = e?.objectId != null ? String(e.objectId) : null;
      if (!eventId || !subscriptionType || !objectId) {
        skipped++;
        continue;
      }
      const propertyName = typeof e?.propertyName === "string" ? e.propertyName : null;
      const propertyValue = e?.propertyValue != null ? String(e.propertyValue) : null;
      // HubSpot sends occurredAt as epoch millis; normalize to ISO.
      const occurredAtMs = typeof e?.occurredAt === "number" ? e.occurredAt : Date.now();
      const occurredAt = new Date(occurredAtMs).toISOString();

      const isNew = recordWebhookEvent({
        eventId,
        subscriptionType,
        objectId,
        propertyName,
        propertyValue,
        occurredAt,
        rawJson: JSON.stringify(e),
      });
      if (!isNew) {
        dedup++;
        continue;
      }
      handled++;
      console.log(
        `[webhook] event id=${eventId} type=${subscriptionType} obj=${objectId} prop=${propertyName ?? "-"} value="${(propertyValue ?? "").slice(0, 80)}"`
      );

      // Wake any waiter for the company-status case. Other property
      // changes are persisted (forensics) but no listener uses them yet.
      if (propertyName === "portal_status_update" && propertyValue) {
        emitPortalStatusEvent(objectId, propertyValue, occurredAt);
      }
    } catch (err: any) {
      console.error(`[webhook] event handler error: ${err?.message}`);
      skipped++;
    }
  }

  return NextResponse.json({ handled, dedup, skipped });
}
