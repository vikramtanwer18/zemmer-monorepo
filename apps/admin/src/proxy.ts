import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

// Routing convenience only (D-05): checks that a platform session cookie exists. Every page and
// action verifies the session and the OTP step server-side.

const PUBLIC = new Set(["/sign-in", "/forgot-password", "/reset-password"]);

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (
    !PUBLIC.has(pathname) &&
    // Test checkout for gym owners (dev only; the page itself 404s unless enabled).
    !pathname.startsWith("/dev/") &&
    !getSessionCookie(request, { cookiePrefix: "gymadmin" })
  ) {
    const url = new URL("/sign-in", request.url);
    if (pathname !== "/") url.searchParams.set("next", pathname + search);
    return NextResponse.redirect(url);
  }
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", pathname);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/((?!_next/|api/|favicon\\.ico|.*\\.[A-Za-z0-9]+$).*)"],
};
