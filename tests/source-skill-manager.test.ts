import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { resetDataRootCache } from "../src/lib/runtime/app-paths";
import { installSourceSkill, listSourceSkills, readSourceSkillResource } from "../src/lib/pi/source-skill-manager";

test("源码 Skill 安装资源后会校验资源完整性并按需读取", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "withyou-source-skill-"));
  const previous = process.env.WITHYOU_DATA_DIR;
  process.env.WITHYOU_DATA_DIR = root;
  resetDataRootCache();
  try {
    const installed = installSourceSkill({
      id: "docs-skill",
      content: "---\nname: docs-skill\ndescription: docs\n---\nRead references/guide.md",
      resources: [{ path: "references/guide.md", content: "safe reference" }],
    });
    assert.equal(installed.integrity, "local");
    assert.equal(readSourceSkillResource("docs-skill", "references/guide.md"), "safe reference");

    const resource = path.join(path.dirname(installed.filePath), "resources", "references", "guide.md");
    fs.writeFileSync(resource, "tampered", "utf8");
    assert.equal(listSourceSkills()[0].integrity, "mismatch");
    assert.throws(() => readSourceSkillResource("docs-skill", "references/guide.md"), /完整性/);
  } finally {
    if (previous === undefined) delete process.env.WITHYOU_DATA_DIR;
    else process.env.WITHYOU_DATA_DIR = previous;
    resetDataRootCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
