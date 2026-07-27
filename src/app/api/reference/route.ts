/**
 * /api/reference — 小说参考已下架
 * 保留路由避免旧客户端 404 噪音；统一 410。
 */
import { apiError } from "@/lib/api/response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return apiError("小说参考功能已下架", 410, "REFERENCE_RETIRED");
}
