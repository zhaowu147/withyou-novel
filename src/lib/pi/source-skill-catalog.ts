import "server-only";

import { createHash } from "node:crypto";

const GITHUB_CATALOGS = ["openai/skills", "vercel-labs/skills"] as const;
const GITHUB_API = "https://api.github.com";
const MAX_RESULTS = 12;
const MAX_FILES = 20;
const MAX_RESOURCE_BYTES = 256 * 1024;
const ALLOWED_RESOURCE_EXTENSIONS = new Set([".md", ".txt", ".json", ".yaml", ".yml"]);

export interface SourceSkillCatalogItem {
  id: string;
  name: string;
  description: string;
  source: { type: "remote"; uri: string; publisher: string };
  catalog: "skills.sh" | "github-curated";
  catalogId?: string;
  installCount?: number;
  audit?: { status: "pass" | "warn" | "fail" | "unavailable"; summary: string };
}

export interface SourceSkillCatalogBundle extends SourceSkillCatalogItem {
  content: string;
  resources: Array<{ path: string; content: string }>;
  version?: string;
}

type FetchLike = typeof fetch;

function catalogToken(): string | null {
  return process.env.SKILLS_SH_API_TOKEN?.trim() || process.env.VERCEL_OIDC_TOKEN?.trim() || null;
}

function safeId(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const suffix = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8);
  return `${normalized.slice(0, 54).replace(/-+$/g, "") || "skill"}-${suffix}`;
}

function safeRelativePath(value: string): string | null {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) return null;
  const extension = normalized.slice(normalized.lastIndexOf(".")).toLowerCase();
  return ALLOWED_RESOURCE_EXTENSIONS.has(extension) ? normalized : null;
}

function metadata(content: string): { name?: string; description?: string; version?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator > 0) fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim().replace(/^["']|["']$/g, ""));
  }
  return { name: fields.get("name"), description: fields.get("description"), version: fields.get("version") };
}

async function json<T>(fetchImpl: FetchLike, url: string, headers: HeadersInit = {}): Promise<T> {
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Skill 目录请求失败（${response.status}）`);
  return (await response.json()) as T;
}

async function text(fetchImpl: FetchLike, url: string): Promise<string> {
  const response = await fetchImpl(url, { headers: { "User-Agent": "WithYou-Pi" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Skill 文件下载失败（${response.status}）`);
  const content = await response.text();
  if (!content.trim()) throw new Error("Skill 文件为空");
  return content;
}

interface SkillsShItem {
  id: string;
  slug: string;
  name: string;
  source: string;
  installs?: number;
  installUrl?: string | null;
  url?: string;
}

async function searchSkillsSh(query: string, limit: number, fetchImpl: FetchLike): Promise<SourceSkillCatalogItem[] | null> {
  const token = catalogToken();
  if (!token) return null;
  const url = `https://skills.sh/api/v1/skills/search?q=${encodeURIComponent(query)}&limit=${limit}`;
  const result = await json<{ data?: SkillsShItem[] }>(fetchImpl, url, { Authorization: `Bearer ${token}` });
  return (result.data ?? []).map((item) => ({
    id: safeId(`skills.sh/${item.id}`),
    name: item.name || item.slug,
    description: `skills.sh：${item.source}`,
    source: { type: "remote", uri: item.url || `https://skills.sh/${item.id}`, publisher: item.source },
    catalog: "skills.sh",
    catalogId: item.id,
    installCount: item.installs,
    audit: { status: "unavailable", summary: "目录审计未在检索阶段加载；安装前需由 Pi 明确说明" },
  }));
}

interface GithubTreeEntry { path: string; type: string }

async function githubTreePaths(repo: string, fetchImpl: FetchLike): Promise<string[]> {
  const tree = await json<{ tree?: GithubTreeEntry[] }>(
    fetchImpl,
    `${GITHUB_API}/repos/${repo}/git/trees/HEAD?recursive=1`,
    { "User-Agent": "WithYou-Pi" },
  );
  return (tree.tree ?? []).filter((entry) => entry.type === "blob").map((entry) => entry.path);
}

async function githubSkillPaths(repo: string, fetchImpl: FetchLike): Promise<string[]> {
  return (await githubTreePaths(repo, fetchImpl)).filter((entry) => /(^|\/)SKILL\.md$/i.test(entry));
}

function score(path: string, query: string): number {
  const tokens = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const haystack = path.toLocaleLowerCase().replaceAll(/[._/\\-]+/g, " ");
  return tokens.reduce((total, token) => total + (haystack.includes(token) ? 1 : 0), 0);
}

