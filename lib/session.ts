import { getIronSession, SessionOptions } from "iron-session";
import { cookies } from "next/headers";

export type SessionData = {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number; // Unix timestamp (ms)
  portalId?: string;
  userEmail?: string;
  // HubSpot numeric user ID for the OAuth-authenticating user. Passed as
  // `hubspot_owner_id` when creating companies — Yorizon's provisioning
  // automation (integration 27850292) silently rejects integration-sourced
  // companies whose owner is null. Captured at OAuth callback from the
  // /oauth/v1/access-tokens/{token} response's `user_id` field; also
  // lazy-populated in the create route for sessions that pre-date this
  // code.
  hubspotOwnerId?: string;
  oauthState?: string;
};

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  throw new Error("SESSION_SECRET env var is missing or too short (min 32 chars)");
}

export const sessionOptions: SessionOptions = {
  password: process.env.SESSION_SECRET,
  cookieName: "hs-selfservice-session",
  cookieOptions: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
  },
};

export async function getSession() {
  return getIronSession<SessionData>(await cookies(), sessionOptions);
}
