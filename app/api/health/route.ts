import { NextResponse } from "next/server";

// Docker HEALTHCHECK hits this. Keep it cheap: no DB, no external calls.
// If the Node process is answering this, the container is healthy enough.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ ok: true });
}
