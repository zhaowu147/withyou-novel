const requestLog = new Map<string, number[]>();

export class RequestGuardError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 | 429,
    readonly code: string,
  ) {
    super(message);
    this.name = "RequestGuardError";
  }
}

export function enforceRateLimit(key: string, maxRequests: number, windowMs = 60_000): void {
  const now = Date.now();
  const recent = (requestLog.get(key) ?? []).filter((time) => now - time < windowMs);
  if (recent.length >= maxRequests) {
    throw new RequestGuardError("请求过于频繁，请稍后重试", 429, "RATE_LIMITED");
  }
  recent.push(now);
  requestLog.set(key, recent);
  if (requestLog.size > 2_000) {
    for (const [entryKey, times] of requestLog) {
      if (!times.some((time) => now - time < windowMs)) requestLog.delete(entryKey);
    }
  }
}

export function assertRequestSize(request: Request, maxBytes: number): void {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new RequestGuardError(`请求体不能超过 ${Math.ceil(maxBytes / 1024 / 1024)}MB`, 413, "PAYLOAD_TOO_LARGE");
  }
}

export async function readJsonBody<T>(request: Request, maxBytes: number): Promise<T> {
  assertRequestSize(request, maxBytes);
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maxBytes) {
    throw new RequestGuardError(`请求体不能超过 ${Math.ceil(maxBytes / 1024 / 1024)}MB`, 413, "PAYLOAD_TOO_LARGE");
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new RequestGuardError("请求体不是有效 JSON", 400, "INVALID_JSON");
  }
}
