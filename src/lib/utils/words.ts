/**
 * 中英混合字数统计:中文字符数 + 英文单词数
 */
export function countWords(text: string): number {
  if (!text) return 0;
  const cn = (text.match(/[一-龥]/g) || []).length;
  const en = (text.match(/[a-zA-Z]+/g) || []).length;
  return cn + en;
}
