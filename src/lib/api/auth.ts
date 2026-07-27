/**
 * 本地模式认证：固定单用户，无远端鉴权
 */
import { LOCAL_USER } from "@/lib/local/constants";

export async function getApiUser() {
  return {
    id: LOCAL_USER.id,
    email: LOCAL_USER.email,
    user_metadata: { ...LOCAL_USER.user_metadata },
    app_metadata: {},
    aud: "local",
    created_at: "2020-01-01T00:00:00.000Z",
  };
}
