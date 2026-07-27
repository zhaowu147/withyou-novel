import { NextResponse } from "next/server";

import { AUTH_ROUTES } from "@/lib/auth/routes";

/** 本地模式：登出无操作 */
export async function POST() {
  return NextResponse.json({ ok: true, redirectTo: AUTH_ROUTES.login });
}
