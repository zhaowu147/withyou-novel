import assert from "node:assert/strict";
import test from "node:test";

import {
  downloadSourceSkillCatalogItem,
  searchSourceSkillCatalog,
  sourceSkillCatalogInternals,
} from "../src/lib/pi/source-skill-catalog";

test("受限 GitHub 目录可检索并只下载 Skill 指令与文档资源", async () => {
  const mockFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/git/trees/HEAD?recursive=1")) {
      if (url.includes("vercel-labs/skills")) return Response.json({ tree: [] });
      return Response.json({
        tree: [
          { type: "blob", path: "skills/demo/SKILL.md" },
          { type: "blob", path: "skills/demo/references/guide.md" },
          { type: "blob", path: "skills/demo/scripts/run.sh" },
        ],
      });
    }
    if (url.endsWith("skills/demo/SKILL.md")) {
      return new Response("---\nname: demo\ndescription: Demo skill\nversion: 1.2.3\n---\nUse the guide.");
    }
    if (url.endsWith("skills/demo/references/guide.md")) return new Response("Reference guide");
    return new Response("missing", { status: 404 });
  }) as typeof fetch;

  const results = await searchSourceSkillCatalog("demo", 4, mockFetch);
  assert.equal(results.length, 1);
  assert.equal(results[0].catalog, "github-curated");

  const bundle = await downloadSourceSkillCatalogItem(results[0], mockFetch);
  assert.equal(bundle.name, "demo");
  assert.equal(bundle.version, "1.2.3");
  assert.deepEqual(bundle.resources, [{ path: "references/guide.md", content: "Reference guide" }]);
});

test("Skill 目录路径与 ID 规范化拒绝越界输入", () => {
  assert.equal(sourceSkillCatalogInternals.safeRelativePath("references/guide.md"), "references/guide.md");
  assert.equal(sourceSkillCatalogInternals.safeRelativePath("../secret.md"), null);
  assert.equal(sourceSkillCatalogInternals.safeRelativePath("scripts/run.sh"), null);
  assert.match(sourceSkillCatalogInternals.safeId("GitHub/OpenAI/skills/demo"), /^[a-z0-9-]{1,64}$/);
});
