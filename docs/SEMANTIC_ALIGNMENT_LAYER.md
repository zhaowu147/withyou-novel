# WithYou 语义对齐层

## 定位

语义对齐层（SAL）位于用户输入与正式 Agent 执行之间：

```text
用户输入
  → Semantic Parser
  → Alignment Gate
  → 用户查看、修改或确认
  → 锁定契约版本
  → Execution Agent
  → Semantic Validator
```

它展示的是会影响结果的任务理解、关键语义、约束、假设、创作方向和歧义，不展示模型思考链。

## 磁盘结构

每本小说独立存放：

```text
.withyou/semantic-contracts/
├── active/
├── versions/{contractId}/
├── locked/{contractId}/
├── completed/{contractId}/
├── superseded/{contractId}/
└── locks/
```

- 每次编辑生成新版本，旧版本不覆盖。
- 确认后写入不可变锁定快照和内容哈希。
- 每个来源文件记录内容哈希；执行前发现变化即使契约失效。
- 验证结果独立保存。
- 只有用户主动选择时，硬约束才写入 `.withyou/project-bible/semantic-rules.json`。

## 风险与确认

- 明确、局部、可逆且只影响一个文本单元的白名单编辑可以自动确认。
- 自动确认由设置 `semanticAlignment.autoConfirmLowRisk` 控制。
- 世界观、核心动机、角色关系、主线、人物增删、死亡、背叛、失忆、身份反转、跨章伏笔等至少为高风险，必须确认。
- 项目事实冲突、互斥硬约束、解析失败、未确认高风险假设会进入阻断状态。
- “冷漠一点，但不要突然”等内部动机不唯一的表达会显式列出解释，不能静默选择。

## 执行约束

正式生成 API、Writer、工具精修和 Agent 工作台都要求传入已确认的 `contractId` 与 `contractVersion`。执行入口会检查：

1. 工作区与小说绑定；
2. 锁定快照存在；
3. 内容哈希一致；
4. 来源文件没有过期；
5. 当前版本尚未执行。

同一版本通过跨进程锁只能领取一次，防止双击或并发请求重复生成。

执行提示中包含契约的任务边界、关键解释和约束；系统事件与 API 结果携带契约 ID、版本和验证报告，契约标识不会污染小说正文。

## 用户能力

语义契约卡片支持：

- 修改任务理解和目标；
- 编辑或删除模型解释；
- 新增、删除、升级或降级约束；
- 选择歧义解释；
- 确认模型假设；
- 查看引用文件；
- 查看版本记录；
- 重新解析、拒绝或确认；
- 明确选择保存为项目长期规则。

## 验证规则

Semantic Validator 逐项检查目标、排除范围、`must`、`must_not`、`preserve`、关键解释及范围漂移。无法核实的项目必须进入 `unverifiedConstraints`，不会默认通过。验证异常或执行异常都会把契约标记为未通过并保存原因。

## 关键实现

- 类型与 Gate：`src/lib/semantic-alignment/types.ts`、`core.ts`
- Parser/Execution/Validator 提示：`prompts.ts`
- 版本、哈希、锁与来源：`store.ts`
- 生命周期服务：`service.ts`
- API：`src/app/api/semantic-contracts/`
- UI：`src/app/(main)/_components/semantic-contract-card.tsx`
