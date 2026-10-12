import type { SqliteDatabase } from "../storage/database.js";
import type { ProjectRecord } from "../projects/project-service.js";
import { getMemory, type MemoryRecord } from "../memory/memory-service.js";
import { listTasks, type TaskRecord } from "../tasks/task-service.js";
import { searchProject, type SearchHit } from "../search/search-service.js";
import type { UserMemoryRecord } from "../memory/user-memory-service.js";
import { taskOverlap, taskTokens as tokens } from "../shared/task-relevance.js";

export interface ProjectContext {
  project: Pick<ProjectRecord, "id" | "name" | "rootPath" | "remoteUrl">;
  task: string;
  constraints: MemoryRecord[];
  decisions: MemoryRecord[];
  lessons: MemoryRecord[];
  userMemories: UserMemoryRecord[];
  activeTasks: TaskRecord[];
  relevant: SearchHit[];
  codeRelations: Array<{
    from: string;
    to: string;
    type: string;
    source: string;
    line: number;
  }>;
  warnings: string[];
  budget: { requestedTokens: number; usedTokens: number; truncated: boolean };
}

// Keep implicit MCP/prompt calls bounded while leaving room for task-relevant evidence.
// Callers can still request a larger budget explicitly when they need a full snapshot.
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 3_000;

const MEMORY_CANDIDATE_LIMIT = 64;
const SEARCH_HIT_CANDIDATE_LIMIT = 24;
const TASK_CANDIDATE_LIMIT = 20;
const TASK_CONTEXT_LIMIT = 10;
const CODE_RELATION_SYMBOL_LIMIT = 12;
const CODE_RELATION_LIMIT = 40;

export function buildProjectContext(
  db: SqliteDatabase,
  project: ProjectRecord,
  task: string,
  budgetTokens = DEFAULT_CONTEXT_BUDGET_TOKENS,
  userMemories: UserMemoryRecord[] = [],
): ProjectContext {
  // Search first so older but task-relevant memories are not hidden by a recent,
  // unrelated history page. The bounded recent list only fills project-wide gaps.
  const recallSummaries = /task_[a-z0-9]+|(?:回顾|复盘|恢复|继续).{0,30}(?:任务|工作)|(?:review|recap|resume|continue)\s+(?:the\s+)?(?:task|work)/iu.test(task);
  const relevant = searchProject(db, task, SEARCH_HIT_CANDIDATE_LIMIT, undefined, {
    excludeTaskSummaries: !recallSummaries,
  }).filter((hit) => {
    if (hit.kind !== "memory" || !recallSummaries) return true;
    const memory = getMemory(db, hit.id);
    return memory.type !== "task-summary" || summaryMatches(memory, task);
  });
  const relevantMemoryIds = new Set(relevant.filter((hit) => hit.kind === "memory").map((hit) => hit.id));
  for (const taskId of task.match(/task_[a-z0-9]+/giu) ?? []) {
    const ids = db.prepare(`
      SELECT id FROM memories WHERE status = 'active' AND type = 'task-summary' AND source_ref = ?
      ORDER BY updated_at DESC LIMIT 4
    `).all(`task:${taskId}`) as Array<{ id: string }>;
    for (const { id } of ids) relevantMemoryIds.add(id);
  }
  const memories = memoryCandidates(db, relevantMemoryIds, recallSummaries);
  const taskTokens = tokens(task);
  const rankMemory = (memory: MemoryRecord): number => {
    if (memory.type === "task-summary") {
      return recallSummaries && summaryMatches(memory, task) ? 100 : Number.NEGATIVE_INFINITY;
    }
    if (!scopeMatches(memory, task, relevant)) return Number.NEGATIVE_INFINITY;
    return (relevantMemoryIds.has(memory.id) ? 100 : 0)
      + taskOverlap(taskTokens, `${memory.title} ${memory.content} ${memory.scope.join(" ")}`);
  };
  const ranked = [...memories].sort((a, b) => rankMemory(b) - rankMemory(a));
  const staleCount = count(db, "SELECT COUNT(*) AS count FROM memories WHERE status IN ('stale', 'conflicted')");
  const failedIndexCount = count(db, "SELECT COUNT(*) AS count FROM index_runs WHERE status = 'failed'");
  const warnings: string[] = [];
  if (staleCount > 0) warnings.push(`${staleCount} memories are stale or conflicted and require review.`);
  if (failedIndexCount > 0) warnings.push(`${failedIndexCount} index runs failed; project search may be incomplete.`);

  const context: ProjectContext = {
    project: { id: project.id, name: project.name, rootPath: project.rootPath, remoteUrl: project.remoteUrl },
    task,
    constraints: ranked.filter((memory) => (
      memory.type === "constraint" && (memory.scope.length === 0 || rankMemory(memory) > 0)
    )).slice(0, 20),
    decisions: ranked.filter((memory) => memory.type === "decision" && rankMemory(memory) > 0).slice(0, 15),
    lessons: ranked.filter(
      (memory) => (memory.type === "lesson" || memory.type === "issue"
        || (memory.type === "task-summary" && recallSummaries && summaryMatches(memory, task)))
        && rankMemory(memory) > 0,
    ).slice(0, 10),
    userMemories: rankUserMemories(userMemories, task).slice(0, 50),
    activeTasks: rankTasks(listTasks(db, "in_progress", TASK_CANDIDATE_LIMIT), taskTokens).slice(0, TASK_CONTEXT_LIMIT),
    relevant,
    codeRelations: relatedCode(db, relevant),
    warnings,
    budget: { requestedTokens: budgetTokens, usedTokens: 0, truncated: false },
  };
  return fitBudget(context);
}

