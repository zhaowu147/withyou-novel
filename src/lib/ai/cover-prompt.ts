/**
 * 封面生图：短中文需求 → 专业英文 prompt + size
 * 用户不必会写提示词；这里做题材推断 / 比例解析 / 构图模板。
 */

export type CoverRatio = "9:16" | "2:3" | "3:4" | "1:1" | "16:9" | "3:2";

export interface CoverPromptResult {
  /** 发给图像模型的完整英文 prompt */
  prompt: string;
  /** OpenAI 兼容 size，如 1024x1792 */
  size: string;
  ratio: CoverRatio;
  /** 清洗后的用户题材/场景描述（去掉比例 token） */
  sceneHint: string;
  genre: string;
}

/** 网文封面常用像素（尽量对齐 DALL-E / 中转常见枚举） */
const RATIO_SIZE: Record<CoverRatio, string> = {
  "9:16": "1024x1792",
  "2:3": "1024x1536",
  "3:4": "768x1024",
  "1:1": "1024x1024",
  "16:9": "1792x1024",
  "3:2": "1536x1024",
};

const DEFAULT_RATIO: CoverRatio = "9:16";

function normalizeRatioToken(raw: string): CoverRatio | null {
  const t = raw.replace(/\s+/g, "").toLowerCase();
  if (t === "竖版" || t.includes("9:16") || t.includes("9：16") || t.includes("9/16") || t.includes("9x16"))
    return "9:16";
  if (t === "横版" || t.includes("16:9") || t.includes("16：9") || t.includes("16/9") || t.includes("16x9"))
    return "16:9";
  if (t === "正方形" || t.includes("1:1") || t.includes("1：1") || t.includes("1/1") || t.includes("1x1")) return "1:1";
  if (t.includes("2:3") || t.includes("2：3") || t.includes("2/3") || t.includes("2x3")) return "2:3";
  if (t.includes("3:2") || t.includes("3：2") || t.includes("3/2") || t.includes("3x2")) return "3:2";
  if (t.includes("3:4") || t.includes("3：4") || t.includes("3/4") || t.includes("3x4")) return "3:4";
  if (t.includes("4:3") || t.includes("4：3") || t.includes("4/3") || t.includes("4x3")) return "3:4";
  // bare tokens like 9:16 without surrounding punctuation
  if (/^9[:：/x×]16$/.test(t)) return "9:16";
  if (/^16[:：/x×]9$/.test(t)) return "16:9";
  if (/^2[:：/x×]3$/.test(t)) return "2:3";
  if (/^3[:：/x×]2$/.test(t)) return "3:2";
  if (/^3[:：/x×]4$/.test(t)) return "3:4";
  if (/^1[:：/x×]1$/.test(t)) return "1:1";
  return null;
}

