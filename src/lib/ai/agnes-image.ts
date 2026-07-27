/**
 * Agnes 图像 API — 封面生成
 * env:
 *   AGNES_API_KEY
 *   AGNES_API_BASE  (default https://apihub.agnes-ai.com/v1)
 *   AGNES_IMAGE_MODEL (default agnes-image-2.1-flash)
 */
import "server-only";

import { getRuntimeModelConfig } from "@/lib/settings/runtime-model-config";

export interface AgnesImageItem {
  url: string;
  revised_prompt?: string;
}

/** 从 OpenAI 兼容响应里抽出可用图片 URL（含 b64） */
export function normalizeAgnesImages(payload: unknown): AgnesImageItem[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;

  // 标准: { data: [{ url }] } 或 { data: [{ b64_json }] }
  const list =
    (Array.isArray(root.data) && root.data) ||
    (Array.isArray(root.images) && root.images) ||
    (Array.isArray(root.output) && root.output) ||
    [];

  const out: AgnesImageItem[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    let url = "";
    if (typeof item.url === "string" && item.url) url = item.url;
    else if (typeof item.image_url === "string" && item.image_url) url = item.image_url;
    else if (typeof item.b64_json === "string" && item.b64_json) {
      url = item.b64_json.startsWith("data:") ? item.b64_json : `data:image/png;base64,${item.b64_json}`;
    } else if (item.image_url && typeof item.image_url === "object") {
      const nested = item.image_url as Record<string, unknown>;
      if (typeof nested.url === "string") url = nested.url;
    }
    if (url) {
      out.push({
        url,
        revised_prompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
      });
    }
  }

  // 少数网关直接 { url: "..." }
  if (!out.length && typeof root.url === "string") {
    out.push({ url: root.url });
  }
  return out;
}

/** 短 prompt ~75–110s；长封面常 2–4 分钟。含 503 重试总预算。 */
const DEFAULT_TIMEOUT_MS = 300_000;
/** 上游 Service busy / rate limit 时最多再试几次 */
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 8_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function extractErrMsg(json: unknown, text: string, status: number): string {
  if (json && typeof json === "object") {
    const errObj = json as { error?: { message?: string }; message?: string; detail?: string };
    const m = errObj.error?.message ?? errObj.message ?? errObj.detail;
    if (typeof m === "string" && m) return m;
  }
  if (text) return text.slice(0, 240);
  return `HTTP ${status}`;
}

function isBusyStatus(status: number, msg: string): boolean {
  if (status === 429 || status === 503 || status === 502) return true;
  return /service\s*busy|overloaded|rate.?limit|try.?again|temporarily|unavailable|queue/i.test(msg);
}

async function oneShot(
  url: string,
  key: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ res: Response; text: string; json: unknown; ms: number }> {
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e: unknown) {
    const ms = Date.now() - t0;
    const name = e instanceof Error ? e.name : "";
    const msg = e instanceof Error ? e.message : String(e);
    if (/timeout|aborted|AbortError|TimeoutError/i.test(`${name} ${msg}`)) {
      throw new Error(
        `Agnes 生图超时（已等 ${Math.round(ms / 1000)}s / 上限 ${Math.round(timeoutMs / 1000)}s）。` +
          `单次常需 1–3 分钟；请重试。若持续超时，检查本机代理 7890 是否稳定。`,
      );
    }
    throw new Error(`Agnes 请求失败（${Math.round(ms / 1000)}s）: ${msg}`);
  }

  const text = await res.text();
  const ms = Date.now() - t0;
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { res, text, json, ms };
}

export async function generateAgnesImage(opts: {
  prompt: string;
  size?: string;
  n?: number;
  timeoutMs?: number;
}): Promise<{ images: AgnesImageItem[]; raw: unknown }> {
  const config = getRuntimeModelConfig("coverGeneration");
  if (!config.apiKey.trim()) throw new Error("未配置封面生成 API Key");
  if (!config.apiBase.trim()) throw new Error("未配置封面生成 API Base URL");
  if (!config.model.trim()) throw new Error("未配置封面生成模型");

  const key = config.apiKey;
  const url = `${config.apiBase}/images/generations`;
  const totalBudget = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const size = opts.size ?? "1024x1792";
  const body = {
    model: config.model,
    prompt: opts.prompt,
    n: opts.n ?? 1,
    size,
  };

  const wall0 = Date.now();
  let lastErr = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const spent = Date.now() - wall0;
    const remain = totalBudget - spent;
    if (remain < 15_000) {
      throw new Error(lastErr || `Agnes 总预算耗尽（${Math.round(spent / 1000)}s）。上游繁忙，请稍后再试。`);
    }

    // 单次尝试：留一点余量给重试等待
    const perTry = Math.min(
      remain - (attempt < MAX_ATTEMPTS ? RETRY_BASE_MS * attempt : 0),
      Math.ceil(totalBudget * 0.7),
    );
    const tryTimeout = Math.max(30_000, perTry);

    const { res, text, json, ms } = await oneShot(url, key, body, tryTimeout);
    console.info(
      `[agnes-image] attempt=${attempt}/${MAX_ATTEMPTS} ${res.status} ${ms}ms size=${size} model=${body.model}`,
    );

    if (res.ok) {
      const images = normalizeAgnesImages(json);
      if (!images.length) {
        throw new Error(`Agnes 返回成功但无图片 URL（${Math.round(ms / 1000)}s）。响应片段: ${text.slice(0, 240)}`);
      }
      return { images, raw: json };
    }

    const msg = extractErrMsg(json, text, res.status);
    lastErr = `Agnes 图像失败 ${res.status}（第${attempt}次 / ${Math.round(ms / 1000)}s）: ${msg}`;

    if (isBusyStatus(res.status, msg) && attempt < MAX_ATTEMPTS) {
      const wait = RETRY_BASE_MS * attempt + Math.floor(Math.random() * 2000);
      console.warn(`[agnes-image] busy ${res.status}, retry in ${wait}ms — ${msg.slice(0, 120)}`);
      await sleep(wait);
      continue;
    }

    // 不可重试 or 已用尽
    if (isBusyStatus(res.status, msg)) {
      throw new Error(
        `Agnes 上游繁忙（Service busy），已自动重试 ${attempt} 次仍失败。` +
          `请等 1–2 分钟再点生成。详情: ${msg.slice(0, 180)}`,
      );
    }
    throw new Error(lastErr);
  }

  throw new Error(lastErr || "Agnes 图像失败");
}
