import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";

export async function GET(req: NextRequest) {
  const session = await getSession();
  const email = session.userEmail;
  session.destroy();
  console.log(`[audit] User logged out: ${email}`);
  return NextResponse.redirect(new URL("/", req.url).toString());
}
