import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

// Routing convenience only, never a security boundary (D-05): it only checks that a session
// cookie exists. Every page and action re-verifies the session, tenant and permissions.

const PUBLIC_PATHS = [
  "/sign-in",
  "/sign-up",
  "/check-email",
  "/forgot-password",
  "/reset-password",
  "/invite/",
  "/join/",
  // Development-only fake payment checkout (404 unless PAYMENTS_FAKE_ENABLED).
  "/dev/",
  // Design-system showcase: the page itself returns 404 unless enabled.
  "/ui",
  // M5: public lead capture forms (and their embed) and trial passes.
  "/l/",
  "/t/",
  // M7: referral links.
  "/r/",
];

function isPublic(pathname: string) {
  return (
    pathname.startsWith("/m/") ||
    PUBLIC_PATHS.some((p) =>
      p.endsWith("/") ? pathname.startsWith(p) : pathname === p,
    )
  );
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  // The member app's canonical URL is /m/ so it sits inside the service worker scope "/m/".
  if (pathname === "/m") {
    // A plain URL: cloning nextUrl would strip the trailing slash again.
    const url = new URL("/m/", request.url);
    url.search = search;
    return NextResponse.redirect(url, 308);
  }

  if (
    !isPublic(pathname) &&
    !getSessionCookie(request, { cookiePrefix: "gym" })
  ) {
    const url = new URL("/sign-in", request.url);
    if (pathname !== "/") url.searchParams.set("next", pathname + search);
    return NextResponse.redirect(url);
  }

  // Layouts can't see the path; pass it on for navigation highlighting.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", pathname);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  // Everything except Next.js internals, API routes and files with an extension.
  matcher: ["/((?!_next/|api/|favicon\\.ico|.*\\.[A-Za-z0-9]+$).*)"],
};