/** 更宽松：全文搜比例 token */
function extractRatio(text: string): { ratio: CoverRatio; cleaned: string } {
  let ratio: CoverRatio = DEFAULT_RATIO;
  let cleaned = text;

  // 优先匹配「.9:16」「，9：16」等粘连写法
  const loose = text.match(
    /(?:^|[\s,，。.;；|/]|比例|尺寸)[\s:：.]*((?:9|16|2|3|4|1)\s*[:：/xX×]\s*(?:16|9|3|2|4|1)|竖版|横版|正方形)/,
  );
  if (loose?.[1]) {
    const r = normalizeRatioToken(loose[1]);
    if (r) {
      ratio = r;
      cleaned = text.replace(loose[0], " ").replace(/\s+/g, " ").trim();
    }
  } else {
    // 纯「9:16」出现在任意位置
    const bare = text.match(/(?:9|16|2|3|4|1)\s*[:：/xX×]\s*(?:16|9|3|2|4|1)/);
    if (bare?.[0]) {
      const r = normalizeRatioToken(bare[0]);
      if (r) {
        ratio = r;
        cleaned = text.replace(bare[0], " ").replace(/\s+/g, " ").trim();
      }
    }
  }

  // 去掉残留标点
  cleaned = cleaned
    .replace(/^[，,。.\s:：;/|]+|[，,。.\s:：;/|]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return { ratio, cleaned };
}

interface GenreStyle {
  id: string;
  keywords: RegExp;
  label: string;
  style: string;
  palette: string;
  figure: string;
  background: string;
  light: string;
}

const GENRES: GenreStyle[] = [
  {
    id: "xianxia",
    keywords: /玄幻|仙侠|修仙|修真|宗门|飞升|万族|争霸|灵根|仙帝|剑修|妖修|洪荒|遮天|斗破/,
    label: "xianxia Chinese fantasy",
    style: "xianxia Chinese fantasy art style, ethereal epic atmosphere, mass-market web novel cover",
    palette: "deep blue, gold, white, black, cyan spiritual energy",
    figure:
      "a powerful young cultivator in flowing dark robes with gold embroidery, long black hair, cold determined eyes, aura of dominance, subtle ancient clan markings",
    background:
      "war banners of countless races, floating immortal peaks, cracked sky rift, distant battle of races, spirit beasts silhouettes",
    light: "dramatic golden divine light from above, mystical mist, spiritual energy particles",
  },
  {
    id: "wuxia",
    keywords: /武侠|江湖|门派|侠客|刀客|剑客/,
    label: "wuxia",
    style: "classic Chinese wuxia illustration, ink-wash meets digital painting",
    palette: "ink black, blood red, misty grey, pale gold",
    figure: "a lone swordsman in travel-worn robes, sword at side, resolute stance",
    background: "bamboo forest, rain, distant mountains, ink-wash atmosphere",
    light: "cold moonlight from the left casting long shadows",
  },
  {
    id: "urban",
    keywords: /都市|霸总|重生|系统|兵王|学霸|神医|战神|娱乐圈/,
    label: "urban modern",
    style: "modern urban contemporary cinematic cover, clean premium look",
    palette: "deep blue, charcoal, gold accents, neon night highlights",
    figure: "a sharp modern man in tailored dark suit, confident expression, city power vibe",
    background: "glass skyscraper skyline at night, rain-slick streets, neon rim light",
    light: "sharp city lights, sunset glow on glass buildings",
  },
  {
    id: "ancient-romance",
    keywords: /古言|宫斗|宅斗|嫡女|王妃|皇帝|后宫|穿书/,
    label: "ancient Chinese romance",
    style: "ancient Chinese palace drama, elegant classical beauty",
    palette: "crimson, gold, ink black, warm lantern tones",
    figure: "an elegant woman in ornate hanfu with phoenix hair ornaments, refined makeup",
    background: "palace halls, red walls, pearl curtains, lanterns, silk screens",
    light: "warm lantern light, golden candle glow, silk shimmer",
  },
  {
    id: "romance",
    keywords: /现言|甜宠|恋爱|婚|萌宝|契约|替嫁|豪门/,
    label: "modern romance",
    style: "modern romance cover art, soft dreamy warm atmosphere",
    palette: "soft pink, warm white, light gold",
    figure: "a romantic couple, intimate but tasteful pose, soft expressions",
    background: "cafe window light, garden bokeh, gentle city dusk",
    light: "soft warm backlighting, dreamy bokeh, gentle sunset glow",
  },
  {
    id: "mystery",
    keywords: /悬疑|推理|刑侦|诡|密室|连环|侦探/,
    label: "mystery thriller",
    style: "dark mystery thriller, noir atmosphere, high contrast shadows",
    palette: "black, deep grey, cold blue, blood-red accents",
    figure: "a half-shadowed figure, coat collar up, tense focused eyes",
    background: "rainy night street, old buildings, reflective wet asphalt",
    light: "dramatic chiaroscuro, single spotlight, rain-slicked reflections",
  },
  {
    id: "scifi",
    keywords: /科幻|星际|末世|机甲|赛博|废土|进化|赛博朋克/,
    label: "sci-fi",
    style: "sci-fi cyberpunk, futuristic technology, post-apocalyptic edge",
    palette: "deep blue, black, silver, neon cyan and electric purple",
    figure: "a warrior in advanced tactical armor with glowing UI reflections",
    background: "ruined megacity, holographic interfaces, stormy sky",
    light: "neon rim lighting, holographic blue glow, energy arcs",
  },
  {
    id: "western-fantasy",
    keywords: /西幻|魔法|龙族|精灵|骑士|异世界|领主/,
    label: "western fantasy",
    style: "epic western fantasy illustration, oil-painting digital hybrid",
    palette: "royal purple, gold, forest green, storm grey",
    figure: "a hero with cloak and enchanted weapon, determined stance",
    background: "castle ruins, dragons in the sky, magical runes",
    light: "storm-break sunlight, magical particle glow",
  },
  {
    id: "horror",
    keywords: /灵异|恐怖|鬼|阴阳|盗墓|风水|咒/,
    label: "supernatural horror",
    style: "supernatural horror cover, eerie uncanny atmosphere",
    palette: "sickly green, black, bone white, muted red",
    figure: "a tense explorer half-turned, flashlight cutting fog",
    background: "ancient tomb corridor, hanging talismans, thick fog",
    light: "cold weak light, greenish fog glow, dripping shadows",
  },
  {
    id: "history",
    keywords: /历史|三国|大唐|大明|军旅|将军|朝堂/,
    label: "historical epic",
    style: "historical epic illustration, cinematic grandeur",
    palette: "deep red, bronze, black, parchment gold",
    figure: "a general in armor holding a command banner, steely gaze",
    background: "battlefield dust, war banners, palace silhouette",
    light: "harsh noon sun through dust, bronze metal reflections",
  },
];

function detectGenre(text: string): GenreStyle {
  for (const g of GENRES) {
    if (g.keywords.test(text)) return g;
  }
  // 默认偏男频网文封面质感，避免空模板
  return GENRES[0];
}

function ratioInstruction(ratio: CoverRatio): string {
  switch (ratio) {
    case "9:16":
      return "strict portrait orientation 9:16 vertical mobile novel cover, tall composition";
    case "2:3":
      return "portrait orientation 2:3 vertical book cover";
    case "3:4":
      return "portrait orientation 3:4 vertical book cover (Fanqie-like)";
    case "16:9":
      return "landscape orientation 16:9 widescreen composition";
    case "3:2":
      return "landscape orientation 3:2 composition";
    default:
      return "square 1:1 composition";
  }
}

/**
 * 把用户一句话需求扩成可用的封面英文 prompt，并解析 size。
 * analysis：可选参考图风格分析（中文/英文皆可）。
 * activatedCoverPrompt：已激活的封面提示词包内容（可选）
 */
export function buildCoverImagePrompt(opts: {
  userText?: string;
  analysis?: string;
  /** 显式覆盖比例；不传则从 userText 解析，默认 9:16 */
  ratio?: CoverRatio;
  /** 是否要求画面预留标题区（默认 true；不强制渲染具体中文字，避免模型乱字） */
  reserveTitleSpace?: boolean;
  /** 已激活的封面提示词包内容 */
  activatedCoverPrompt?: string | null;
}): CoverPromptResult {
  const raw = (opts.userText ?? "").trim();
  const { ratio: parsedRatio, cleaned } = extractRatio(raw);
  const ratio = opts.ratio ?? parsedRatio;
  const size = RATIO_SIZE[ratio];
  const sceneHint = cleaned || "epic Chinese web novel atmosphere";
  const genre = detectGenre(`${raw} ${cleaned}`);
  const reserveTitle = opts.reserveTitleSpace !== false;

  const analysisLine = opts.analysis?.trim()
    ? `Reference visual style notes: ${opts.analysis.trim().slice(0, 600)}.`
    : "";

  // 场景：把用户短语写进画面意图，而不是原样中文塞满 prompt
  const sceneLine = `Core theme from author brief: "${sceneHint}". Interpret into a striking single key visual that sells this web novel at a glance.`;

  const titleBlock = reserveTitle
    ? "Leave a clean dark or soft-blurred safe area in the upper third for title typography (do NOT render garbled Chinese characters; empty elegant space is preferred)."
    : "No title typography required.";

  // 如果有激活的封面提示词包，使用它替换默认风格
  const styleLine = opts.activatedCoverPrompt ? opts.activatedCoverPrompt : `${genre.style}.`;

  const prompt = [
    "Professional Chinese web novel cover design, high-end digital painting illustration (not photo, not 3D render).",
    styleLine,
    sceneLine,
    `Main subject: ${genre.figure}.`,
    `Background layers: ${genre.background}.`,
    `Lighting: ${genre.light}.`,
    `Color palette: ${genre.palette}.`,
    analysisLine,
    "Composition: character-forward, clear silhouette, high contrast, mobile-thumbnail readable, cinematic depth (foreground / midground / far atmosphere).",
    titleBlock,
    `${ratioInstruction(ratio)}.`,
    "Ultra detailed, sharp focus on face and key props, premium mass-market novel cover quality, no watermark, no UI chrome, no border frame, no QR code, no English gibberish text.",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    prompt,
    size,
    ratio,
    sceneHint,
    genre: genre.id,
  };
}

/** 供 API 校验 / 文档 */
export function resolveCoverSize(input?: string): { size: string; ratio: CoverRatio } {
  if (!input?.trim()) {
    return { size: RATIO_SIZE[DEFAULT_RATIO], ratio: DEFAULT_RATIO };
  }
  const t = input.trim().toLowerCase();
  // 已是 WxH
  const wh = t.match(/^(\d{3,4})\s*[x×]\s*(\d{3,4})$/);
  if (wh) {
    const w = Number(wh[1]);
    const h = Number(wh[2]);
    let ratio: CoverRatio = "1:1";
    const r = w / h;
    if (Math.abs(r - 9 / 16) < 0.08) ratio = "9:16";
    else if (Math.abs(r - 2 / 3) < 0.08) ratio = "2:3";
    else if (Math.abs(r - 3 / 4) < 0.08) ratio = "3:4";
    else if (Math.abs(r - 16 / 9) < 0.08) ratio = "16:9";
    else if (Math.abs(r - 3 / 2) < 0.08) ratio = "3:2";
    else if (Math.abs(r - 1) < 0.05) ratio = "1:1";
    return { size: `${w}x${h}`, ratio };
  }
  const asRatio = normalizeRatioToken(t);
  if (asRatio) return { size: RATIO_SIZE[asRatio], ratio: asRatio };
  return { size: RATIO_SIZE[DEFAULT_RATIO], ratio: DEFAULT_RATIO };
}