function fitBudget(context: ProjectContext): ProjectContext {
  const copy: ProjectContext = structuredClone(context);
  // Personal rules must not consume the budget reserved for project knowledge.
  const userBudget = Math.floor(copy.budget.requestedTokens * 0.2);
  const selectedUserMemories: UserMemoryRecord[] = [];
  for (const memory of copy.userMemories) {
    if (estimateTokens(JSON.stringify([...selectedUserMemories, memory])) <= userBudget) {
      selectedUserMemories.push(memory);
    } else {
      copy.budget.truncated = true;
    }
  }
  copy.userMemories = selectedUserMemories;
  copy.budget.usedTokens = estimateTokens(JSON.stringify(copy));
  if (copy.budget.usedTokens <= copy.budget.requestedTokens) return copy;
  copy.budget.truncated = true;
  const groups = [
    { items: copy.activeTasks, reserve: 0 },
    { items: copy.userMemories, reserve: 0 },
    { items: copy.lessons, reserve: 1 },
    { items: copy.relevant, reserve: 2 },
    { items: copy.codeRelations, reserve: 2 },
    { items: copy.decisions, reserve: 2 },
    { items: copy.constraints, reserve: 2 },
  ];
  for (const { items, reserve } of groups) {
    while (copy.budget.usedTokens > copy.budget.requestedTokens && items.length > reserve) {
      items.pop();
      copy.budget.usedTokens = estimateTokens(JSON.stringify(copy));
    }
  }
  while (copy.budget.usedTokens > copy.budget.requestedTokens) {
    const target = longestTruncatableString(copy);
    if (!target || target.value.length <= 32) break;
    target.set(`${target.value.slice(0, Math.max(16, Math.floor(target.value.length * 0.7)))}...`);
    copy.budget.usedTokens = estimateTokens(JSON.stringify(copy));
  }
  // Tiny explicit budgets can be smaller than record metadata alone. Keep project
  // decisions/constraints until other categories have been exhausted.
  for (const { items } of groups) {
    while (copy.budget.usedTokens > copy.budget.requestedTokens && items.length) {
      items.pop();
      copy.budget.usedTokens = estimateTokens(JSON.stringify(copy));
    }
  }
  return copy;
}

function estimateTokens(value: string): number {
  let cjk = 0;
  for (const character of value) {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(character)) cjk += 1;
  }
  return Math.ceil(cjk + (value.length - cjk) / 4);
}

function longestTruncatableString(context: ProjectContext): {
  value: string;
  set: (value: string) => void;
} | null {
  const candidates: Array<{ value: string; set: (value: string) => void }> = [];
  for (const hit of context.relevant) {
    candidates.push({ value: hit.content, set: (value) => { hit.content = value; } });
  }
  for (const memory of [...context.constraints, ...context.decisions, ...context.lessons]) {
    candidates.push({ value: memory.content, set: (value) => { memory.content = value; } });
    if (memory.reason) candidates.push({ value: memory.reason, set: (value) => { memory.reason = value; } });
  }
  for (const memory of context.userMemories) {
    candidates.push({ value: memory.content, set: (value) => { memory.content = value; } });
    if (memory.reason) candidates.push({ value: memory.reason, set: (value) => { memory.reason = value; } });
  }
  for (const task of context.activeTasks) {
    candidates.push({ value: task.goal, set: (value) => { task.goal = value; } });
    if (task.checkpoint.summary) {
      candidates.push({ value: task.checkpoint.summary, set: (value) => { task.checkpoint.summary = value; } });
    }
    for (const values of [
      task.checkpoint.completed, task.checkpoint.next, task.checkpoint.changedFiles,
      task.checkpoint.blockers, task.checkpoint.risks,
    ]) {
      values.forEach((value, index) => candidates.push({ value, set: (next) => { values[index] = next; } }));
    }
  }
  return candidates.sort((a, b) => b.value.length - a.value.length)[0] ?? null;
}

function relatedCode(db: SqliteDatabase, hits: SearchHit[]): ProjectContext["codeRelations"] {
  const symbolIds = hits.filter((hit) => hit.kind === "symbol").map((hit) => hit.id).slice(0, CODE_RELATION_SYMBOL_LIMIT);
  if (symbolIds.length === 0) return [];
  const placeholders = symbolIds.map(() => "?").join(", ");
  return db.prepare(`
    SELECT from_name, to_name, relation_type, source_path, start_line
    FROM relations WHERE from_symbol_id IN (${placeholders})
    ORDER BY source_path, start_line LIMIT ${CODE_RELATION_LIMIT}
  `).all(...symbolIds).map((row) => {
    const item = row as {
      from_name: string; to_name: string; relation_type: string; source_path: string; start_line: number;
    };
    return {
      from: item.from_name, to: item.to_name, type: item.relation_type,
      source: item.source_path, line: item.start_line,
    };
  });
}

