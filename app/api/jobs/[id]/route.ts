import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getDb, type JobRow } from "@/lib/db";

// Poll endpoint. Client hits this every 2s until status is terminal
// (succeeded/failed). Response is the minimum shape the client needs to
// render progress + final outcome.

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.userEmail) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const { id } = await context.params;
  const row = getDb()
    .prepare("SELECT * FROM jobs WHERE id=?")
    .get(id) as JobRow | undefined;
  if (!row) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  // Scope jobs to the session user — same HubSpot portal's session
  // shouldn't be able to peek at another user's jobs. Empty user_email
  // rows (edge case: pre-auth enqueues, shouldn't happen) are treated
  // as owned by the requester.
  if (row.user_email && row.user_email !== session.userEmail) {
    return NextResponse.json({ error: "Not your job" }, { status: 403 });
  }
  return NextResponse.json({
    id: row.id,
    status: row.status,
    phase: row.phase,
    phase_started_at: row.updated_at, // phase transitions update updated_at
    created: JSON.parse(row.created_json),
    tracked_ids: JSON.parse(row.tracked_ids_json),
    error: row.error,
    code: row.code,
    raw_status: row.raw_status,
    kept: row.kept_json ? JSON.parse(row.kept_json) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}
