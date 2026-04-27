import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { publicOrigin } from "@/lib/public-url";
import crypto from "crypto";

const SCOPES = [
  "crm.objects.companies.read",
  "crm.objects.companies.write",
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.schemas.companies.read",
].join(" ");

export async function GET(req: NextRequest) {
  const state = crypto.randomBytes(16).toString("hex");

  const session = await getSession();
  session.oauthState = state;
  await session.save();

  // Behind a reverse proxy req.url shows the internal bind host (0.0.0.0);
  // use the X-Forwarded-* headers so the redirect_uri matches what HubSpot
  // expects.
  const redirectUri = process.env.HUBSPOT_REDIRECT_URI || `${publicOrigin(req)}/api/auth/callback`;

  const params = new URLSearchParams({
    client_id: process.env.HUBSPOT_CLIENT_ID!,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
  });

  return NextResponse.redirect(
    `https://app.hubspot.com/oauth/authorize?${params.toString()}`
  );
}
