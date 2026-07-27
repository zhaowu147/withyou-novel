import { redirect } from "next/navigation";

import { AUTH_ROUTES } from "@/lib/auth/routes";

/** 本地单用户模式无需注册；Web 模式未来在此正式入口接入注册流程。 */
export default function RegisterPage() {
  redirect(AUTH_ROUTES.afterAuth);
}
