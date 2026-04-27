import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getDb, sqliteToIsoZ, type JobRow } from "@/lib/db";

// Returns the dashboard's two lists in one call:
//   - active:  jobs in pending/running, oldest-first (so the longest-
//              waiting one is most prominent — it's the one most likely
//              to need attention).
//   - recent:  jobs in succeeded/failed, newest-first, capped to 50.
// Scoped to the session user's email; matches the per-job route.

const RECENT_LIMIT = 50;

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  const session = await getSession();
  if (!session.userEmail) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const db = getDb();
  const active = db
    .prepare(
      `SELECT * FROM jobs
       WHERE user_email = ? AND status IN ('pending','running')
       ORDER BY created_at ASC`
    )
    .all(session.userEmail) as JobRow[];
  const recent = db
    .prepare(
      `SELECT * FROM jobs
       WHERE user_email = ? AND status IN ('succeeded','failed')
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(session.userEmail, RECENT_LIMIT) as JobRow[];

  const shape = (row: JobRow) => ({
    id: row.id,
    status: row.status,
    phase: row.phase,
    phase_started_at: sqliteToIsoZ(row.updated_at),
    created: JSON.parse(row.created_json),
    error: row.error,
    code: row.code,
    raw_status: row.raw_status,
    kept: row.kept_json ? JSON.parse(row.kept_json) : null,
    created_at: sqliteToIsoZ(row.created_at),
    updated_at: sqliteToIsoZ(row.updated_at),
  });

  return NextResponse.json({
    active: active.map(shape),
    recent: recent.map(shape),
  });
}
