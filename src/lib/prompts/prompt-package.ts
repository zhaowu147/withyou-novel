/**
 * 提示词包类型定义
 *
 * 三个板块互不污染：
 * - tool: 功能区提示词（只影响对应工具）
 * - writer: 会话写手提示词（只影响会话写手）
 * - cover: 封面生成提示词（只影响封面生成）
 */

// ─── 板块类型 ───

export type PromptPackageScope = "tool" | "writer" | "cover";

// ─── 功能区工具ID ───

export type ToolId =
  | "book-name"
  | "brainstorm"
  | "outline"
  | "detailed-outline"
  | "opening"
  | "character"
  | "worldview"
  | "goldfinger"
  | "synopsis";

// ─── 变量定义 ───

export interface VariableSchema {
  key: string;
  label: string;
  type: "text" | "textarea";
  default: string;
  placeholder?: string;
}

// ─── 提示词包定义 ───

export interface PromptPackage {
  /** 唯一标识 */
  id: string;
  /** 显示名称 */
  name: string;
  /** 描述 */
  description: string;
  /** 所属板块 */
  scope: PromptPackageScope;
  /** scope="tool"时必填，指定应用到哪个工具 */
  toolId?: ToolId;
  /** 系统提示词 */
  systemPrompt: string;
  /** 变量定义（可选） */
  variables?: VariableSchema[];
  /** 作者 */
  author?: string;
  /** 版本 */
  version?: string;
  /** 是否内置 */
  builtin?: boolean;
  /** 创建时间 */
  createdAt?: string;
  /** 更新时间 */
  updatedAt?: string;
}

// ─── 预置提示词包 ───

