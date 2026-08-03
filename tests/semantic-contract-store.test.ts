import NovelFileSystem from "../src/lib/novel-fs";
import {
  claimSemanticContractExecution,
  collectSemanticSourceReferences,
  confirmSemanticContract,
  createSemanticContract,
  readLockedSemanticContract,
  readSemanticContract,
  saveSemanticContractVersion,
  semanticContractHash,
  staleSemanticSources,
} from "../src/lib/semantic-alignment/store";
import type { SemanticContract } from "../src/lib/semantic-alignment/types";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

function draft(novelId: string): SemanticContract {
  const now = "2026-07-30T00:00:00.000Z";
  return {
    id: "contract-store-test",
    projectId: novelId,
    taskId: "task-store-test",
    sessionId: "workspace-store-test",
    taskKind: "writer",
    version: 1,
    status: "awaiting_confirmation",
    createdAt: now,
    updatedAt: now,
    originalUserInput: "保持人物状态，续写下一段",
    taskSummary: "续写",
    intendedOutcome: "连续推进",
    excludedScope: [],
    interpretations: [],
    constraints: [
      {
        id: "preserve-state",
        type: "preserve",
        description: "保持人物当前状态",
        source: "current_user_input",
        priority: 100,
      },
    ],
    assumptions: [],
    ambiguities: [],
    plannedDecisions: [],
    riskLevel: "medium",
    confirmationMode: "user_required",
    sourceReferences: collectSemanticSourceReferences(novelId),
    userEdits: [],
  };
}

test("语义契约版本与确认快照不可覆盖，项目事实变化可判定过期", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "withyou-contracts-"));
  const previous = process.env.NOVELS_BASE_DIR;
  process.env.NOVELS_BASE_DIR = root;
  try {
    const novelId = "契约存储测试";
    const novelFs = new NovelFileSystem();
    novelFs.createProject(novelId);
    novelFs.writeFile(novelId, "设定/世界观/世界设定.md", "城市实行夜间宵禁。");

    const created = await createSemanticContract(draft(novelId));
    const confirmed = await confirmSemanticContract(novelId, created.id, 1);
    assert.equal(confirmed.status, "confirmed");
    assert.equal(confirmed.contentHash, semanticContractHash(confirmed));
    const locked = readLockedSemanticContract(novelId, created.id, 1);
    assert.equal(locked?.contentHash, confirmed.contentHash);
    assert.deepEqual(staleSemanticSources(novelId, confirmed), []);

    await claimSemanticContractExecution(novelId, created.id, 1);
    await assert.rejects(claimSemanticContractExecution(novelId, created.id, 1), /不能重复或并发执行/);

    const next: SemanticContract = {
      ...confirmed,
      version: 2,
      status: "awaiting_confirmation",
      taskSummary: "续写并压缩对白",
      confirmedAt: undefined,
      contentHash: undefined,
      updatedAt: "2026-07-30T00:01:00.000Z",
    };
    await saveSemanticContractVersion(next, 1);
    assert.equal(readSemanticContract(novelId, created.id)?.version, 2);
    assert.equal(readLockedSemanticContract(novelId, created.id, 1)?.taskSummary, "续写");

    novelFs.writeFile(novelId, "设定/世界观/世界设定.md", "城市取消了夜间宵禁。");
    assert.ok(staleSemanticSources(novelId, confirmed).includes("设定/世界观/世界设定.md"));
  } finally {
    if (previous === undefined) delete process.env.NOVELS_BASE_DIR;
    else process.env.NOVELS_BASE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
