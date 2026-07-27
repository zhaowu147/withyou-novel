import { wrapUntrustedData } from "./prompt-boundary";
import type { ToolContext } from "./route-prompts";

/**
 * Layered Prompt Builder — L0~L3 分层注入
 *
 * 拼出完整 system prompt:
 *   L0  hard_rules     — 永远不能违反的底线(字数/钩子/禁用词)
 *   L0.5 exec_guide    — 执行流程(先读什么/再做什么/输出格式)
 *   L1  persona/route  — 当前工具的角色行为定义
 *   L3  context        — 从数据层动态检索的项目上下文
 */

import { getRoutePrompt, getRouteScope } from "./route-prompts";

/** L0: 通用硬规则(所有工具共享) */
const UNIVERSAL_HARD_RULES = `## 硬规则(违反即废稿)
1. 章节正文每章 2000-4000 汉字,低于 1500 字判定为废稿
2. 每 300 字至少一个钩子(悬念/反转/打脸/收获)
3. 对话+行动 ≥ 70%,心理描写 ≤ 20%
4. 禁用形容词堆砌(非常/极其/十分/无比/瞬间/不禁)
5. 章末必须有追读悬念(不能是大团圆收尾)
6. 不凭空添加未铺垫的能力/物品/关系
7. 金手指每章最多使用一次(系统/外挂/重生的信息优势)
8. 角色行为必须符合已建立的人设,不 OOC`;

/** L0: 写作类工具专属硬规则 */
const WRITING_HARD_RULES = `## 写作硬规则
- 开篇 3 句内必须出现冲突或悬念,禁止铺垫性环境描写
- 段落 ≤ 3 行,对话单独成行
- 心理活动用"他想" / 引号直给,不用抒情排比
- 环境描写 ≤ 20 字,紧跟动作之后(不单独空镜)
- 口语化 > 书面化,短句 > 长句`;

/** L0.5: 工具执行指南 */
const EXEC_GUIDES: Record<string, string> = {
  opening: `## 执行流程
Step 0 篇幅预算:2500-3500 字,拆 4-6 场景,每场景 400-600 字
Step 1 读上下文:大纲 → 人设 → 世界观 → 前 3 章正文
Step 2 开篇 500 字内必须有核心冲突
Step 3 每 300 字一个 plot point
Step 4 章末留悬念钩子(反转/金手指初现/新危险)
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
Step 1 确认角色定位(主角/配角/反派? 戏份比重?)
Step 2 按模板输出角色卡:姓名/年龄/核心特质/动机/弱点/成长弧光/关键关系
Step 3 标注口头禅和标志性动作(各 1-2 个)
产出写入 设定/人物.md`,

  worldview: `## 执行流程
按五维拆解:
1. 力量体系(等级 / 升级条件 / 限制)
2. 地理(至少 3 个重要区域 + 核心城市)
3. 历史(近 100 年影响当下的 3-5 个事件)
4. 势力(≥ 3 个派系:目的 + 核心人物 + 对立关系)
5. 日常(普通人的一天:货币/食物/常见危险)
产出写入 设定/核心设定.md`,

  foreshadow: `## 执行流程
状态机:planted → activated → resolved (或 abandoned)
操作 A 扫描:用户提供剧情 → 识别新伏笔 + 可回收伏笔 → 写入追踪/伏笔.md
操作 B 提醒:到目标章前 3 章提示作者"伏笔 X 该回收了"
操作 C 回收:把 planted/activated → resolved,标注 actual_resolve_chapter`,

  refine: `## 执行流程
Step 1 读原始章节
Step 2 检查:开篇钩子/段落长度/对话占比/形容词密度/章末悬念
Step 3 针对性重写问题段落(不改动剧情和事实)
Step 4 自检:随机抽 5 句确认一眼能读懂
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
