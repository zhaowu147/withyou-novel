/**
 * 本机来源防线回归测试（middleware 与源码维护接口共用的 checkLocalOrigin）。
 *
 * 核心断言：exe 交付后，任意外部网页对 localhost 端口的跨源请求必须被拒，
 * 而本机同源前端、无 Origin 的正常导航与 curl 不受影响。
 */

import { checkLocalOrigin, isLoopbackHostname } from "../src/lib/api/local-origin-guard";
import assert from "node:assert/strict";
import { test } from "node:test";

const LOCAL = "http://localhost:3000/api/novels/abc";

function check(overrides: Partial<Parameters<typeof checkLocalOrigin>[0]> = {}) {
  return checkLocalOrigin({
    requestUrl: LOCAL,
    hostHeader: "localhost:3000",
    originHeader: null,
    forwardedFor: null,
    ...overrides,
  });
}

test("isLoopbackHostname：localhost/127.x/::1 是本机，其余不是", () => {
  assert.ok(isLoopbackHostname("localhost"));
  assert.ok(isLoopbackHostname("127.0.0.1"));
  assert.ok(isLoopbackHostname("127.8.8.8"));
  assert.ok(isLoopbackHostname("::1"));
  assert.ok(isLoopbackHostname("[::1]"));
  assert.ok(!isLoopbackHostname("192.168.1.5"));
  assert.ok(!isLoopbackHostname("evil.com"));
});

test("无 Origin 的本机请求放行（导航 / curl / 服务端自调用）", () => {
  assert.deepEqual(check(), { ok: true });
  assert.deepEqual(check({ requestUrl: "http://127.0.0.1:3000/api/x" }), { ok: true });
});

test("同源 Origin 放行（本机前端 fetch POST）", () => {
  assert.deepEqual(check({ originHeader: "http://localhost:3000" }), { ok: true });
});

test("localhost 与 127.0.0.1 的同端口回环别名放行", () => {
  assert.deepEqual(
    checkLocalOrigin({
      requestUrl: "http://localhost:3211/api/workspaces/activate",
      hostHeader: "127.0.0.1:3211",
      originHeader: "http://127.0.0.1:3211",
      forwardedFor: null,
    }),
    { ok: true },
  );
});

test("跨源 Origin 一律拒绝（外部网页 CSRF 主路径）", () => {
  const r = check({ originHeader: "https://evil.com" });
  assert.equal(r.ok, false);
  // 同为 loopback 但端口不同也算跨源（另一个本地应用不能打这个端口）
  const r2 = check({ originHeader: "http://localhost:5500" });
  assert.equal(r2.ok, false);
  // 127.0.0.1 与 localhost 同端口属于本机别名兼容路径，换端口仍拒绝
  const r3 = check({ originHeader: "http://127.0.0.1:3001" });
  assert.equal(r3.ok, false);
});

test('Origin: "null"（沙箱 iframe / file://）拒绝', () => {
  const r = check({ originHeader: "null" });
  assert.equal(r.ok, false);
});

test("Host 头非 loopback（DNS rebinding）拒绝，即使 request.url 是 127.0.0.1", () => {
  // 实测：Next 用监听地址构造 request.url，rebinding 时只有 Host 头暴露恶意域名。
  const rebind = check({
    requestUrl: "http://127.0.0.1:3000/api/settings",
    hostHeader: "evil-rebind.com",
  });
  assert.equal(rebind.ok, false);
  const rebindWithPort = check({ hostHeader: "evil.com:3000" });
  assert.equal(rebindWithPort.ok, false);
  // IPv6 字面量 Host 头能正确解析
  assert.deepEqual(check({ hostHeader: "[::1]:3000" }), { ok: true });
});

test("Host 头缺失时退回 url.hostname 校验；WITHYOU_ALLOW_LAN 逃生门放行", () => {
  const noHost = check({ requestUrl: "http://evil-rebind.com:3000/api/novels", hostHeader: null });
  assert.equal(noHost.ok, false);
  const lan = check({
    requestUrl: "http://192.168.1.10:3000/api/novels",
    hostHeader: "192.168.1.10:3000",
    allowNonLoopback: true,
  });
  assert.deepEqual(lan, { ok: true });
});

test("x-forwarded-for 出现远程地址拒绝（经反代访问）", () => {
  const r = check({ forwardedFor: "203.0.113.9" });
  assert.equal(r.ok, false);
  assert.deepEqual(check({ forwardedFor: "127.0.0.1" }), { ok: true });
});
