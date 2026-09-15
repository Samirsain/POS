import { NextResponse, type NextRequest } from "next/server";

/**
 * Optional shared access code. There are no user accounts in this build by
 * decision — this is the single knob that stops a public URL from minting
 * numbered money receipts for anyone who finds it.
 *
 * Unset (the default): the site is open.
 * Set ACCESS_CODE in Vercel: visit /?code=<value> once, then the cookie carries it.
 */
export function proxy(request: NextRequest) {
  const code = process.env.ACCESS_CODE;
  if (!code) return NextResponse.next();

  if (request.cookies.get("access")?.value === code) return NextResponse.next();

  if (request.nextUrl.searchParams.get("code") === code) {
    const url = request.nextUrl.clone();
    url.searchParams.delete("code");
    const response = NextResponse.redirect(url);
    response.cookies.set("access", code, {
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: 60 * 60 * 24 * 90,
    });
    return response;
  }

  // 404 rather than 401: nothing here advertises that a code exists.
  return new NextResponse("Not found", { status: 404 });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
