import type { NextRequest } from "next/server";

// In standalone mode behind a reverse proxy (Caddy on yorizoncasey),
// `req.url` reflects the internal bind address (http://0.0.0.0:8081/...)
// not the public hostname users typed in. Building redirects off that
// sends browsers to 0.0.0.0:8081 — wrong.
//
// Caddy adds `X-Forwarded-Host` + `X-Forwarded-Proto` automatically
// (our explicit `header_up` lines were redundant); use them when present
// and fall back to the request's own URL for local dev where there's
// no proxy.
export function publicOrigin(req: NextRequest): string {
  const fwdHost = req.headers.get("x-forwarded-host");
  const fwdProto = req.headers.get("x-forwarded-proto");
  if (fwdHost) {
    return `${fwdProto ?? "https"}://${fwdHost}`;
  }
  return new URL(req.url).origin;
}

export function publicUrl(req: NextRequest, path: string): string {
  return `${publicOrigin(req)}${path.startsWith("/") ? path : `/${path}`}`;
}
