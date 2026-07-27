import { type NextRequest, NextResponse } from "next/server";

import { getApiUser } from "@/lib/api/auth";

/**
 * Env var health check — disabled in production.
 * Returns partial info only for authenticated users.
 */
export async function GET(_req: NextRequest) {
  // 生产环境直接禁用
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "disabled" }, { status: 404 });
  }

  // dev 下也要求必须是已登录用户
  const user = await getApiUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    has_base: !!process.env.STEPFUN_API_BASE,
    base_val: process.env.STEPFUN_API_BASE || "(empty)",
    has_chat_key: !!process.env.STEPFUN_KEY_CHAT,
    has_dispatch_key: !!process.env.STEPFUN_KEY_DISPATCH,
    has_tool_key: !!process.env.STEPFUN_KEY_TOOL,
    has_write_key: !!process.env.STEPFUN_KEY_WRITE,
    model_chat: process.env.STEPFUN_MODEL_CHAT || "(empty)",
  });
}
