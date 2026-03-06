import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";

export async function GET() {
  const session = await getSession();
  if (!session.userEmail) {
    return NextResponse.json({ loggedIn: false });
  }
  return NextResponse.json({ loggedIn: true, userEmail: session.userEmail });
}

export async function POST(req: NextRequest) {
  const { email } = await req.json();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || typeof email !== "string" || !emailRegex.test(email)) {
    return NextResponse.json({ error: "Valid email is required" }, { status: 400 });
  }

  const session = await getSession();
  session.userEmail = email.trim().toLowerCase();
  await session.save();

  console.log(`[audit] User identified: ${session.userEmail}`);
  return NextResponse.json({ loggedIn: true, userEmail: session.userEmail });
}

export async function DELETE() {
  const session = await getSession();
  const email = session.userEmail;
  session.destroy();
  console.log(`[audit] User signed out: ${email}`);
  return NextResponse.json({ loggedIn: false });
}
