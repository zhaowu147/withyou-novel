/**
 * 本机来源校验（纯函数，无运行时依赖，middleware / route 通用）。
 *
 * 威胁模型：exe 交付后应用监听 localhost，任意网页都能对 http://127.0.0.1:<port>
 * 发起跨源请求（CSRF）命中 delete_project 等写接口；DNS rebinding 则能把
 * 恶意域名解析到 127.0.0.1 直接读取数据。防线：
 *   1. Host 必须是 loopback（挡 rebinding —— 此时 Host 是恶意域名）；
 *   2. 带 Origin 的请求必须与本站同源（挡跨源 fetch / 表单 POST —— 现代浏览器
 *      对非 GET 一律携带 Origin；沙箱 iframe 的 "null" 也会被拒）；
 *   3. x-forwarded-for 出现非 loopback 地址视为经代理的远程访问，拒绝。
 * 无 Origin 的请求（同源导航、curl、服务端自调用）不受影响。
 */

export interface OriginCheckInput {
  /** 完整请求 URL（request.url） */
  requestUrl: string;
  /**
   * HTTP Host 头原文。必须显式传入：Next 构造 request.url 用的是监听地址而非
   * Host 头，DNS rebinding 时 url.hostname 恒为 127.0.0.1，只有 Host 头会暴露
   * 恶意域名（已在本地 dev 实测验证）。
   */
  hostHeader: string | null;
  originHeader: string | null;
  forwardedFor: string | null;
  /** WITHYOU_ALLOW_LAN=1 时放开 Host 的 loopback 限制（局域网自用逃生门） */
  allowNonLoopback?: boolean;
}

export type OriginCheckResult = { ok: true } | { ok: false; status: number; reason: string };

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized.startsWith("127.") ||
    normalized === "::ffff:127.0.0.1"
  );
}

/** 从 Host 头（host[:port]，含 IPv6 字面量）提取 hostname；解析失败返回 null。 */
function hostnameFromHostHeader(hostHeader: string): string | null {
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return null;
  }
}

export function checkLocalOrigin(input: OriginCheckInput): OriginCheckResult {
  let url: URL;
  try {
    url = new URL(input.requestUrl);
  } catch {
    return { ok: false, status: 400, reason: "请求地址无效" };
  }

  if (!input.allowNonLoopback) {
    // 以 Host 头为准（见 OriginCheckInput.hostHeader 注释）；缺失时退回 url.hostname。
    const effectiveHost = input.hostHeader ? hostnameFromHostHeader(input.hostHeader) : url.hostname;
    if (!effectiveHost || !isLoopbackHostname(effectiveHost)) {
      return { ok: false, status: 403, reason: "本应用仅允许本机访问" };
    }
  }

  if (input.originHeader) {
    let originUrl: URL;
    try {
      originUrl = new URL(input.originHeader);
    } catch {
      // 包含沙箱 iframe / file:// 场景的 Origin: "null"
      return { ok: false, status: 403, reason: "请求来源无效" };
    }
    if (originUrl.origin !== url.origin) {
      return { ok: false, status: 403, reason: "已拒绝跨来源请求" };
    }
    if (!input.allowNonLoopback && !isLoopbackHostname(originUrl.hostname)) {
      return { ok: false, status: 403, reason: "已拒绝非本机来源请求" };
    }
  }

  const forwarded = input.forwardedFor?.split(",")[0]?.trim();
  if (forwarded && !isLoopbackHostname(forwarded)) {
    return { ok: false, status: 403, reason: "已拒绝经代理的远程请求" };
  }

  return { ok: true };
}