function memoryCandidates(db: SqliteDatabase, relevantMemoryIds: Set<string>, recallSummaries: boolean): MemoryRecord[] {
  const candidates = new Map<string, MemoryRecord>();
  for (const memoryId of relevantMemoryIds) {
    try {
      const memory = getMemory(db, memoryId);
      if (memory.status === "active" && (memory.type !== "task-summary" || recallSummaries)) {
        candidates.set(memoryId, memory);
      }
    } catch {
      // A concurrent status update can remove a search hit before it is read.
    }
  }
  // Reserve candidates by type before LIMIT so recent execution summaries cannot
  // hide older project-wide decisions or constraints. Search fills relevant gaps.
  for (const [types, limit] of [
    [["constraint"], 16], [["decision"], 16], [["lesson", "issue"], 8],
  ] as const) {
    const ids = db.prepare(`
      SELECT id FROM memories WHERE status = 'active'
        AND type IN (${types.map(() => "?").join(", ")})
      ORDER BY updated_at DESC, id LIMIT ?
    `).all(...types, limit) as Array<{ id: string }>;
    for (const { id } of ids) {
      if (candidates.size >= MEMORY_CANDIDATE_LIMIT) break;
      candidates.set(id, getMemory(db, id));
    }
  }
  return [...candidates.values()];
}

function scopeMatches(memory: MemoryRecord, task: string, relevant: SearchHit[]): boolean {
  if (memory.scope.length === 0) return true;
  const normalizedTask = normalizeScopeText(task);
  const taskTokens = tokens(task);
  return memory.scope.some((scope) => {
    const normalizedScope = normalizeScopeText(scope);
    if (!normalizedScope) return false;
    if (normalizedTask.includes(normalizedScope)) return true;
    const scopeTokens = normalizedScope.split(/[\\/._-]+/u).filter((token) => (
      token.length >= 3 && !SCOPE_STOP_WORDS.has(token)
    ));
    if (scopeTokens.some((scopeToken) => taskTokens.some((taskToken) => (
      taskToken === scopeToken
      || taskToken.startsWith(scopeToken)
      || scopeToken.startsWith(taskToken)
    )))) return true;
    return relevant.some((hit) => {
      if (!hit.source) return false;
      const source = normalizeScopeText(hit.source);
      return source === normalizedScope
        || source.endsWith(`/${normalizedScope}`)
        || normalizedScope.endsWith(`/${source}`);
    });
  });
}

function normalizeScopeText(value: string): string {
  return value.normalize("NFKC").replaceAll("\\", "/").toLowerCase().trim();
}

const SCOPE_STOP_WORDS = new Set([
  "src", "lib", "app", "test", "tests", "docs", "dist", "build",
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
]);

function rankTasks(tasks: TaskRecord[], taskTokens: string[]): TaskRecord[] {
  const score = (task: TaskRecord): number => {
    const text = JSON.stringify(task).toLowerCase();
    return taskTokens.filter((token) => text.includes(token)).length;
  };
  return tasks.sort((a, b) => score(b) - score(a) || b.updatedAt.localeCompare(a.updatedAt));
}

function summaryMatches(memory: MemoryRecord, task: string): boolean {
  const explicitIds = task.match(/task_[a-z0-9]+/giu) ?? [];
  if (explicitIds.length) return explicitIds.some((id) => memory.sourceRef === `task:${id}`);
  const title = memory.title.replace(/^Review task-summary from task:\s*/iu, "").toLowerCase();
  if (title.length >= 12 && task.toLowerCase().includes(title)) return true;
  const text = `${memory.title} ${memory.content}`.toLowerCase();
  return taskOverlap(tokens(task), text) >= 2;
}

function rankUserMemories(memories: UserMemoryRecord[], task: string): UserMemoryRecord[] {
  const taskTokens = tokens(task);
  const score = (memory: UserMemoryRecord): number => {
    const text = `${memory.title} ${memory.content} ${memory.scopeRef ?? ""}`.toLowerCase();
    const relevance = taskOverlap(taskTokens, text);
    const scopeWeight = memory.scopeLevel === "user" ? 1 : 10;
    const constraintWeight = memory.type === "constraint" ? 5 : 0;
    return relevance * 100 + scopeWeight + constraintWeight;
  };
  return memories.filter((memory) => {
    const text = `${memory.title} ${memory.content} ${memory.scopeRef ?? ""}`.normalize("NFKC").toLowerCase();
    return memory.status === "active" && memory.type !== "task-summary"
      && taskOverlap(taskTokens, text) > 0;
  }).sort((a, b) => score(b) - score(a));
}

function count(db: SqliteDatabase, sql: string): number {
  return (db.prepare(sql).get() as { count: number }).count;
}
