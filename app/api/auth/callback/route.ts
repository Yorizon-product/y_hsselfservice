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
      redirect_uri: process.env.HUBSPOT_REDIRECT_URI || `${new URL("/api/auth/callback", req.url).toString()}`,
      code,
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    console.error("[auth/callback] Token exchange failed:", err);
    return NextResponse.redirect(`${baseUrl}?error=token_exchange_failed`);
  }

  const tokens = await tokenRes.json();

  // Store tokens in session
  session.accessToken = tokens.access_token;
  session.refreshToken = tokens.refresh_token;
  session.expiresAt = Date.now() + tokens.expires_in * 1000;
  session.oauthState = undefined;

  // Fetch portal ID and user email
  try {
    const meRes = await fetch("https://api.hubapi.com/account-info/v3/details", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (meRes.ok) {
      const meData = await meRes.json();
      session.portalId = String(meData.portalId);
    }
  } catch {
    // Non-critical
  }

  try {
    const tokenInfo = await fetch(
      `https://api.hubapi.com/oauth/v1/access-tokens/${tokens.access_token}`
    );
    if (tokenInfo.ok) {
      const info = await tokenInfo.json();
      if (info.user) session.userEmail = info.user;
    }
  } catch {
    // Non-critical
  }

  await session.save();

  console.log(`[audit] OAuth login: ${session.userEmail || "unknown"} (portal ${session.portalId || "?"})`);
  return NextResponse.redirect(baseUrl);
}
