export interface ImportedChapter {
  number: number;
  title: string;
  content: string;
  wordCount: number;
  sourceHeading?: string;
}

export interface ParsedNovelImport {
  title: string;
  chapters: ImportedChapter[];
  totalCharacters: number;
  estimatedInputTokens: { min: number; max: number };
}

const CHAPTER_HEADING =
  /^(?:#{1,3}\s*)?(?:(第\s*([零〇一二三四五六七八九十百千万两\d]+)\s*[章节回卷])|(chapter\s+(\d+))|(序章|楔子|前言|引子|终章|尾声|后记|番外(?:\s*\d+)?))[\s:：、._-]*(.*)$/gim;

const DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

function chineseNumber(input: string): number | null {
  const normalized = input.replace(/\s/g, "");
  if (/^\d+$/.test(normalized)) return Number(normalized);
  let result = 0;
  let section = 0;
  let digit = 0;
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
  for (const char of normalized) {
    if (char in DIGITS) {
      digit = DIGITS[char];
      continue;
    }
    const unit = units[char];
    if (!unit) return null;
    if (unit === 10000) {
      section = (section + digit) * unit;
      result += section;
      section = 0;
    } else {
      section += (digit || 1) * unit;
    }
    digit = 0;
  }
  const value = result + section + digit;
  return value > 0 ? value : null;
}

function cleanTitle(heading: string, suffix: string, fallback: string): string {
  const cleaned = suffix.replace(/^[-—:：、.\s]+/, "").trim();
  if (cleaned) return cleaned;
  if (/序章|楔子|前言|引子|终章|尾声|后记|番外/i.test(heading)) {
    return heading.replace(/^#{1,3}\s*/, "").trim();
  }
  return fallback;
}

function normalizeText(text: string): string {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

export function parseNovelText(text: string, fileName = "导入作品"): ParsedNovelImport {
  const normalized = normalizeText(text);
  const title = fileName.replace(/\.(txt|md)$/i, "").trim() || "导入作品";
  const positions: Array<{
    start: number;
    end: number;
    explicitNumber: number | null;
    heading: string;
    suffix: string;
  }> = [];

  CHAPTER_HEADING.lastIndex = 0;
  for (let match = CHAPTER_HEADING.exec(normalized); match; match = CHAPTER_HEADING.exec(normalized)) {
    positions.push({
      start: match.index,
      end: match.index + match[0].length,
      explicitNumber: chineseNumber(match[2] || match[4] || ""),
      heading: match[0].trim(),
      suffix: match[6] || "",
    });
  }

  const chapters: ImportedChapter[] = [];
  if (!positions.length) {
    chapters.push({
      number: 1,
      title,
      content: normalized,
      wordCount: normalized.replace(/\s/g, "").length,
    });
  } else {
    const preface = normalized.slice(0, positions[0].start).trim();
    for (let index = 0; index < positions.length; index += 1) {
      const current = positions[index];
      const nextStart = positions[index + 1]?.start ?? normalized.length;
      let body = normalized.slice(current.end, nextStart).trim();
      if (index === 0 && preface) body = `${preface}\n\n${body}`.trim();
      const proposed = current.explicitNumber ?? index + 1;
      const previous = chapters.at(-1)?.number ?? 0;
      const number = proposed > previous ? proposed : previous + 1;
      const fallback = `第${number}章`;
      const chapterTitle = cleanTitle(current.heading, current.suffix, fallback);
      const content = `# 第${number}章 ${chapterTitle}\n\n${body}`.trim();
      chapters.push({
        number,
        title: chapterTitle,
        content,
        wordCount: content.replace(/\s/g, "").length,
        sourceHeading: current.heading,
      });
    }
  }

  const totalCharacters = chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0);
  return {
    title,
    chapters,
    totalCharacters,
    estimatedInputTokens: {
      min: Math.ceil(totalCharacters * 0.7),
      max: Math.ceil(totalCharacters * 1.2),
    },
  };
}

export function decodeChapterRecord(key: string, value: string): ImportedChapter {
  const fallbackNumber = Number(key.match(/\d+/)?.[0] || 1);
  try {
    const parsed = JSON.parse(value) as { title?: unknown; content?: unknown };
    const content = typeof parsed.content === "string" ? parsed.content : value;
    return {
      number: fallbackNumber,
      title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title : `第${fallbackNumber}章`,
      content,
      wordCount: content.replace(/\s/g, "").length,
    };
  } catch {
    return {
      number: fallbackNumber,
      title: `第${fallbackNumber}章`,
      content: value,
      wordCount: value.replace(/\s/g, "").length,
    };
  }
}

export function novelDataChapters(chapters: Record<string, string>): ImportedChapter[] {
  return Object.entries(chapters)
    .map(([key, value]) => decodeChapterRecord(key, value))
    .sort((a, b) => a.number - b.number);
}
