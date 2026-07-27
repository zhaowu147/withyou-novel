import packageJson from "../../package.json";

const currentYear = new Date().getFullYear();

export const APP_CONFIG = {
  name: "𝒲𝒾𝓉𝒽 𝒴ℴ𝓊",
  version: packageJson.version,
  copyright: `© ${currentYear}, 𝒲𝒾𝓉𝒽 𝒴ℴ𝓊.`,
  meta: {
    title: "𝒲𝒾𝓉𝒽 𝒴ℴ𝓊 — 人机协作小说创作平台",
    description:
      "不是 AI 替你写书。是你与 AI 一起,把脑子里的一本本书,变成真实存在的文字。从书名到世界观,从大纲到每一章正文 —— 先确认,再动笔,字字都经你手。",
  },
};
