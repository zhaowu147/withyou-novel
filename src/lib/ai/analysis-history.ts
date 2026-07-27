/**
 * 拆书分析历史记录
 */

const STORAGE_KEY = "withyou-analysis-history";

export interface AnalysisHistoryEntry {
  id: string;
  fileName: string;
  selectedChapters: number[];
  presetName: string;
  customPrompt: string;
  extra: string;
  model?: string;
  temperature?: number;
  mode: "merge" | "split";
  result: string;
  wordCount: number;
  createdAt: number;
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function getAllHistory(): AnalysisHistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function addHistory(entry: Omit<AnalysisHistoryEntry, "id" | "createdAt">): AnalysisHistoryEntry {
  const history = getAllHistory();
  const newEntry: AnalysisHistoryEntry = {
    ...entry,
    id: generateId(),
    createdAt: Date.now(),
  };
  // 最新在前，最多保存50条
  history.unshift(newEntry);
  if (history.length > 50) history.pop();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  return newEntry;
}

export function deleteHistory(id: string): void {
  const history = getAllHistory().filter((h) => h.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
}

export function clearHistory(): void {
  localStorage.removeItem(STORAGE_KEY);
}
