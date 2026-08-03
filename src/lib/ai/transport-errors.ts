const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

export function transportErrorCode(error: unknown): string {
  for (const item of errorChain(error)) {
    const code = (item as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
  }
  return "";
}

export function transportErrorMessage(error: unknown): string {
  return errorChain(error)
    .map((item) => (item as { message?: unknown }).message)
    .filter((message): message is string => typeof message === "string" && Boolean(message))
    .join(": ");
}

export function isTransientTransportError(error: unknown): boolean {
  if (TRANSIENT_NETWORK_CODES.has(transportErrorCode(error))) return true;
  return /fetch failed|terminated|socket|other side closed|timed?\s*out|network/i.test(transportErrorMessage(error));
}
