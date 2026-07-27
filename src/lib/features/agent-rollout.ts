/**
 * Agent 工作台灰度开关。
 *
 * NEXT_PUBLIC_AGENT_WORKBENCH_ROLLOUT_PERCENT:
 * - 0：完全关闭
 * - 1..99：按会话 id 稳定分桶
 * - 100 或未配置：完全开放
 *
 * 同一会话始终落在同一桶，不会刷新后忽隐忽现。这里只控制新 UI 暴露；
 * 后端仍保留工作区所有权校验，灰度开关不是安全边界。
 */
function stableBucket(subject: string): number {
  let hash = 2166136261;
  for (let index = 0; index < subject.length; index += 1) {
    hash ^= subject.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100;
}

function normalizeRolloutSubject(subject: string): string {
  const sessionMatch = subject.match(/\/studio\/session\/([^/]+)/);
  if (!sessionMatch?.[1]) return subject || "anonymous-workspace";

  try {
    return decodeURIComponent(sessionMatch[1]);
  } catch {
    return sessionMatch[1];
  }
}

export function agentWorkbenchRolloutEnabled(subject: string): boolean {
  const configured = Number(process.env.NEXT_PUBLIC_AGENT_WORKBENCH_ROLLOUT_PERCENT ?? "100");
  const percent = Number.isFinite(configured) ? Math.max(0, Math.min(100, Math.trunc(configured))) : 100;
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  return stableBucket(normalizeRolloutSubject(subject)) < percent;
}
