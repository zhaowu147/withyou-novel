/**
 * Novel Writing HARD RULES
 */
export interface HardRuleLayer {
  gate: string;
  required?: string[];
  schema?: string;
  rules?: Record<string, unknown>;
  levels?: string[];
}

export const HARD_RULES: Record<string, HardRuleLayer> = {
  inspiration: { gate: "output should make the genre, hook and one-line premise understandable; wording and length are flexible" },
  protagonist: {
    gate: "output should establish the character's role, active desire, obstacle, resources, cost and a usable contradiction; add hidden history, growth or power details only when the story needs them",
  },
  sidecast: {
    gate: "important supporting characters should have a story function, an independent desire and a relationship tension; count and fields are determined by the requested cast size and story needs",
  },
  world: {
    gate: "make the world's conflict source, core rules and consequences clear; expand geography, society, history and power progression only to the level needed to generate the requested story",
  },
  outline: {
    gate: "preserve the requested output format and provide a coherent cause-and-effect story spine; do not fill unused fields merely to satisfy a template",
  },
  volumes: {
    gate: "each volume should have a distinct goal, escalation, turning point and end expectation; volume count, beat count and desire labels should follow the user's story rather than a fixed quota",
  },
  chapterOutlines: {
    gate: "each chapter plan should state the starting situation, chapter task, meaningful change, key beats and ending pull; the number of beats and title length are flexible",
  },
  writing: {
    gate: "must preserve established facts and produce readable commercial web fiction; do not mechanically enforce word count, dialogue ratio or hook frequency when the scene requires another rhythm",
  },
  polish: {
    gate: "preserve story facts and user intent, then prioritize fatal continuity problems, reader drag and high-value upgrades; use tiers as an editing order, not a mandatory output shape",
  },
};

export const STAGE_GATES: Record<string, string> = {
  inspiration: "[编辑检查] 读者能否一眼明白题材、卖点和开局？缺失时补足，不要求固定字数或字段名称。",
  protagonist: "[编辑检查] 角色是否有主动欲望、现实阻碍和能推动剧情的选择？不要求机械补齐创伤、金手指等级或口头禅。",
  sidecast: "[编辑检查] 配角是否有自己的利益和行动，而不是只等主角调用？数量服从本次故事需要。",
  world: "[编辑检查] 设定是否能制造具体冲突，并且规则有代价？只补本次剧情需要的世界信息。",
  outline: "[编辑检查] 故事因果是否成立、读者期待是否持续？按用户要求输出格式，但不为了填满模板编造内容。",
  volumes: "[编辑检查] 每卷是否有独立目标、升级和下一卷期待？不强制固定卷数、欲望标签或情节点数量。",
  chapterOutlines: "[编辑检查] 每章是否知道从哪里开始、要改变什么、结束后读者为什么继续看？不强制十个剧情点。",
  writing: "[编辑检查] 先检查事实和可读性，再检查商业追读动力；节奏、字数、钩子密度服从场景，不机械重写。",
};
