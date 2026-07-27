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
  inspiration: { gate: "output MUST contain: genre + hook + oneLine (15-30 chars + emotional entry)" },
  protagonist: {
    gate: "output MUST contain: name + surfacePersona + realPersona(secretIdentity/trauma/motive) + goldenFinger(name + 5-level upgrade path + at least 3 limitRules + consequences + mostDangerousUse + relationalImpact + mostSatisfyingMoment) + growthArc(from X to Y) + fatalWeakness",
  },
  sidecast: {
    gate: "at least 3 major NPCs, each with: name, role, relationshipTension, ownGoal(not tool), hiddenTwist",
  },
  world: {
    gate: "output MUST contain 5 items: coreConflictSource + geography(3+ key locations) + socialStructure(power/class/mobility) + powerSystem(upgrade path + scarcity + costPerLevel + breakpoints) + historicalSecrets(3 past events)",
  },
  outline: {
    gate: "STRICT JSON parseable. Must include: novelInfo, narrativeSkeleton, fullStory(causal-sentence), worldBackground, powerSystem, mainCharacter, romanceType, volumes",
  },
  volumes: {
    gate: "4-6 volumes, each MUST have: name, chapterRange, desireLayer(生存欲/贪欲/色欲/个欲/奢欲), volumeStory(causal-sentence), keyBeats(3+), volumeEndHook",
  },
  chapterOutlines: {
    gate: "Per chapter MUST have: number, title(<20 chars), beats(10 points: openHook + middleProgression + endCliffhanger)",
  },
  writing: {
    gate: "MUST satisfy ALL: 2500-3500 words + dialogue+action ratio >= 0.7 + 1 hook per 300 words + chapterEnd NOT reflection + NO lore dumps + NO author-manipulation",
  },
  polish: {
    gate: "3-tier feedback: L1(logic/motive/timelogon breaks), L2(pacing drag/dead dialogue), L3(upgrades/foreshadow/character moments). Fix L1 first.",
  },
};

export const STAGE_GATES: Record<string, string> = {
  inspiration: "[HARD GATE: 灵感未通过] output 不含 genre+hook+oneLine 任一项,必须重写.",
  protagonist: "[HARD GATE: 人设未通过] 缺少金手指等级+限制规则+升级路径,必须重写.",
  sidecast: "[HARD GATE: 配角未通过] 少于 3 个配角或出现工具人,必须重写.",
  world: "[HARD GATE: 世界观未通过] 5 项中缺失任一项,必须重写.",
  outline: "[HARD GATE: 全书大纲未通过] JSON parse 失败或关键字段为空,必须重写.",
  volumes: "[HARD GATE: 分卷未通过] 任意一卷缺少卷名/章节/欲望层/因果句/卷末钩子,重写该卷.",
  chapterOutlines: "[HARD GATE: 细纲未通过] 任意一章少于 10 个剧情点,重写该章.",
  writing: "[HARD GATE: 正文未通过] 字数偏离 2500-3500 或 300 字区间无节奏变化,重写.",
};
