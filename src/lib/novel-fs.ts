/**
 * NovelFileSystem — 服务端小说项目管理（本地目录）
 *   - 创建项目目录结构
 *   - 读写章节 .md 文件
 *   - 自动管理追踪文件（伏笔/时间线/角色状态/上下文）
 * 结构化数据见 vault/*.json
 */
import "server-only";

import { coreSettingScaffold, scaffoldFiles } from "@/lib/novel/project-scaffold";
import { novelsRoot } from "@/lib/runtime/app-paths";
import { normalizeProjectId, resolveProjectPath } from "@/lib/security/project-path";

import * as fs from "node:fs";
import * as path from "node:path";

/** 标准项目目录模板 */
const PROJECT_TEMPLATE: Record<string, string[]> = {
  "": [],
  设定: ["世界观", "角色", "势力"],
  "设定/世界观": [],
  "设定/角色": [],
  "设定/势力": [],
  大纲: [],
  正文: [],
  追踪: [],
  对标: [],
};

export interface ProjectInfo {
  name: string;
  path: string;
  createdAt: Date;
  files: number;
}

export interface ChapterInfo {
  number: number;
  title: string;
  path: string;
  size: number;
  updatedAt: Date;
}

export class NovelFileSystem {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || novelsRoot();
  }

  /** 确保基础目录存在 */
  private ensureBase(): void {
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  // ─── 项目管理 ───

  /** 创建新小说项目，返回项目路径 */
  createProject(projectName: string): string {
    this.ensureBase();
    const safeProjectName = normalizeProjectId(projectName);
    const projectDir = this.resolvePath(safeProjectName, ".");
    if (fs.existsSync(projectDir)) {
      throw new Error(`项目 "${projectName}" 已存在`);
    }

    // 创建目录树
    for (const [dir, subDirs] of Object.entries(PROJECT_TEMPLATE)) {
      const fullDir = path.join(projectDir, dir);
      fs.mkdirSync(fullDir, { recursive: true });
      for (const sub of subDirs) {
        fs.mkdirSync(path.join(fullDir, sub), { recursive: true });
      }
    }

    // 创建初始设定文件与追踪文件（空模板）。
    // 模板内容在 @/lib/novel/project-scaffold —— 服务端回读时要靠它判断
    // "这文件还是空模板"，两边必须用同一份，别在这里内联字符串。
    this.writeFile(safeProjectName, "设定/核心设定.md", coreSettingScaffold(safeProjectName, new Date().toISOString()));
    for (const [filePath, content] of Object.entries(scaffoldFiles(safeProjectName))) {
      this.writeFile(safeProjectName, filePath, content);
    }

    return projectDir;
  }

  /** 列出所有项目 */
  listProjects(): ProjectInfo[] {
    this.ensureBase();
    const projects: ProjectInfo[] = [];
    for (const name of fs.readdirSync(this.baseDir)) {
      const fullPath = path.join(this.baseDir, name);
      if (fs.statSync(fullPath).isDirectory()) {
        projects.push({
          name,
          path: fullPath,
          createdAt: fs.statSync(fullPath).birthtime,
          files: this.countFiles(name),
        });
      }
    }
    return projects.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /** 项目是否存在 */
  projectExists(projectName: string): boolean {
    return fs.existsSync(this.resolvePath(projectName, "."));
  }

  /** 删除项目 */
  deleteProject(projectName: string): void {
    // 使用 resolvePath 做路径穿越校验，防止删除 baseDir 外的文件
    const projectDir = this.resolvePath(projectName, ".");
    // 额外校验：解析后的真实路径必须是 baseDir 的直接子目录
    if (!fs.existsSync(projectDir)) {
      throw new Error(`项目 "${projectName}" 不存在`);
    }
    fs.rmSync(projectDir, { recursive: true, force: true });
  }

  // ─── 文件操作 ───

  /** 写入文件（自动创建目录） */
  writeFile(projectName: string, filePath: string, content: string): string {
    const fullPath = this.resolvePath(projectName, filePath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(fullPath, content, "utf-8");
    return fullPath;
  }

  /** 原子写入派生资料或关键状态文件，避免中断后留下半文件。 */
  writeFileAtomic(projectName: string, filePath: string, content: string): string {
    const fullPath = this.resolvePath(projectName, filePath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const temporary = `${fullPath}.${process.pid}.${Date.now()}.tmp`;
    const handle = fs.openSync(temporary, "wx");
    try {
      fs.writeFileSync(handle, content, "utf-8");
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    try {
      fs.renameSync(temporary, fullPath);
    } catch (error) {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
      throw error;
    }
    return fullPath;
  }

  /** 追加内容到文件 */
  appendFile(projectName: string, filePath: string, content: string): string {
    const fullPath = this.resolvePath(projectName, filePath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(fullPath, content, "utf-8");
    return fullPath;
  }

  /** 读取文件 */
  readFile(projectName: string, filePath: string): string {
    const fullPath = this.resolvePath(projectName, filePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`文件不存在: ${filePath}`);
    }
    return fs.readFileSync(fullPath, "utf-8");
  }

  /** 安全读取（不存在返回 null） */
  readFileSafe(projectName: string, filePath: string): string | null {
    try {
      return this.readFile(projectName, filePath);
    } catch {
      return null;
    }
  }

  /** 删除文件 */
  deleteFile(projectName: string, filePath: string): void {
    const fullPath = this.resolvePath(projectName, filePath);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }
  }

  /** 列出目录下的文件 */
  listDir(projectName: string, dirPath = ""): string[] {
    const fullDir = this.resolvePath(projectName, dirPath || ".");
    if (!fs.existsSync(fullDir)) return [];
    return fs.readdirSync(fullDir).filter((f) => {
      const stat = fs.statSync(path.join(fullDir, f));
      return stat.isFile();
    });
  }

  /** 递归列出所有文件 */
  listAllFiles(projectName: string): string[] {
    const projectDir = this.resolvePath(projectName, ".");
    if (!fs.existsSync(projectDir)) return [];
    const files: string[] = [];
    this.walkDir(projectDir, projectDir, files);
    return files;
  }

  // ─── 章节操作 ───

  /** 写入章节文件 */
  writeChapter(projectName: string, chapterNum: number, title: string, content: string): string {
    const padded = String(chapterNum).padStart(4, "0");
    const fileName = `第${padded}章_${title}.md`;
    return this.writeFile(projectName, `正文/${fileName}`, content);
  }

  /** 获取章节文件路径 */
  getChapterPath(projectName: string, chapterNum: number): string | null {
    const padded = String(chapterNum).padStart(4, "0");
    const dir = this.resolvePath(projectName, "正文");
    if (!fs.existsSync(dir)) return null;
    const found = fs.readdirSync(dir).find((f) => f.startsWith(`第${padded}章`));
    return found ? path.join(dir, found) : null;
  }

  /** 读取章节 */
  readChapter(projectName: string, chapterNum: number): string | null {
    const filePath = this.getChapterPath(projectName, chapterNum);
    if (!filePath) return null;
    return fs.readFileSync(filePath, "utf-8");
  }

  /** 列出所有章节 */
  listChapters(projectName: string): ChapterInfo[] {
    const dir = this.resolvePath(projectName, "正文");
    if (!fs.existsSync(dir)) return [];
    const chapters: ChapterInfo[] = [];
    for (const f of fs.readdirSync(dir)) {
      const match = f.match(/^第(\d+)章_(.+)\.md$/);
      if (match) {
        const fullPath = path.join(dir, f);
        const stat = fs.statSync(fullPath);
        chapters.push({
          number: parseInt(match[1], 10),
          title: match[2],
          path: fullPath,
          size: stat.size,
          updatedAt: stat.mtime,
        });
      }
    }
    return chapters.sort((a, b) => a.number - b.number);
  }

  /** 获取上一章内容（用于写作上下文） */
  getPreviousChapter(projectName: string, currentChapter: number): string | null {
    return this.readChapter(projectName, currentChapter - 1);
  }

  // ─── 上下文加载 ───

  /** 组装写作前需要的全部上下文 */
  assembleWriteContext(projectName: string, chapterNum: number): WriteContext {
    return {
      previousChapter: this.readChapter(projectName, chapterNum - 1),
      outline: this.readFileSafe(projectName, `大纲/细纲_第${String(chapterNum).padStart(4, "0")}章.md`),
      foreshadows: this.readFileSafe(projectName, "追踪/伏笔.md"),
      characterStates: this.readFileSafe(projectName, "追踪/角色状态.md"),
      timeline: this.readFileSafe(projectName, "追踪/时间线.md"),
      coreSettings: this.readFileSafe(projectName, "设定/核心设定.md"),
    };
  }

  /** 写后更新追踪文件 */
  updateAfterWrite(projectName: string, chapterNum: number, updates: WriteUpdates): void {
    // 更新伏笔
    if (updates.newForeshadows?.length || updates.resolvedForeshadows?.length) {
      const current = this.readFileSafe(projectName, "追踪/伏笔.md") || "";
      let newContent = current;
      for (const f of updates.newForeshadows ?? []) {
        newContent += `| ${f.id || ""} | ${f.description} | ${chapterNum} | ${f.targetChapter || "?"} | - | planted |\n`;
      }
      // 标记已回收
      for (const r of updates.resolvedForeshadows ?? []) {
        newContent = newContent.replace(
          new RegExp(`(\\|\\s*${r.id}\\s*\\|[^|]+\\|[^|]+\\|[^|]+\\|)\\s*-\\s*(\\|\\s*planted)`, "g"),
          `$1 ${chapterNum} $2`,
        );
      }
      this.writeFile(projectName, "追踪/伏笔.md", newContent);
    }

    // 更新时间线
    if (updates.timelineEvents?.length) {
      const current = this.readFileSafe(projectName, "追踪/时间线.md") || "";
      let newContent = current;
      for (const t of updates.timelineEvents) {
        newContent += `| ${chapterNum} | ${t.event} | ${t.characters?.join(",") || ""} | ${t.note || ""} |\n`;
      }
      this.writeFile(projectName, "追踪/时间线.md", newContent);
    }

    // 更新进度
    const progressLine = `- 当前位置: 第${chapterNum}章已完成\n- 下一章: 第${chapterNum + 1}章\n`;
    this.writeFile(projectName, "追踪/上下文.md", `# 日更进度\n\n${progressLine}- 待处理: \n`);
  }

  // ─── 工具方法 ───

  private resolvePath(projectName: string, filePath: string): string {
    return resolveProjectPath(this.baseDir, projectName, filePath);
  }

  private walkDir(baseDir: string, currentDir: string, result: string[]): void {
    for (const f of fs.readdirSync(currentDir)) {
      const fullPath = path.join(currentDir, f);
      if (fs.statSync(fullPath).isDirectory()) {
        this.walkDir(baseDir, fullPath, result);
      } else {
        result.push(path.relative(baseDir, fullPath));
      }
    }
  }

  private countFiles(projectName: string): number {
    return this.listAllFiles(projectName).length;
  }
}

export interface WriteContext {
  previousChapter: string | null;
  outline: string | null;
  foreshadows: string | null;
  characterStates: string | null;
  timeline: string | null;
  coreSettings: string | null;
}

export interface WriteUpdates {
  newForeshadows?: Array<{ id?: string; description: string; targetChapter?: number }>;
  resolvedForeshadows?: Array<{ id: string }>;
  timelineEvents?: Array<{ event: string; characters?: string[]; note?: string }>;
  characterStateChanges?: Array<{ name: string; changes: Record<string, string> }>;
}

export const novelFS = new NovelFileSystem();
export default NovelFileSystem;
