# 交接说明 — withyou-novel（2026-07-27，Agent UI / 图谱对账轮）

给下一个接手的 Claude 会话和作者本人。本文件是快照，权威细节见桌面
project memory 的 `project_withyou_novel_architecture.md`（本地会话用 project_memory_read 读）。

---

## 0. 当前状态

**分支 `memory-isolation`，两个 commit，未合回 main。**

| commit | 内容 |
|---|---|
| `86eb78a` | feat: 记忆隔离三处漏洞 + 并发/CSRF 加固 + 数据安全止血（累积两轮功能改动） |
| `ed6c2d3` | chore: biome 历史遗留清理（纯机械，刻意与功能改动分开） |

`main` 还停在 `1dc782a`。要合并自己决定 —— 分开成两个 commit 就是为了让功能改动
的 diff 不被 174 个文件的格式化淹没。

三关（在 `ed6c2d3` 上实测）：

| 关卡 | 结果 |
|---|---|
| `pnpm exec tsc --noEmit` | ✅ 0 错误 |
| `pnpm test` | ✅ 123 测试 / 122 过 / 0 败 / 1 跳过（Windows symlink 权限，原有跳过项） |
| `pnpm check`（biome） | 159 errors / 106 warnings / 1 info（详见 §3.1，**有意保留**） |

已完成 Node 22 下的全量单测、生产构建和部分真实 HTTP 验收。图谱实体别名同步链路
已通过真实 API 验证：以别名建图后同步为唯一正式名节点，别名仍保留在 metadata。
Planner / Reviewer / Memory 的真实模型生成验收仍需要先配置功能区 API Key。

---

## 1. 已完成

### 1.1 记忆隔离三处漏洞（作者核心架构诉求）—— 本轮做完

**洞 1：generate 路由不再信任前端 `body.context`**

- 新增 `src/lib/novel/server-novel-data.ts` — 服务端从文件树回读 NovelData。
- 新增 `src/lib/tools/server-tool-context.ts` — **工具类模型调用的唯一服务端注入点**。
  复用前端同一份 `buildToolContext`，避免前后端各写一套导致漂移。
- 顺带把只在前端强制的 `TOOL_WORKFLOWS` 因果前置搬到服务端复核，
  前置不齐返回 409 `WORKFLOW_PREREQUISITE_MISSING`。此前直接打路由就能跳过。
- 前端 `tool-panel.tsx` 相应不再上送 context（省一次最多 48k 字符的传输）。

⚠️ **有意的行为差异**：`server-novel-data` 是**文件优先、meta 兜底**，
而 `/api/novels/[id]/data` 的 GET 是 meta 优先。理由写在文件头 —— 文件树是用户和
Pi agent 能直接改的那一面，要"回读文件树确认"就得以文件为准。正常路径（改动都经
data PUT 双写）两者一致，只有外部编辑过文件时才分叉，而那时文件本来就是对的。

⚠️ 配套坑：`createProject` 会给每个创作文件先落占位模板，"文件存在"≠"用户写过"。
模板已抽到 `src/lib/novel/project-scaffold.ts` 做单一真相源，回读侧靠逐字节比对
识别空模板。**改模板必须改这个文件**，别在 novel-fs 里内联字符串。

**洞 2：切断 consolidation 的自我放大**

- 新增 `src/lib/memory/provenance.ts`：作者事实=0、剧情块=1、阶段=2，
  硬约束 `depth(输入) < depth(输出)`。
- 旧的「上一阶段承接」读上一个 `stage_summary` —— 与产出同为 depth 2，等于
  阶段摘要接着阶段摘要写，一路传下去无限套娃。**这就是交接文件说的那条唯一
  自我放大路径**。改为读上一阶段末尾的 `block_summary`（depth 1），承接信息量
  相当但链条到此为止。
