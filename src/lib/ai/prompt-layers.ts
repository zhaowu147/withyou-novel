import { wrapUntrustedData } from "./prompt-boundary";
import type { ToolContext } from "./route-prompts";

/**
 * Layered Prompt Builder — L0~L3 分层注入
 *
 * 拼出完整 system prompt:
 *   L0  hard_rules     — 永远不能违反的事实/安全/输出底线
 *   L0.5 exec_guide    — 执行流程(先读什么/再做什么/输出格式)
 *   L1  persona/route  — 当前工具的角色行为定义
 *   L3  context        — 从数据层动态检索的项目上下文
 */

import { getRoutePrompt, getRouteScope } from "./route-prompts";

/** L0: 通用硬规则(所有工具共享) */
const UNIVERSAL_HARD_RULES = `## 不可违反的底线
1. 文件树、已发生正文和用户本轮明确修改是事实依据；发现冲突时标出，不静默改写。
2. 不凭空补出会改变主线的身份、能力、关系、时间线或世界规则；小的现场细节可以服务场景。
3. 角色只能使用当前视角和当前时间点合理拥有的信息。
4. 遵守当前工具的输出协议、文件权限和用户要求；不要把内部字段、JSON 或执行说明泄露给正文读者。
5. 不为了制造戏剧性强行加反转、金手指、误会或新设定。

字数、钩子密度、对话比例、段落长度、形容词数量和爽点频率都是编辑参考，不是自动废稿条件。`;

/** L0: 写作类工具专属硬规则 */
const WRITING_HARD_RULES = `## 商业网文编辑目标（软约束）
先问：这一段让读者想知道什么、担心什么、期待什么？再决定写动作、对白、心理或环境。
- 尽快让人物处境、目标或异常变得具体，但不强制前三句、前五百字或每三百字必须发生固定事件。
- 句子和段落长短服从场景；紧张时利落，信息和情绪需要展开时允许完整表达。
- 对话要有目的、立场或关系变化；不要让角色替作者解释双方都知道的设定。
- 网感来自人物选择、反应、口语和局势，不等于堆热梗、短句或网络词。
- 章末优先留下具体行动、信息、选择或新风险；如果本章需要收束，允许自然收束，不强行制造悬念。

## 生成后的编辑自问
- 主角或关键人物有没有做出选择？
- 局势、关系、信息或代价有没有真实变化？
- 这段是角色正在经历，还是作者在讲解？
- 当代网文读者看完这一段，会不会愿意继续翻下一段？为什么？`;

/** L0.5: 工具执行指南 */
const EXEC_GUIDES: Record<string, string> = {
  opening: `## 执行流程
Step 0 先确定开篇卖点、人物处境和第一章结束时要留下的阅读期待；篇幅和场景数服从故事
Step 1 读上下文:大纲 → 人设 → 世界观 → 前 3 章正文
Step 2 尽快让读者看见具体处境、目标或异常，不用为了达标硬塞冲突
Step 3 让每个场景至少完成一种有效工作：推进事件、改变关系、释放信息或制造期待
Step 4 章末优先落在行动、信息、选择或风险上，钩子必须来自正文因果
输出 JSON:{"章节名称":"","正文":""}`,

  outline: `## 执行流程
Step 1 确认三要素:题材 / 目标平台 / 总字数
Step 2 给出 3 个开篇方向让用户选
Step 3 按三幕剧或"起承转合"给出整体节奏
Step 4 标注黄金三章具体设计(每章 3-5 个 plot point)
Step 5 标出核心爽点分布(第几章有转折/高潮/金手指升级)
输出:Markdown 大纲 + 薄弱点提示 3 条`,

  "detailed-outline": `## 执行流程
Step 1 读取 设定/大纲.md
Step 2 确定总卷数(每卷 30-50 章)
Step 3 每卷拆 3-5 个 block(每 block 10-15 章)
Step 4 每 block 给章级细纲:章号 + 核心事件 + 钩子 + 伏笔操作
产出写入 设定/大纲.md 的"细纲"章节`,

  character: `## 执行流程
Step 1 先判断角色在当前故事中的剧情功能、主动目标和主要阻碍
Step 2 根据角色重要程度灵活展开：身份、资源、代价、关系冲突、关键选择、语言和行动辨识度
Step 3 外貌只写能被剧情调用的特征；口头禅、创伤、成长弧和秘密都是可选项，不要为了填卡硬造
产出写入 设定/人物.md`,

  worldview: `## 执行流程
按故事需要拆解力量体系、地理、历史、势力和日常；优先写会直接制造冲突或影响人物选择的部分，不为了凑数量扩写设定。
产出写入 设定/核心设定.md`,

  foreshadow: `## 执行流程
状态机:planted → activated → resolved (或 abandoned)
操作 A 扫描:用户提供剧情 → 识别新伏笔 + 可回收伏笔 → 写入追踪/伏笔.md
操作 B 提醒:到目标章前 3 章提示作者"伏笔 X 该回收了"
操作 C 回收:把 planted/activated → resolved,标注 actual_resolve_chapter`,

  refine: `## 执行流程
Step 1 读原始章节
Step 2 以商业网文编辑顺序检查：事实与人物动机 → 局势变化 → 追读动力 → 表达拖沓和 AI 腔
Step 3 针对性重写问题段落(不改动剧情和事实)
Step 4 保留原文有效的节奏和个性，不为短句、钩子或网感机械改写
输出 JSON:{"章节名称":"","正文":"(润色后)"}`,

  entities: `## 执行流程
实体卡 JSON:{name,type,importance,active_state,summary,current_state,key_attributes}
操作:添加/更新/删除/列表
关系:A → B (敌对/盟友/暧昧/师徒)
禁止:无正文依据的字段不编造,标注"待作者补充"`,

  "book-name": `## 执行流程
Step 1 确认题材和目标平台
Step 2 给出 5-8 个候选 + 评分(1-10) + 一句话理由
Step 3 中文优先,2-8 字最佳
Step 4 避免:空泛文艺/与同质化重名/过长难记忆`,

  brainstorm: `## 执行流程
用"What if..."句式发散 5-8 个脑洞
每个脑洞 3 句内讲清核心卖点
标注:新颖度 × 商业潜力 × 可持续性(各 1-5 分)
主动给 2-3 个方向的分支延伸`,
};

