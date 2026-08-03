# AI 小说提示词整合说明

日期：2026-07-30
来源：`C:\Users\朝雾\Desktop\ai_novel_prompts.md`
整合原则：以当前磁盘代码、文件树事实源和既有 Agent 职责为边界，不照搬另一套产品协议。

## 当前提示词架构

WithYou 的提示词并不是一个大字符串，而是分布在三层：

1. `src/lib/tools/prompt-templates.ts`：创作工具的内置提示和表单协议。
2. `src/lib/prompts/prompt-package.ts`、`prompt-compiler.ts`、`prompt-store.ts`：提示词包、激活覆盖和运行时编译。
3. `src/chat/prompts/agents/`：Writer、Refine 等 Tool-loop Agent 的硬规则与执行指南。

本次保持这三个边界，不把外部文件直接复制成一个不可维护的总提示词。

## 已整合内容

### 世界观

- 增加时间、地点、社会状态、感官氛围和规则代价的组合要求。
- 要求世界规则给出违反后的可观察后果，避免只列名词。
- 根据题材和故事规模控制设定密度，避免小故事被无关宏大设定淹没。

落点：

- `src/lib/tools/prompt-templates.ts`
- `src/lib/prompts/prompt-package.ts`

### 角色、组织与关系

- 角色先服从题材、阶层、职业和世界规则，再生成姓名与标签。
- 关系、组织、职业体系要求来源明确；资料没有的信息不得猜成既定事实。
- 角色动机与外在行为分开，避免用标签替代行动逻辑。

落点：

- `src/lib/tools/prompt-templates.ts`
- `src/lib/prompts/prompt-package.ts`

### 大纲与细纲

- 续写必须先核对相邻章节已经发生的事件。
- 细纲明确区分“本章新增推进”和“禁止复写”。
- 未到达的终局揭示、救援结果和核心反转不得提前兑现。
- 大纲是边界和因果地图，不以固定模板强行制造每章同构节拍。

落点：

- `src/lib/tools/prompt-templates.ts`
- `src/lib/prompts/prompt-package.ts`
- `src/chat/prompts/agents/write/exec_guide.md`

### 正文生成与续写

- Writer 先读取聚合上下文包，再按缺口定向取证。
- 新增相邻章节重复检查、角色生死/位置/伤势/持有物状态核对。
- 禁止复写已经完成的动作、重复终局揭示和越过细纲未来边界。
- 正文不得泄露章节自检、字数统计、提示词或工程元话语。

落点：

- `src/chat/prompts/agents/write/hard_rules.md`
- `src/chat/prompts/agents/write/exec_guide.md`
- `src/app/(main)/_components/chat-panel.tsx`

### 精修与“去 AI 味”

- 采用“保留作者意图、最少必要修改”的原则。
- 优先处理解释性心理描写、套路句式、过度升华和整齐划一的节奏。
- 不用一组机械禁用词或固定比例替代实际语境判断。

落点：

- `src/chat/prompts/agents/refine/hard_rules.md`
- `src/lib/prompts/prompt-package.ts`

### 角色结构化输出

原角色分支曾绕过提示词包与结构化校验。本次取消该旁路，使角色生成与其他工具一致地经过：

1. 模板与激活提示词编译；
2. 项目事实上下文；
3. 语义契约；
4. 结构化输出校验；
5. 仅修复 JSON 协议的二次修复。

## 有意没有照搬的内容

- 固定字数、固定对话比例、固定钩子频率等机械指标；
- “每 300 字一个钩子”之类会导致重复节拍的硬规则；
- 与当前产品无关的扫榜、外部平台抓取和 MCP 操作流程；
- 要求展示思考过程或把模型推断写成项目事实的部分；
- 与 WithYou 现有文件协议、工作区隔离或 Agent 权限冲突的输出格式。

这些内容可以作为编辑参考，但不适合作为生成阶段的不可违反门禁。

## 一轮式表单填写

提示词编译器新增完整表单填写协议。服务端一次读取当前项目资料，把表单 schema、已有值和项目上下文一次性提供给模型，并要求一次返回所有可填字段的 JSON。解析器只接受 schema 内字段、不覆盖已有值，并验证选择项是否合法。

这替代了旧的“逐字段请求、逐次读取上下文”流程。
