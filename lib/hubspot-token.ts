import { getSession } from "./session";

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

export async function getHubSpotToken(): Promise<string> {
  const session = await getSession();

  if (!session.accessToken || !session.refreshToken) {
    throw new AuthError("Not authenticated");
  }

  // Check if token is expired or near expiry
  if (session.expiresAt && Date.now() + REFRESH_BUFFER_MS >= session.expiresAt) {
    const refreshRes = await fetch("https://api.hubapi.com/oauth/v1/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: process.env.HUBSPOT_CLIENT_ID!,
        client_secret: process.env.HUBSPOT_CLIENT_SECRET!,
        refresh_token: session.refreshToken,
      }),
    });

    if (!refreshRes.ok) {
      // Refresh failed — clear session, force re-auth
      session.destroy();
      throw new AuthError("Session expired — please re-authenticate");
    }

    const tokens = await refreshRes.json();
    session.accessToken = tokens.access_token;
    session.refreshToken = tokens.refresh_token;
    session.expiresAt = Date.now() + tokens.expires_in * 1000;
    await session.save();
  }

  return session.accessToken!;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}
