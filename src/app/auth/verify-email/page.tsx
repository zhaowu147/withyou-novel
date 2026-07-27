import { redirect } from "next/navigation";

import { AUTH_ROUTES } from "@/lib/auth/routes";

/** 本地单用户模式无需邮箱验证。 */
export default function VerifyEmailPage() {
  redirect(AUTH_ROUTES.afterAuth);
}