- 输入挑选逻辑抽成纯函数 `selectConsolidationInputs`（无 IO，单测直接打）。
- 派生 .md 落盘带层级告警行；召回注入 prompt 时带 `|派生dN` 标记。
- `syncCanonicalMemories` 加护栏：拒绝把 `派生记忆/` 下的东西同步成规范记忆。
- 旧数据没有 provenance 字段时按 kind 兜底判层级，不会被当成 depth 0。

**洞 3：实体别名对账**

- 新增 `src/lib/entities/alias-registry.ts`，`upsertEntity` 落库前先对账：
  显式 id > 归一化正式名 > 别名表。命中就合并，旧正式名收进别名表。
- 类型不同不合并（人物「昆仑」≠ 地点「昆仑」）；认不出就新建
  —— 宁可漏合并（多一条，用户能手动并），不可错合并（两个角色并成一个，正文事实就串了）。

⚠️ **行为变化**：`POST /api/entities` 手动新增同名同类实体，现在会合并进已有那条
而不是新建。与 graph extractor 的 `findNode`（本来就按归一化名精确匹配）一致。
如果作者确实要两个同名角色，得靠 type 区分或手动改名。

### 1.2 顺带修掉的真 bug（读代码时发现，非计划内）

- **四个路由把 async 的 upsert 当同步用** — `entities` POST、`entities/[id]` PATCH、
  `foreshadows` POST、`foreshadows/[id]` PATCH。上一轮把 store 改 async 时漏了 await，
  响应体是个 Promise，写入还可能被丢。tsc 抓不到（赋给 const 完全合法）。
- **`novels` POST 的 `initializeNovelMemory` 未 await** — 响应先返回，记忆初始化
  与客户端随后的请求抢同一批文件；一旦失败就是进程级 unhandled rejection，
  打包成 exe 后会直接崩。已改为 await + catch（初始化失败不挡建项目）。

### 1.3 上一轮遗留（此前一直没提交，本轮一并落盘）

`process.cwd()` 收口到 `runtime/app-paths`（11 处）· 字段↔文件映射收敛到
`novel/field-map` · json-db 止血（损坏不再静默清零，.bak 自愈 + 保留现场）·
并发丢写收口到 `updateCollection` + `proper-lockfile` 跨进程锁 ·
localhost CSRF 抬成全局 middleware（`api/local-origin-guard`）·
交付形态 `output: "standalone"` + `removeConsole` 保留 error/warn · 移除 Supabase。

⚠️ 交付打包时启动器必须设 `WITHYOU_DATA_DIR` 指向用户目录（如 `%APPDATA%\withyou-novel`），
否则双击 exe 时 cwd 不定、数据会漂移。

### 1.4 测试

68 → 123。本轮新增 5 组：

| 文件 | 例数 | 锁住什么 |
|---|---|---|
| `provenance.test.ts` | 13 | 层级模型、canFeed 约束、派生路径识别、旧数据兜底 |
| `consolidation-depth.test.ts` | 8 | 阶段绝不吃阶段；总不变式：选中的输入都严格浅于产出 |
| `alias-registry.test.ts` | 12 | 归一化、三级对账顺序、类型隔离、认不出就返回 null |
| `entity-alias-store.test.ts` | 7 | 别名合并真的落库、改名走更新而非并表 |
| `server-novel-data.test.ts` | 10 | 文件优先/meta 兜底/空模板不算内容/回读是纯读 |
| `project-scaffold.test.ts` | 9 | 每份模板都认得出、补一个字就不算模板 |

---

## 2. 下一步待做

1. **灰度人工验证**。代码已准备 `NEXT_PUBLIC_AGENT_WORKBENCH_ROLLOUT_PERCENT`，
   支持 0、稳定百分比分桶和 100；按用户安排暂不执行灰度验证。
2. **带真实模型配置的集中验收**。需要在功能区 API Key 可用时验证 Writer、
   Planner、Reviewer、Memory 的真实输出，重点检查证据读取轨迹和 Memory 候选
   批量批准/拒绝。当前无密钥的 production 验收会按设计返回
   `AGENT_RUN_FAILED / 未配置功能区 API Key`。