/** L0.5: 上下文检索指南(Context Retriever) */
function buildContextGuide(toolContext: ToolContext): string {
  if (!toolContext) return "";
  const guides: Record<string, string> = {
    writing: "上下文:前 5 章摘要 + 活跃实体(核心+重要) + 未回收伏笔 + 大纲 300 字",
    outline: "上下文:全书 metadata + 所有实体卡(含已 resolved) + 完整大纲",
    entity_enrich: "上下文:该实体出场的所有章节 + 关联实体卡",
    foreshadow: "上下文:所有已 planted/activated 的伏笔列表",
  };
  return `## 上下文检索范围\n${guides[toolContext] || "自动按任务类型裁剪"}`;
}

/**
 * 拼装完整 system prompt
 */
export function buildLayeredSystemPrompt(
  toolContext: ToolContext,
  novelData: { novelName?: string; outline?: string; characters?: string; worldview?: string },
  l3Context?: string, // 从 memory-retriever 注入的 L3
): string {
  const parts: string[] = [];

  // L0: 通用硬规则
  parts.push(UNIVERSAL_HARD_RULES);

  // L0: 写作类附加硬规则
  if (isWritingTool(toolContext)) {
    parts.push(WRITING_HARD_RULES);
  }

  // L0.5: 执行指南
  if (toolContext && EXEC_GUIDES[toolContext]) {
    parts.push(EXEC_GUIDES[toolContext]);
  }

  // L1: 路由行为定义
  parts.push(getRoutePrompt(toolContext));

  // L3: 当前小说上下文(有数据就读)
  if (novelData?.novelName && novelData.novelName !== "我的作品") {
    parts.push(`## 当前作品: ${novelData.novelName}`);
    if (novelData.outline) parts.push(`## 大纲摘要\n${wrapUntrustedData("outline", novelData.outline.slice(0, 500))}`);
    if (novelData.characters)
      parts.push(`## 人设摘要\n${wrapUntrustedData("characters", novelData.characters.slice(0, 300))}`);
    if (novelData.worldview)
      parts.push(`## 世界观摘要\n${wrapUntrustedData("worldview", novelData.worldview.slice(0, 300))}`);
  }

  // L3+: memory-retriever 注入的详细上下文
  if (l3Context) {
    parts.push(wrapUntrustedData("retrieved_context", l3Context));
  }

  // 文件访问权限
  const scope = getRouteScope(toolContext);
  if (scope.readWrite.length > 0) {
    parts.push(
      "## 文件访问权限\n" +
        "可读写: " +
        scope.readWrite.join(", ") +
        "\n" +
        (scope.readOnly.length > 0 ? `只读: ${scope.readOnly.join(", ")}` : ""),
    );
  }

  return parts.join("\n\n");
}

function isWritingTool(tool: ToolContext): boolean {
  return ["opening", "detailed-outline", "refine"].includes(tool ?? "");
}

export default { buildLayeredSystemPrompt, buildContextGuide };
