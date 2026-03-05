import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const baseUrl = new URL("/", req.url).toString();

  if (!code) {
    return NextResponse.redirect(`${baseUrl}?error=missing_code`);
  }

  const session = await getSession();

  if (!state || state !== session.oauthState) {
    return NextResponse.redirect(`${baseUrl}?error=invalid_state`);
  }

  // Exchange code for tokens
  const tokenRes = await fetch("https://api.hubapi.com/oauth/v1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: process.env.HUBSPOT_CLIENT_ID!,
      client_secret: process.env.HUBSPOT_CLIENT_SECRET!,
      redirect_uri: process.env.HUBSPOT_REDIRECT_URI!,
      code,
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    console.error("[auth/callback] Token exchange failed:", err);
    return NextResponse.redirect(`${baseUrl}?error=token_exchange_failed`);
  }

  const tokens = await tokenRes.json();

  // Fetch portal ID
  let portalId = "";
  try {
    const meRes = await fetch("https://api.hubapi.com/account-info/v3/details", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (meRes.ok) {
      const meData = await meRes.json();
      portalId = String(meData.portalId);
    }
  } catch {
    // Non-critical — proceed without portal ID
  }

  // Store in session
  session.accessToken = tokens.access_token;
  session.refreshToken = tokens.refresh_token;
  session.expiresAt = Date.now() + tokens.expires_in * 1000;
  session.portalId = portalId;
  session.oauthState = undefined;
  await session.save();

  return NextResponse.redirect(baseUrl);
}
