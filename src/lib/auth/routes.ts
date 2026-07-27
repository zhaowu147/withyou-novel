/** 应用内认证路径的唯一来源，避免再次出现 /v2、auth-new 等并存入口。 */
export const AUTH_ROUTES = {
  login: "/auth/login",
  register: "/auth/register",
  verifyEmail: "/auth/verify-email",
  callback: "/auth/callback",
  logoutApi: "/api/auth/logout",
  afterAuth: "/studio",
} as const;
