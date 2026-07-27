import { NextResponse } from "next/server";

import { AUTH_ROUTES } from "@/lib/auth/routes";

/** 本地模式：OAuth callback 直接回工作室 */
export async function GET(request: Request) {
  const { origin } = new URL(request.url);
  return NextResponse.redirect(new URL(AUTH_ROUTES.afterAuth, origin));
}
