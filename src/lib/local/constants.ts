/**
 * 本地模式常量 — 无 Node API，Server/Client 均可引用
 */
export const LOCAL_USER_ID = "local-user";

export const LOCAL_USER = {
  id: LOCAL_USER_ID,
  email: "local@localhost",
  user_metadata: { full_name: "本地作者" },
} as const;
