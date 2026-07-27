/**
 * KDP 导出
 * 生成 KDP 就绪的 Word 文档 (.docx)
 */
import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import { saveAs } from "file-saver";

export interface ChapterData {
  title: string;
  content: string;
  chapterNum?: number;
}

export interface ExportOptions {
  title: string;
  author?: string;
  includeTitlePage?: boolean;
  includeToc?: boolean;
  chapterPrefix?: string; // "第N章" 前缀
}

/**
 * 将章节内容转换为 KDP 就绪的 Word Blob
 */
export async function generateKdpDocx(chapters: ChapterData[], options: ExportOptions): Promise<Blob> {
  const doc = new Document({
    creator: options.author || "withyou-novel",
    title: options.title,
    description: `《${options.title}》KDP Ready Export`,
    sections: [
      {
        properties: {},
        children: [
          // 封面
          ...(options.includeTitlePage
            ? [
                new Paragraph({ children: [] }),
                new Paragraph({ children: [] }),
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [new TextRun({ text: options.title, bold: true, size: 48 })],
                }),
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [new TextRun({ text: `作者：${options.author || "佚名"}`, size: 24 })],
                }),
                new Paragraph({ children: [], pageBreakBefore: true }),
              ]
            : []),
          // TOC 占位
          ...(options.includeToc
            ? [
                new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("目录")] }),
                new Paragraph({
                  children: chapters.map(
                    (c, i) => new TextRun({ text: `${options.chapterPrefix || "第"}${i + 1}章 ${c.title}`, size: 20 }),
                  ),
                }),
                new Paragraph({ children: [], pageBreakBefore: true }),
              ]
            : []),
          // 章节内容
          ...chapters.flatMap((ch) => [
            new Paragraph({
              heading: HeadingLevel.HEADING_1,
              children: [
                new TextRun({
                  text: `${options.chapterPrefix || "第"}${ch.chapterNum ?? "?"}章 ${ch.title}`,
                  bold: true,
                  size: 32,
                }),
              ],
            }),
            ...splitParagraphs(ch.content).map(
              (p) =>
                new Paragraph({
                  spacing: { after: 120, line: 360 },
                  indent: { firstLine: 480 },
                  children: [new TextRun({ text: p || " ", size: 24 })],
                }),
            ),
            new Paragraph({ children: [], pageBreakBefore: true }),
          ]),
        ],
      },
    ],
  });

  return await Packer.toBlob(doc);
}

function splitParagraphs(content: string): string[] {
  return content
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * 触发浏览器下载
 */
export async function downloadKdpDocx(chapters: ChapterData[], options: ExportOptions) {
  const blob = await generateKdpDocx(chapters, options);
  const filename = `${options.title}_KDP_Ready.docx`;
  saveAs(blob, filename);
  return filename;
}

export default { generateKdpDocx, downloadKdpDocx };