async function searchGithubCurated(query: string, limit: number, fetchImpl: FetchLike): Promise<SourceSkillCatalogItem[]> {
  const paths = (await Promise.all(GITHUB_CATALOGS.map(async (repo) => ({ repo, paths: await githubSkillPaths(repo, fetchImpl) })))).flatMap(
    ({ repo, paths }) => paths.map((skillPath) => ({ repo, skillPath })),
  );
  return paths
    .map(({ repo, skillPath }) => ({ repo, skillPath, score: score(skillPath, query) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.skillPath.localeCompare(b.skillPath))
    .slice(0, limit)
    .map(({ repo, skillPath }) => {
      const root = skillPath.slice(0, -"/SKILL.md".length);
      const slug = root.split("/").at(-1) || "skill";
      return {
        id: safeId(`github/${repo}/${root}`),
        name: slug.replaceAll(/[-_]/g, " "),
        description: `来自 ${repo} 的受限 GitHub 目录 Skill：${root}`,
        source: { type: "remote", uri: `https://github.com/${repo}/tree/HEAD/${root}`, publisher: repo },
        catalog: "github-curated",
        audit: { status: "unavailable", summary: "受限官方 GitHub 目录未提供可验证的目录审计结果" },
      };
    });
}

/** 搜索目录。优先使用配置了服务令牌的 skills.sh，未配置时回退到内置的官方 GitHub 目录。 */
export async function searchSourceSkillCatalog(queryInput: string, limitInput = 8, fetchImpl: FetchLike = fetch): Promise<SourceSkillCatalogItem[]> {
  const query = queryInput.trim();
  if (query.length < 2) throw new Error("Skill 搜索词至少需要 2 个字符");
  const limit = Math.max(1, Math.min(MAX_RESULTS, Math.floor(limitInput)));
  try {
    const remote = await searchSkillsSh(query, limit, fetchImpl);
    if (remote) return remote;
  } catch {
    // 服务目录短暂不可用时仍可通过内置官方 GitHub 来源发现 Skill。
  }
  return searchGithubCurated(query, limit, fetchImpl);
}

function parseGithubSource(uri: string): { repo: string; root: string } {
  const match = uri.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/tree\/HEAD\/(.+)$/);
  if (!match) throw new Error("该 Skill 来源不能通过受限 GitHub 下载器安装");
  return { repo: match[1], root: match[2] };
}

/** 下载当前目录项的指令与文档资源；脚本与二进制永不自动下载或执行。 */
export async function downloadSourceSkillCatalogItem(
  item: SourceSkillCatalogItem,
  fetchImpl: FetchLike = fetch,
): Promise<SourceSkillCatalogBundle> {
  if (item.catalog === "skills.sh") {
    const token = catalogToken();
    if (!token || !item.catalogId) throw new Error("skills.sh 目录项需要配置 SKILLS_SH_API_TOKEN 后才能下载");
    const detail = await json<{ files?: Array<{ path?: string; contents?: string }> }>(
      fetchImpl,
      `https://skills.sh/api/v1/skills/${item.catalogId}`,
      { Authorization: `Bearer ${token}` },
    );
    const skillFile = detail.files?.find((file) => file.path === "SKILL.md" && typeof file.contents === "string");
    if (!skillFile?.contents) throw new Error("目录项未提供可安装的 SKILL.md");
    const resources = (detail.files ?? [])
      .flatMap((file) => {
        const resourcePath = typeof file.path === "string" ? safeRelativePath(file.path) : null;
        return resourcePath && resourcePath !== "SKILL.md" && typeof file.contents === "string"
          ? [{ path: resourcePath, content: file.contents }]
          : [];
      })
      .filter((resource) => Buffer.byteLength(resource.content, "utf8") <= 64 * 1024)
      .slice(0, MAX_FILES);
    const parsed = metadata(skillFile.contents);
    return {
      ...item,
      name: parsed.name ?? item.name,
      description: parsed.description ?? item.description,
      version: parsed.version,
      content: skillFile.contents,
      resources,
    };
  }
  const { repo, root } = parseGithubSource(item.source.uri);
  if (!(GITHUB_CATALOGS as readonly string[]).includes(repo)) throw new Error("该来源不在允许下载的目录中");
  const skillPath = `${root}/SKILL.md`;
  const content = await text(fetchImpl, `https://raw.githubusercontent.com/${repo}/HEAD/${skillPath}`);
  const treePaths = await githubTreePaths(repo, fetchImpl);
  const prefix = `${root}/`;
  const resources: Array<{ path: string; content: string }> = [];
  let totalBytes = 0;
  for (const fullPath of treePaths.filter((candidate) => candidate.startsWith(prefix) && candidate !== skillPath)) {
    const relative = safeRelativePath(fullPath.slice(prefix.length));
    if (!relative || resources.length >= MAX_FILES) continue;
    const resource = await text(fetchImpl, `https://raw.githubusercontent.com/${repo}/HEAD/${fullPath}`);
    const bytes = Buffer.byteLength(resource, "utf8");
    if (bytes > 64 * 1024 || totalBytes + bytes > MAX_RESOURCE_BYTES) continue;
    resources.push({ path: relative, content: resource });
    totalBytes += bytes;
  }
  const parsed = metadata(content);
  return {
    ...item,
    name: parsed.name ?? item.name,
    description: parsed.description ?? item.description,
    version: parsed.version,
    content,
    resources,
  };
}

export const sourceSkillCatalogInternals = { safeId, safeRelativePath, score, metadata };
