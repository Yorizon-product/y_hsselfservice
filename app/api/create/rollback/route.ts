import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getHubSpotToken, AuthError } from "@/lib/hubspot-token";
import { rollbackEntities, type TrackedId } from "@/lib/hubspot-entities";

export const maxDuration = 60;

// Whitelist: clients can only ask us to delete objects of the types this
// tool actually creates. Stops a buggy or malicious caller from using the
// rollback endpoint to delete arbitrary HubSpot records (deals, tickets,
// etc.) that happen to be in the user's OAuth scope.
const SINGULAR_TO_PLURAL: Record<string, TrackedId["type"]> = {
  company: "companies",
  contact: "contacts",
  note: "notes",
};

const MAX_IDS_PER_CALL = 8;

function bad(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

type IncomingId = { type: string; id: string; label?: string };

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
  const incoming: IncomingId[] = Array.isArray(body?.ids) ? body.ids : [];
  if (incoming.length === 0) {
    return bad(400, "No IDs provided to roll back.");
  }
  if (incoming.length > MAX_IDS_PER_CALL) {
    return bad(400, `Too many IDs (${incoming.length}); max ${MAX_IDS_PER_CALL} per call.`);
  }

  const entities: TrackedId[] = [];
  for (const item of incoming) {
    if (!item?.type || !item?.id) {
      return bad(400, "Each entry must have type and id.");
    }
    const plural = SINGULAR_TO_PLURAL[item.type];
    if (!plural) {
      return bad(400, `Rollback only supports types: ${Object.keys(SINGULAR_TO_PLURAL).join(", ")}. Got: ${item.type}`);
    }
    if (typeof item.id !== "string" || item.id.length === 0) {
      return bad(400, `Invalid id for ${item.type}`);
    }
    entities.push({ type: plural, id: item.id, label: item.label || `${item.type}_${item.id}` });
  }

  const createdBy = session.userEmail || "unknown";
  console.log(`[audit] ${createdBy} rollback request for ${entities.length} entities`);

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const result = await rollbackEntities(headers, entities, fetch, (line) => console.log(line));
  return NextResponse.json({
    deleted: result.deleted.map(e => ({ type: e.type, id: e.id, label: e.label })),
    failed: result.failed.map(f => ({ type: f.entity.type, id: f.entity.id, label: f.entity.label, error: f.error })),
  });
}
