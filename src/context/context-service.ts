import type { SqliteDatabase } from "../storage/database.js";
import type { ProjectRecord } from "../projects/project-service.js";
import { getMemory, listMemories, type MemoryRecord } from "../memory/memory-service.js";
import { listTasks, type TaskRecord } from "../tasks/task-service.js";
import { searchProject, type SearchHit } from "../search/search-service.js";
import type { UserMemoryRecord } from "../memory/user-memory-service.js";

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
  const relevant = searchProject(db, task, SEARCH_HIT_CANDIDATE_LIMIT);
  const relevantMemoryIds = new Set(relevant.filter((hit) => hit.kind === "memory").map((hit) => hit.id));
  const memories = memoryCandidates(db, relevantMemoryIds);
  const taskTokens = tokens(task);
  const rankMemory = (memory: MemoryRecord): number =>
    (relevantMemoryIds.has(memory.id) ? 100 : 0)
    + taskTokens.filter((token) => `${memory.title} ${memory.content} ${memory.scope.join(" ")}`.toLowerCase().includes(token)).length;
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
      (memory) => (memory.type === "lesson" || memory.type === "issue") && rankMemory(memory) > 0,
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
  copy.budget.usedTokens = estimateTokens(JSON.stringify(copy));
  if (copy.budget.usedTokens <= copy.budget.requestedTokens) return copy;
  copy.budget.truncated = true;
  for (const items of [
    copy.relevant, copy.codeRelations, copy.lessons, copy.decisions,
    copy.constraints, copy.userMemories, copy.activeTasks,
  ]) {
    while (copy.budget.usedTokens > copy.budget.requestedTokens && items.length > 1) {
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
  if (copy.budget.usedTokens > copy.budget.requestedTokens) {
    copy.relevant = [];
    copy.codeRelations = [];
    copy.lessons = [];
    copy.decisions = [];
    copy.constraints = [];
    copy.userMemories = [];
    copy.activeTasks = [];
    copy.warnings.push("Context details were removed to satisfy the requested token budget.");
    copy.budget.usedTokens = estimateTokens(JSON.stringify(copy));
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

function memoryCandidates(db: SqliteDatabase, relevantMemoryIds: Set<string>): MemoryRecord[] {
  const candidates = new Map<string, MemoryRecord>();
  for (const memoryId of relevantMemoryIds) {
    try {
      const memory = getMemory(db, memoryId);
      if (memory.status === "active") candidates.set(memoryId, memory);
    } catch {
      // A concurrent status update can remove a search hit before it is read.
    }
  }
  for (const memory of listMemories(db, "active", MEMORY_CANDIDATE_LIMIT)) {
    if (candidates.size >= MEMORY_CANDIDATE_LIMIT) break;
    candidates.set(memory.id, memory);
  }
  return [...candidates.values()];
}

function rankTasks(tasks: TaskRecord[], taskTokens: string[]): TaskRecord[] {
  const score = (task: TaskRecord): number => {
    const text = JSON.stringify(task).toLowerCase();
    return taskTokens.filter((token) => text.includes(token)).length;
  };
  return tasks.sort((a, b) => score(b) - score(a) || b.updatedAt.localeCompare(a.updatedAt));
}

function tokens(value: string): string[] {
  return value.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((token) => token.length >= 2);
}

function rankUserMemories(memories: UserMemoryRecord[], task: string): UserMemoryRecord[] {
  const taskTokens = tokens(task);
  const score = (memory: UserMemoryRecord): number => {
    const text = `${memory.title} ${memory.content} ${memory.scopeRef ?? ""}`.toLowerCase();
    const relevance = taskTokens.filter((token) => text.includes(token)).length;
    const scopeWeight = memory.scopeLevel === "user" ? 1 : 10;
    const constraintWeight = memory.type === "constraint" ? 5 : 0;
    return relevance * 100 + scopeWeight + constraintWeight;
  };
  return [...memories].sort((a, b) => score(b) - score(a));
}

function count(db: SqliteDatabase, sql: string): number {
  return (db.prepare(sql).get() as { count: number }).count;
}
