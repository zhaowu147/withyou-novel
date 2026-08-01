import assert from "node:assert/strict";
import { test } from "node:test";

import { getCodingEnvironmentStatus } from "../src/lib/pi/coding-environment";
import { validateCodingCommand, validateGitHubRepository, validateGitHubSkillPath } from "../src/lib/pi/coding-tools";
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
  assert.doesNotThrow(() => validateCodingCommand("python -m pip install pandas"));
  assert.doesNotThrow(() => validateCodingCommand("uv sync"));
  assert.throws(() => validateCodingCommand("powershell -Command Get-ChildItem"));
  assert.throws(() => validateCodingCommand("git reset --hard HEAD"));
  assert.throws(() => validateCodingCommand("git commit -m test"));
  assert.throws(() => validateCodingCommand("pnpm test > result.txt"));
  assert.throws(() => validateCodingCommand("git push"));
});

test("GitHub tools accept repository identifiers without allowing argument injection", () => {
  assert.equal(validateGitHubRepository("owner/repository"), "owner/repository");
  assert.throws(() => validateGitHubRepository("owner/repository --web"));
  assert.throws(() => validateGitHubRepository("../repository"));
});

test("GitHub Skill paths are repository-local SKILL.md files", () => {
  assert.equal(validateGitHubSkillPath("skills/data-analysis/SKILL.md"), "skills/data-analysis/SKILL.md");
  assert.throws(() => validateGitHubSkillPath("../SKILL.md"));
  assert.throws(() => validateGitHubSkillPath("skills/data-analysis/README.md"));
});

test("Pi coding Agent is available without a third-tier unlock", () => {
  const status = getSourceAccessStatus("test-workspace", "");
  assert.equal(status.unlocked, status.available);
  assert.equal(SOURCE_UNLOCK_PHRASE, "");
});
