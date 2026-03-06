import { NextRequest, NextResponse } from "next/server";

function fromBase64(encoded: string): string {
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function middleware(req: NextRequest) {
  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASS;

  // Skip auth if env vars aren't set or if DISABLE_AUTH is set (for testing)
  if (!user || !pass || process.env.DISABLE_AUTH === "1") return NextResponse.next();

  const auth = req.headers.get("authorization");
  if (auth) {
    const [scheme, encoded] = auth.split(" ");
    if (scheme === "Basic" && encoded) {
      const decoded = fromBase64(encoded);
      const idx = decoded.indexOf(":");
      if (idx !== -1) {
        const u = decoded.slice(0, idx);
        const p = decoded.slice(idx + 1);
        if (u === user && p === pass) {
          return NextResponse.next();
        }
      }
    }
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Restricted"' },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
