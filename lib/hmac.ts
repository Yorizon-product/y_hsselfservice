import { createHmac, timingSafeEqual } from "node:crypto";

// HubSpot Webhook v3 signature verification.
//
// Signing string: METHOD + URL + body + timestamp.
// Hash:           HMAC-SHA256(secret, signing-string), then base64.
// Header:         X-HubSpot-Signature-V3 (case-insensitive in Node).
// Timestamp:      X-HubSpot-Request-Timestamp, epoch ms (sometimes seconds).
// Skew window:    5 minutes (HubSpot's recommendation).
//
// The URL must be the EXACT URL HubSpot called — that's what they signed.
// We pass it in explicitly (built from a configured public origin, not from
// request headers) because Caddy's Host/X-Forwarded-Host may differ from
// what HubSpot actually hit.

export const SIGNATURE_MAX_AGE_SECONDS = 5 * 60;

export function computeSignature(
  secret: string,
  method: string,
  url: string,
  body: string,
  timestamp: string
): string {
  const msg = method.toUpperCase() + url + body + timestamp;
  return createHmac("sha256", secret).update(msg, "utf8").digest("base64");
}

export type VerifyArgs = {
  secret: string;
  method: string;
  url: string;
  body: string;
  signatureHeader: string | null | undefined;
  timestampHeader: string | null | undefined;
  nowSeconds?: number;
};

export function verifySignature(args: VerifyArgs): boolean {
  const { secret, method, url, body, signatureHeader, timestampHeader, nowSeconds } = args;
  if (!signatureHeader || !timestampHeader) return false;

  const rawTs = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(rawTs)) return false;
  // HubSpot sends epoch milliseconds; accept seconds too as a safety net.
  const tsSeconds = rawTs > 10_000_000_000 ? Math.floor(rawTs / 1000) : rawTs;
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - tsSeconds) > SIGNATURE_MAX_AGE_SECONDS) return false;

  const expected = computeSignature(secret, method, url, body, timestampHeader);
  // Constant-time compare. Buffers must be the same length or
  // timingSafeEqual throws — return false up-front in that case.
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signatureHeader, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
