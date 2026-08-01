import assert from "node:assert/strict";
import { test } from "node:test";

import { getCodingEnvironmentStatus } from "../src/lib/pi/coding-environment";
import { validateCodingCommand } from "../src/lib/pi/coding-tools";
import { getSourceAccessStatus, SOURCE_UNLOCK_PHRASE } from "../src/lib/pi/source-permissions";

test("coding environment reports tool inventory without exposing environment values", () => {
  const status = getCodingEnvironmentStatus(process.cwd());
  assert.equal(typeof status.ready, "boolean");
  assert.ok(status.tools.some((tool) => tool.name === "node"));
  assert.ok(status.tools.every((tool) => !("token" in tool) && !("secret" in tool)));
});

test("coding command policy allows project checks and blocks destructive shell escape", () => {
  assert.doesNotThrow(() => validateCodingCommand("pnpm exec tsc --noEmit"));
  assert.doesNotThrow(() => validateCodingCommand("git status --short"));
  assert.throws(() => validateCodingCommand("powershell -Command Get-ChildItem"));
  assert.throws(() => validateCodingCommand("git reset --hard HEAD"));
  assert.throws(() => validateCodingCommand("pnpm test > result.txt"));
});

test("Pi coding Agent is available without a third-tier unlock", () => {
  const status = getSourceAccessStatus("test-workspace", "");
  assert.equal(status.unlocked, status.available);
  assert.equal(SOURCE_UNLOCK_PHRASE, "");
});