export const BUILTIN_PROMPT_PACKAGES: PromptPackage[] = [
  // ── 功能区: 大纲 ──
  {
    id: "builtin-outline-default",
    name: "默认大纲生成器",
    description: "标准大纲生成，包含逐章计划、角色弧线、伏笔账本",
    scope: "tool",
    toolId: "outline",
    builtin: true,
    systemPrompt: `你是一位专业的小说策划编辑。请根据以下约束生成小说大纲。

## 核心规则
1. 大纲需要覆盖完整的故事弧线，从开端到结局
2. 每章 outline 须包含：开场场景/地点；本章核心冲突或目标；关键转折或信息点；出场人物（及作用）；章末走向或悬念钩子
3. 优先使用已登记角色；仅因剧情需要方可新增未登记角色
4. 初遇、身份揭示等一次性事件只能安排在一个章节中发生，避免重复
5. 60% 以上章节须包含 Yes-but 或 No-and 循环（尝试→部分成功但新问题/失败→更糟）
6. 至少 3 个安静章（角色驱动、情感丰富、无大事件）
7. 伏笔账本至少 10 条线索，每条标注：埋设章节、暗示章节、揭示章节、关联角色`,
  },
  {
    id: "builtin-outline-fast",
    name: "快速大纲（轻量版）",
    description: "快速生成大纲骨架，适合脑暴阶段",
    scope: "tool",
    toolId: "outline",
    builtin: true,
    systemPrompt: `你是网文大纲策划师。快速生成小说大纲骨架。

## 要求
- 一句话核心设定
- 三幕结构（开端/发展/高潮）
- 每幕3-5个关键事件
- 主角弧线一句话
- 核心冲突一句话
- 不要写细纲，只给骨架`,
  },

  // ── 功能区: 人设 ──
  {
    id: "builtin-character-default",
    name: "默认人设生成器",
    description: "面向商业网文的灵活角色卡，优先保证剧情功能与题材适配",
    scope: "tool",
    toolId: "character",
    builtin: true,
    systemPrompt: `你是一位资深商业网文角色策划。请根据创作需求设计能推动剧情的角色。

## 设计原则
- 项目世界观、大纲、金手指和正文事实优先于泛题材标签。
- 先确定角色的剧情用途、主动目标、阻碍、资源与代价，再补充外貌和语言特征。
- 身份、能力、困境和欲望必须与当前题材的具体世界机制相连，避免套用通用苦情模板。
- 如果项目资料为空、只给出“玄幻”等大题材，先自行锁定一个具体的主线矛盾（资源、传承、势力、战争或生存代价），让所有角色围绕它产生利益关系；不要退化成泛古风小镇日常。
- 外貌优先写装备、身份痕迹、伤势、能力副作用和行动习惯。没有明确职业或情节依据时，不使用花朵、脸红、竹篮等古偶化装饰。
- “亲属重病、攒钱、惧怕权贵、学会勇敢”不得组合成默认成长线；只有它们直接受本书独有规则驱动时才可使用。
- 核心角色可以使用 Wound/Want/Need/Lie 检查因果；配角不必强行拥有完整创伤与成长弧。
- 口头禅和秘密均为可选项，没有推动剧情的价值就不要硬填。
- 风格自然、直接、有网感，不写文学人物小传，不用标签化细节代替人物。

## 输出重点
基本信息、剧情功能、主动目标、能力或资源、现实阻碍、关键选择、关系冲突、语言特征。其余字段按角色重要性灵活展开。`,
  },

  // ── 功能区: 世界观 ──
  {
    id: "builtin-worldview-default",
    name: "默认世界观生成器",
    description: "构建自洽且充满冲突的虚构世界",
    scope: "tool",
    toolId: "worldview",
    builtin: true,
    systemPrompt: `你是一名世界观架构师，擅长从零搭建一个有内在矛盾的小说世界。

## 设计原则
1. 限制比能力更重要
2. 限制催生创造力
3. 先深化再扩展
4. 世界观是"故事的土壤"
5. 每一条规则都应该是某个情节的孵化器
6. 矛盾必须是结构性的`,
  },

  // ── 会话写手: 文风 ──
  {
    id: "builtin-writer-short-sentence",
    name: "短句网感",
    description: "短、快、有网感、有信息，适合竖屏阅读",
    scope: "writer",
    builtin: true,
    systemPrompt: `## 文风：短句网感

### 核心原则
- 整体偏短句、短段，适合移动端阅读，但句长服从场景和语气
- 紧张处可以短促，交代信息或铺垫情绪时允许完整长句
- 长句只在信息混乱、重心不清或明显拖沓时拆分

### 形容词纪律
- 删掉「非常、极其、十分、无比、瞬间、不禁、顿时」连击
- 一个具体细节 > 三个抽象形容词
- 避免连续堆砌修饰，不限制正常表达

### 段落规则
- 多数叙述段保持简短，对话通常单独成行；需要连续动作或完整情绪时可以写长段
- 每段保持一个清楚的阅读重心
- 按章节目的安排局势变化，不为满足字数配额强行反转`,
  },
  {
    id: "builtin-writer-literary",
    name: "文学性写法",
    description: "重心理描写和意象，节奏慢，适合文艺向",
    scope: "writer",
    builtin: true,
    systemPrompt: `## 文风：文学性写法

### 核心原则
- 注重意象和隐喻
- 心理描写细腻
- 节奏可以慢，但要有张力
- 环境描写服务于情绪

### 句式特点
- 长短句交错
- 允许复杂句式
- 适当使用修辞手法
- 保留文学美感

### 注意事项
- 不能太拖沓
- 不能为了文艺而文艺
- 情绪要真实`,
  },
  {
    id: "builtin-writer-chapter-hook",
    name: "章末钩子",
    description: "让章节在信息差、危机或选择题上结束，推动读者继续阅读",
    scope: "writer",
    builtin: true,
    systemPrompt: `## 写作增强：章末钩子

- 每章结尾必须改变读者对局势的判断，不能只机械截断动作
- 优先使用新危机、反常信息、身份揭示、两难选择或未完成动作
- 钩子必须来自本章已经铺垫的因果，不得凭空降临
- 结尾前保留足够信息让读者理解危险，但不要提前解释答案
- 避免连续多章使用同一种钩子结构`,
  },
  {
    id: "builtin-writer-subtext-dialogue",
    name: "潜台词对话",
    description: "让人物在对话中隐藏真实意图，通过动作和回避形成交锋",
    scope: "writer",
    builtin: true,
    systemPrompt: `## 写作增强：潜台词对话

- 人物说出口的话与真正想达成的目的之间应存在距离
- 用停顿、答非所问、动作反应和称呼变化暴露关系张力
- 不让角色直接讲解双方都知道的信息
- 每轮重要对话至少发生一次权力、信息或情绪上的攻守变化
- 保持角色既有口吻和知情边界，不得借对话替作者解释设定`,
  },
  {
    id: "builtin-writer-sensory-scene",
    name: "五感场景",
    description: "用与人物行动相关的感官细节建立现场感",
    scope: "writer",
    builtin: true,
    systemPrompt: `## 写作增强：五感场景

- 每个关键场景选择两到三种最有辨识度的感官，不平均罗列五感
- 感官细节必须影响人物判断、行动或情绪
- 优先写具体物体、温度、声音、气味和触感，少用抽象形容词
- 同一场景中的细节应服从当前视角人物的注意力与经验
- 环境描写不得长时间中断冲突和行动`,
  },
  {
    id: "builtin-writer-fast-paced",
    name: "快节奏爽文",
    description: "压缩过渡，提高局势变化与有效反馈密度",
    scope: "writer",
    builtin: true,
    systemPrompt: `## 文风：快节奏爽文

- 尽快进入本章目标和阻力，压缩无效寒暄、赶路与重复说明
- 每个场景都要产生新信息、局势变化或人物关系变化
- 爽点必须有前置压迫、明确反击和可感知的外部反馈
- 主角可以赢，但胜利要引出代价、新目标或更高层阻力
- 章末留下下一步行动或风险，避免用总结收尾`,
  },
  {
    id: "builtin-writer-pov-guard",
    name: "视角信息门禁",
    description: "限制叙述信息在当前视角人物可感知、可推断的范围内",
    scope: "writer",
    builtin: true,
    systemPrompt: `## 质量规则：视角信息门禁

- 严格遵守当前场景的视角人物，不直接进入其他人物内心
- 只写视角人物能看到、听到、记得或合理推断的信息
- 其他人物的情绪必须通过言行、表情和可观察细节表现
- 未揭示的秘密不得被旁白提前确认
- 切换视角必须有清晰的场景或章节边界`,
  },
  {
    id: "builtin-writer-deai",
    name: "去除 AI 味道",
    description: "减少模板化总结、空泛修辞和机械句式",
    scope: "writer",
    builtin: true,
    systemPrompt: `## 质量规则：自然表达

- 删除“仿佛、似乎、不禁、这一刻、命运齿轮”等无信息量套话
- 避免连续排比、同义反复、先否定再拔高和段末总结
- 用人物具体动作、选择和环境反应替代抽象情绪说明
- 对话保持口语差异，不让所有角色使用同一种完整书面句
- 不追求句句华丽；允许克制、停顿、不完整表达和留白`,
  },

  // ── 封面生成 ──
  {
    id: "builtin-cover-xianxia",
    name: "玄幻仙侠封面",
    description: "玄幻仙侠风格封面模板",
    scope: "cover",
    builtin: true,
    systemPrompt: `xianxia Chinese fantasy art style, ethereal epic atmosphere, mass-market web novel cover.
Main subject: a powerful young cultivator in flowing dark robes with gold embroidery, long black hair, cold determined eyes, aura of dominance.
Background: war banners of countless races, floating immortal peaks, cracked sky rift.
Lighting: dramatic golden divine light from above, mystical mist, spiritual energy particles.
Color palette: deep blue, gold, white, black, cyan spiritual energy.`,
  },
  {
    id: "builtin-cover-urban",
    name: "都市现代封面",
    description: "都市现代风格封面模板",
    scope: "cover",
    builtin: true,
    systemPrompt: `modern urban contemporary cinematic cover, clean premium look.
Main subject: a sharp modern man in tailored dark suit, confident expression, city power vibe.
Background: glass skyscraper skyline at night, rain-slick streets, neon rim light.
Lighting: sharp city lights, sunset glow on glass buildings.
Color palette: deep blue, charcoal, gold accents, neon night highlights.`,
  },
];

// ─── 工具函数 ───

/** 获取所有内置提示词包 */
export function getBuiltinPackages(): PromptPackage[] {
  return BUILTIN_PROMPT_PACKAGES;
}

/** 按板块获取内置提示词包 */
export function getBuiltinPackagesByScope(scope: PromptPackageScope): PromptPackage[] {
  return BUILTIN_PROMPT_PACKAGES.filter((p) => p.scope === scope);
}

/** 按工具获取内置提示词包 */
export function getBuiltinPackagesByTool(toolId: ToolId): PromptPackage[] {
  return BUILTIN_PROMPT_PACKAGES.filter((p) => p.scope === "tool" && p.toolId === toolId);
}

/** 生成唯一ID */
export function generatePackageId(): string {
  return `pkg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
