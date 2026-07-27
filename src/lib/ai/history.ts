/**
 * AI 生成历史记录 — 客户端 localStorage 实现
 * 7 天自动清理 unsaved 记录
 * 若将来要换持久化后端，只改这一个文件即可迁移
 */

export interface HistoryEntry {
  id: string;
  toolType: string;
  toolName: string;
  variables: Record<string, string>;
  promptText: string;
  resultText: string;
  saved: boolean;
  createdAt: number;
}

const STORAGE_KEY = "withyou_history";
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

function load(): HistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function save(entries: HistoryEntry[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

/** 清理过期未保存记录 */
function cleanup(entries: HistoryEntry[]): HistoryEntry[] {
  const now = Date.now();
  return entries.filter((e) => e.saved || now - e.createdAt < SEVEN_DAYS);
}

export function addHistory(entry: Omit<HistoryEntry, "id" | "createdAt">): HistoryEntry {
  const entries = load();
  const full: HistoryEntry = {
    ...entry,
    id: crypto.randomUUID?.() || Date.now().toString(36),
    createdAt: Date.now(),
  };
  entries.unshift(full);
  save(cleanup(entries));
  return full;
}

export function getAllHistory(): HistoryEntry[] {
  return cleanup(load());
}

export function getHistoryByTool(toolType: string): HistoryEntry[] {
  return getAllHistory().filter((e) => e.toolType === toolType);
}

export function markSaved(id: string) {
  const entries = load();
  const target = entries.find((e) => e.id === id);
  if (target) target.saved = true;
  save(entries);
}

export function deleteHistory(id: string) {
  save(load().filter((e) => e.id !== id));
}

export function clearHistory() {
  save(load().filter((e) => e.saved));
}

export function clearAllHistory() {
  save([]);
}
