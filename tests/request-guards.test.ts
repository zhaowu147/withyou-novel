import { enforceRateLimit, RequestGuardError, readJsonBody } from "../src/lib/api/request-guards";
import assert from "node:assert/strict";
import { test } from "node:test";

test("rejects a declared oversized request before reading it", async () => {
  const request = new Request("http://localhost/api/test", {
    method: "POST",
    headers: { "content-length": "1025" },
    body: "{}",
  });
  await assert.rejects(
    () => readJsonBody(request, 1024),
    (error: unknown) => {
      return error instanceof RequestGuardError && error.status === 413;
    },
  );
});

test("rejects an oversized body when content-length is absent", async () => {
  const request = new Request("http://localhost/api/test", {
    method: "POST",
    body: JSON.stringify({ value: "x".repeat(2_000) }),
  });
  request.headers.delete("content-length");
  await assert.rejects(() => readJsonBody(request, 128), RequestGuardError);
});

test("parses JSON within the configured limit", async () => {
  const request = new Request("http://localhost/api/test", { method: "POST", body: JSON.stringify({ ok: true }) });
  assert.deepEqual(await readJsonBody(request, 1024), { ok: true });
});

test("rate limiter rejects calls beyond the window allowance", () => {
  const key = `test:${crypto.randomUUID()}`;
  enforceRateLimit(key, 2);
  enforceRateLimit(key, 2);
  assert.throws(
    () => enforceRateLimit(key, 2),
    (error: unknown) => {
      return error instanceof RequestGuardError && error.status === 429;
    },
  );
});
