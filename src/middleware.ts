import { NextResponse, type NextRequest } from "next/server";

// Edge-safe gate: checks only for the session cookie's presence and redirects
// anonymous visitors to /login. Real authentication AND authorization happen
// server-side in every page/route via auth() + requireActiveMember — this is
// UX routing, not the security boundary.
export function middleware(request: NextRequest) {
  const hasSession =
    request.cookies.has("authjs.session-token") ||
    request.cookies.has("__Secure-authjs.session-token");

  if (!hasSession) {
    const login = new URL("/login", request.url);
    login.searchParams.set("from", request.nextUrl.pathname);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/groups/:path*"],
};
