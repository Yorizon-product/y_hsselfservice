import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import crypto from "crypto";

const SCOPES = [
  "crm.objects.companies.read",
  "crm.objects.companies.write",
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.schemas.companies.read",
].join(" ");

export async function GET() {
  const state = crypto.randomBytes(16).toString("hex");

  const session = await getSession();
  session.oauthState = state;
  await session.save();

  const params = new URLSearchParams({
    client_id: process.env.HUBSPOT_CLIENT_ID!,
    redirect_uri: process.env.HUBSPOT_REDIRECT_URI!,
    scope: SCOPES,
    state,
  });

  return NextResponse.redirect(
    `https://app.hubspot.com/oauth/authorize?${params.toString()}`
  );
}
