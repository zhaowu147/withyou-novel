import { generateAgnesImage } from "@/lib/ai/agnes-image";
import { type ChannelType, gatewayCall } from "@/lib/ai/gateway";
import { novelFS } from "@/lib/novel-fs";

export const NOVEL_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "novel_init",
      description: "Create or switch novel project",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Project name" },
          title: { type: "string", description: "Book title" },
          totalChapters: { type: "number", description: "Target chapter count" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "novel_write_chapter",
      description: "Write a new chapter with auto context and save to disk",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Chapter title" },
          chapterNum: { type: "number", description: "Chapter number" },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "novel_read_chapter",
      description: "Read a chapter or list all chapters",
      parameters: {
        type: "object",
        properties: { chapterNum: { type: "number", description: "Chapter number, omit to list all" } },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "novel_generate_cover",
      description: "Generate book cover image via AI",
      parameters: {
        type: "object",
        properties: { prompt: { type: "string", description: "Cover description" } },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "novel_analyze",
      description: "Analyze chapter pacing, hooks, characters, foreshadowing",
      parameters: {
        type: "object",
        properties: {
          chapterNum: { type: "number", description: "Chapter number" },
          text: { type: "string", description: "Or provide text directly" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "novel_entity_enrich",
      description: "AI identify characters/locations/items and save to character file",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "Text to analyze" } },
        required: ["text"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "novel_foreshadow_scan",
      description: "Scan for planted and resolved foreshadowing",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "Text to scan" } },
        required: ["text"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "novel_update_setting",
      description: "Update outline, characters or worldview settings",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", description: "outline|characters|worldview" },
          content: { type: "string", description: "New content" },
        },
        required: ["type", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "novel_status",
      description: "Check project chapter progress and settings completeness",
      parameters: { type: "object", properties: {} },
    },
  },
];

let activeNovel: string | null = null;
let activeChapter = 1;

export async function executeNovelTool(
  name: string,
  args: Record<string, unknown>,
  textChannel: ChannelType = "tool",
): Promise<string> {
  switch (name) {
    case "novel_init": {
      const n = args.name as string;
      const t = args.title as string | undefined;
      const tc = args.totalChapters as number | undefined;
      if (!novelFS.projectExists(n)) {
        novelFS.createProject(n);
        novelFS.writeFile(n, "设定/大纲.md", `# ${t || n}\n\nChapters: ${tc || 300}\n\n## Synopsis\n\nTBD\n`);
        novelFS.writeFile(n, "设定/人物.md", "# Characters\n\nTBD\n");
        novelFS.writeFile(n, "设定/世界观.md", "# Worldbuilding\n\nTBD\n");
      }
      activeNovel = n;
      activeChapter = 1;
      const fs = novelFS.listAllFiles(n).filter((x: string) => x.startsWith("正文/"));
      return `Project [${t || n}] ready. Chapters: ${fs.length}. Next: Chapter ${activeChapter}`;
    }
    case "novel_write_chapter": {
      const pn = activeNovel || "default";
      if (!novelFS.projectExists(pn)) novelFS.createProject(pn);
      const title = args.title as string;
      const cn = (args.chapterNum as number) ?? activeChapter;
      let ctx = "";
      try {
        const o = novelFS.readFile(pn, "设定/大纲.md");
        const c = novelFS.readFile(pn, "设定/人物.md");
        const w = novelFS.readFile(pn, "设定/世界观.md");
        const prev: string[] = [];
        for (let i = Math.max(1, cn - 3); i < cn; i++) {
          try {
            const ch = novelFS.readFile(pn, `正文/第${i}章.md`);
            prev.push(`Ch${i}:\n${ch.slice(0, 2000)}`);
          } catch {
            /* */
          }
        }
        ctx = [
          o ? `## Outline\n${o}` : "",
          c ? `## Characters\n${c}` : "",
          w ? `## World\n${w}` : "",
          prev.length ? `## Previous\n${prev.join("\n\n")}` : "",
        ]
          .filter(Boolean)
          .join("\n\n---\n\n");
      } catch {
        /* */
      }
      const sp =
        "You are a professional web novelist.\n\nRules:\n- 2000-4000 words per chapter\n- Must have a hook at the end\n- 30-40% dialogue\n\n" +
        ctx;
      const raw = await gatewayCall({
        channel: textChannel === "tool" || textChannel === "dispatch" ? "tool" : "write",
        systemPrompt: sp,
        messages: [{ role: "user", content: `Write Chapter ${cn}: ${title}` }],
        maxTokens: 30000,
        temperature: 0.83,
      });
      novelFS.writeChapter(pn, cn, title, raw);
      activeChapter = cn + 1;
      return `Chapter ${cn} [${title}] done! Words: ${raw.length}. Next: Chapter ${activeChapter}`;
    }
    case "novel_read_chapter": {
      if (!activeNovel) return "Use novel_init first";
      const cn = args.chapterNum as number | undefined;
      if (!cn) {
        const fs = novelFS
          .listAllFiles(activeNovel)
          .filter((x: string) => x.startsWith("正文/"))
          .sort();
        return fs.length
          ? `Chapters:\n${fs.map((x: string) => `- ${x.replace("正文/", "").replace(".md", "")}`).join("\n")}`
          : "No chapters yet";
      }
      try {
        return novelFS.readFile(activeNovel, `正文/第${cn}章.md`);
      } catch {
        return `Chapter ${cn} not found`;
      }
    }
    case "novel_generate_cover": {
      const p = args.prompt as string;
      try {
        const { buildCoverImagePrompt } = await import("@/lib/ai/cover-prompt");
        const built = buildCoverImagePrompt({ userText: p });
        const { images } = await generateAgnesImage({
          prompt: built.prompt,
          size: built.size,
          n: 1,
          timeoutMs: 180_000,
        });
        return images[0]?.url ? `Cover (${built.ratio}/${built.genre}): ${images[0].url}` : "Generation failed";
      } catch (e: unknown) {
        return `Agnes cover failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    case "novel_analyze": {
      const cn = args.chapterNum as number | undefined;
      let t = (args.text as string) || "";
      if (!t && cn && activeNovel) {
        try {
          t = novelFS.readFile(activeNovel, `正文/第${cn}章.md`);
        } catch {
          return "Not found";
        }
      }
      if (!t) return "Provide chapter number or text";
      return gatewayCall({
        channel: textChannel,
        systemPrompt: "Analyze this chapter. Output pacing, hooks, characters, foreshadowing assessment.",
        messages: [{ role: "user", content: `Analyze:\n\n${t.slice(0, 8000)}` }],
        maxTokens: 2048,
        temperature: 0.3,
      });
    }
    case "novel_entity_enrich": {
      if (!activeNovel) return "Use novel_init first";
      const text = args.text as string;
      const raw = await gatewayCall({
        channel: textChannel,
        systemPrompt:
          'Extract characters/locations/factions/items/events. Output JSON: [{"name":"","type":"character|location|faction|item|event","importance":"high|mid|low","summary":""}]',
        messages: [{ role: "user", content: text.slice(0, 6000) }],
        maxTokens: 30000,
        temperature: 0.3,
      });
      let entities: Array<{ name: string; type: string; importance: string; summary: string }> = [];
      try {
        entities = JSON.parse(raw.match(/\[[\\s\\S]*\]/)?.[0] || "[]");
      } catch {
        return "Parse failed";
      }
      if (!entities.length) return "No new entities found";
      const pn = activeNovel || "default";
      if (!novelFS.projectExists(pn)) novelFS.createProject(pn);
      let n = 0;
      for (const e of entities) {
        try {
          const ex = novelFS.readFile(pn, "设定/人物.md");
          if (!ex.includes(e.name)) {
            novelFS.writeFile(pn, "设定/人物.md", `${ex}\n### ${e.name} (${e.type}) [${e.importance}]\n${e.summary}\n`);
            n++;
          }
        } catch {
          novelFS.writeFile(
            pn,
            "设定/人物.md",
            `# Characters\n\n### ${e.name} (${e.type}) [${e.importance}]\n${e.summary}\n`,
          );
          n++;
        }
      }
      return `Saved ${n} entities: ${entities.map((e: { name: string }) => e.name).join(", ")}`;
    }
    case "novel_foreshadow_scan": {
      if (!activeNovel) return "Use novel_init first";
      const text = args.text as string;
      const raw = await gatewayCall({
        channel: textChannel,
        systemPrompt:
          "Scan this chapter for newly planted foreshadowing and resolved foreshadowing. Output bullet points.",
        messages: [{ role: "user", content: text.slice(0, 6000) }],
        maxTokens: 2048,
        temperature: 0.4,
      });
      const pn = activeNovel || "default";
      if (novelFS.projectExists(pn)) {
        try {
          const ex = novelFS.readFile(pn, "追踪/伏笔.md");
          novelFS.writeFile(pn, "追踪/伏笔.md", `${ex}\n\n---\n## Scan\n${raw}`);
        } catch {
          novelFS.writeFile(pn, "追踪/伏笔.md", `# Foreshadowing\n\n${raw}`);
        }
      }
      return `Foreshadow scan:\n${raw}`;
    }
    case "novel_update_setting": {
      if (!activeNovel) return "Use novel_init first";
      const type = args.type as string;
      const content = args.content as string;
      const m: Record<string, string> = {
        outline: "设定/大纲.md",
        characters: "设定/人物.md",
        worldview: "设定/世界观.md",
      };
      if (!m[type]) return `Unknown type: ${type}`;
      novelFS.writeFile(activeNovel, m[type], content);
      return `${type} updated`;
    }
    case "novel_status": {
      if (!activeNovel) return "No project. Use novel_init";
      const fs = novelFS.listAllFiles(activeNovel);
      const chs = fs.filter((x: string) => x.startsWith("正文/"));
      const last =
        chs.length > 0
          ? Math.max(
              ...chs.map((x: string) => {
                const m = x.match(/第(\d+)章/);
                return m ? parseInt(m[1], 10) : 0;
              }),
            )
          : 0;
      const ok = (p: string) => (fs.some((x: string) => x === p) ? "Yes" : "No");
      return (
        "Project: " +
        activeNovel +
        " | Chapters: " +
        chs.length +
        "(last: Ch" +
        last +
        ") | Outline:" +
        ok("设定/大纲.md") +
        " Characters:" +
        ok("设定/人物.md") +
        " World:" +
        ok("设定/世界观.md")
      );
    }
    default:
      return `Unknown tool: ${name}`;
  }
}
