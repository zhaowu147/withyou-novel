import { type NextRequest, NextResponse } from "next/server";

import { checkLocalOrigin } from "@/lib/api/local-origin-guard";

/**
 * 全局本机来源防线：exe 交付后任意网页都能对 localhost 端口发请求，
 * 这里统一挡掉跨源与非本机访问（细节见 local-origin-guard.ts）。
 */
export function proxy(request: NextRequest) {
  const verdict = checkLocalOrigin({
    requestUrl: request.url,
    hostHeader: request.headers.get("host"),
    originHeader: request.headers.get("origin"),
    forwardedFor: request.headers.get("x-forwarded-for"),
    allowNonLoopback: process.env.WITHYOU_ALLOW_LAN === "1",
  });
  if (!verdict.ok) {
    return NextResponse.json({ success: false, error: verdict.reason }, { status: verdict.status });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
