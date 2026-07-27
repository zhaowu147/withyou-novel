import { redirect } from "next/navigation";

import { AUTH_ROUTES } from "@/lib/auth/routes";

/** 本地单用户模式无需登录；Web 模式未来在此正式入口接入认证表单。 */
export default function LoginPage() {
  redirect(AUTH_ROUTES.afterAuth);
}