3. **Biome 存量诊断**见 §3.1。必须逐点判断，不能批量自动修复。

已完成并从待办移除：
- chat 不再接收或信任浏览器传入的 `novelContext`，功能区上下文统一由服务端读取。
- `supabase/` 空目录当前已不存在。
- 核心 Writer / Planner / Reviewer / Memory 已迁移到统一 AgentRuntime；Memory
  通过结构化工具暂存 `candidate`，用户批准前不会进入正常记忆召回。
- Agent 工作台 UI 已接入 Planner / Reviewer / Memory，提供运行状态、证据轨迹和
  Memory 候选单条/批量审批；Writer 会话显示真实工具读取阶段。
- 图谱同步已与实体别名注册表对账，会合并别名/正式名重复节点并重定向关系、事件引用。
- Agent 工作台灰度代码已准备，侧边栏和工作区共用同一个会话分桶键。

---

## 3. 已知问题与判断依据

### 3.1 biome 剩余诊断（**有意保留，不是漏做**）

| 规则 | 条数 | 为什么不动 |
|---|---|---|
| `noUnnecessaryConditions` | 70 | **多为误报**。biome 不跨模块解析返回类型，把 `getNovel(): T \| null` 误判成非空，让你删掉必需的可选链。`server-novel-data.ts` 已就地 biome-ignore 并写明理由。 |
| `useNullishCoalescing` | 53 | `\|\|` → `??` 对 `""` / `0` / `false` 语义不同，批量换会引入行为变化，必须逐点看。 |
| `useExhaustiveDependencies` | 22 | React hook 依赖，自动补依赖可能造成渲染死循环。 |
| `noArrayIndexKey` 14 / `noNonNullAssertion` 12 / `noExplicitAny` 4 等 | 30+ | 单点判断，价值低。 |

`public/*.html` 与 `tmp/**` 已移出扫描范围 —— 纯静态原型预览页，内联压缩脚本，
src 无任何引用，此前贡献 61 条噪声。

### 3.2 环境

- **本机 bash 的 fnm cd 钩子会让脚本静默短路**：`~/.bashrc` 有
  `eval "$(fnm env --use-on-cd)"`，非交互 shell 里 `cd` 进含 `.nvmrc` 的目录会失败
  （报 "We can't find the necessary environment variables..."，且 `&&` 短路让后续命令
  根本没跑）。非交互命令一律 `eval "$(fnm env)" && builtin cd ...`。
  另：机器上有两套 fnm 目录，`C:\Users\朝雾\AppData\Roaming\fnm`（在用，v22.23.1）
  和 `D:\fnm`（旧）。
- **test 脚本必须带 `--conditions=react-server`**。json-db.ts 及依赖有
  `import "server-only"`，该包在无 react-server 条件的进程里是抛错模块。
  若 test 脚本被还原，记得连 flag 一起补回。
- **package.json 曾被本地进程还原**（近两轮均未复现）。跑测试前确认 `test`
  脚本还在。若再发生，先查是否开着 `next dev`。
- **云端 sandbox 两个坑**：装不了 typescript；shell 输出会间歇抖动。云端还有误报
  前科（context-compressor、FIELD_FILES），**云端提出的"bug"在本地改之前先复核数据链**。

---

## 4. 判断"重复=缺陷还是设计"的尺子

作者核心诉求是**记忆隔离**：每个功能自己回读文件树确认、不继承他人推断。因此：
**重复地从文件树重新推导 = 设计意图，保留；重复地持久化 / 重复注入同一 prompt = 缺陷，收口。**

本轮新增一把尺子：**看 provenance depth**。
判断某条数据能不能作为事实用，先问它是 depth 0（作者写的 / 单跳可重建）
还是 depth ≥1（AI 归并出来的）。派生物回流成事实，就是污染。

改任何东西前先确认它是否在死代码清单里（本项目大量"写完没接线"的代码，
如 llm-message-assembly、gatewayToolLoop、story-map-*、collaboration+sync 路由）。
