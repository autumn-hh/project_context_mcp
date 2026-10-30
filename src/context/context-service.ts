import type { SqliteDatabase } from "../storage/database.js";
import type { ProjectRecord } from "../projects/project-service.js";
import { getMemory, type MemoryRecord } from "../memory/memory-service.js";
import { listTasks, type TaskRecord } from "../tasks/task-service.js";
import { searchProject, type SearchHit } from "../search/search-service.js";
import type { UserMemoryRecord } from "../memory/user-memory-service.js";
import { taskOverlap, taskTokens as tokens } from "../shared/task-relevance.js";
import { recallMemories } from "../memory/recall-service.js";
import { relatedGraphMemories, type GraphMemoryRecall } from "../memory/graph-service.js";

type SupportingMemory = Pick<MemoryRecord, "id" | "sourceKind" | "sourceRef" | "confidence">;
type GraphRecallEvidence = Omit<GraphMemoryRecall, "memory">;

export interface ContextMemory extends MemoryRecord {
  /** Other active records with exactly the same title, type, conclusion, reason and scope. */
  supportingMemories?: SupportingMemory[];
  graphRecall?: GraphRecallEvidence;
}

export interface ContextSearchHit extends SearchHit {
  memoryType?: MemoryRecord["type"];
  scope?: string[];
  sourceKind?: string;
  confidence?: number;
  supportingMemories?: SupportingMemory[];
  graphRecall?: GraphRecallEvidence;
}

export interface ProjectContext {
  project: Pick<ProjectRecord, "id" | "name" | "rootPath" | "remoteUrl">;
  task: string;
  constraints: ContextMemory[];
  decisions: ContextMemory[];
  lessons: ContextMemory[];
  userMemories: UserMemoryRecord[];
  activeTasks: TaskRecord[];
  relevant: ContextSearchHit[];
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
  // Search code and knowledge independently so code hits cannot consume the
  // memory quota. Only indexed sources can establish a scope, never a memory itself.
  const recallSummaries = /task_[a-z0-9]+|(?:回顾|复盘|恢复|继续).{0,30}(?:任务|工作)|(?:review|recap|resume|continue)\s+(?:the\s+)?(?:task|work)/iu.test(task);
  const searched = searchProject(db, task, SEARCH_HIT_CANDIDATE_LIMIT, undefined, {
    excludeTaskSummaries: !recallSummaries,
  });
  const codeHits = searched.filter((hit) => hit.kind !== "memory");
  const accepts = (memory: MemoryRecord): boolean => memory.type === "task-summary"
    ? recallSummaries && summaryMatches(memory, task)
    : scopeMatches(memory, task, codeHits);
  const recalled = recallMemories(db, task, { includeTaskSummaries: recallSummaries, accepts });
  const memoryScores = new Map(recalled.map(({ memory, score }) => [memory.id, score]));
  // Retain the existing mixed search's fuzzy Latin matches as a fallback.
  for (const hit of searched.filter((item) => item.kind === "memory")) {
    if (!memoryScores.has(hit.id) && accepts(getMemory(db, hit.id))) memoryScores.set(hit.id, hit.score * 0.5);
  }
  const relevantMemoryIds = new Set(memoryScores.keys());
  for (const taskId of task.match(/task_[a-z0-9]+/giu) ?? []) {
    const ids = db.prepare(`
      SELECT id FROM memories WHERE status = 'active' AND type = 'task-summary' AND source_ref = ?
      ORDER BY updated_at DESC LIMIT 4
    `).all(`task:${taskId}`) as Array<{ id: string }>;
    for (const { id } of ids) {
      relevantMemoryIds.add(id);
      memoryScores.set(id, 1);
    }
  }
  const graphEvidence = new Map<string, GraphRecallEvidence>();
  const seeds = [...memoryScores.keys()].filter((id) => getMemory(db, id).type !== "task-summary").slice(0, 5);
  const graphMatches = relatedGraphMemories(db, seeds, 4, (memory) => (
    !relevantMemoryIds.has(memory.id) && accepts(memory)
  ));
  for (const { memory, fromMemoryId, viaNodeId, relation } of graphMatches) {
    relevantMemoryIds.add(memory.id);
    memoryScores.set(memory.id, (memoryScores.get(fromMemoryId) ?? 1) * 0.35);
    graphEvidence.set(memory.id, { fromMemoryId, viaNodeId, relation });
  }
  const memories: ContextMemory[] = memoryCandidates(db, relevantMemoryIds, recallSummaries).map((memory) => ({
    ...memory, ...(graphEvidence.has(memory.id) ? { graphRecall: graphEvidence.get(memory.id)! } : {}),
  }));
  const taskTokens = tokens(task);
  const rankMemory = (memory: MemoryRecord): number => {
    if (!accepts(memory)) return Number.NEGATIVE_INFINITY;
    if (memory.type === "task-summary") {
      return recallSummaries && summaryMatches(memory, task) ? 100 : Number.NEGATIVE_INFINITY;
    }
    return (memoryScores.get(memory.id) ?? 0) * 100 + (memory.scope.length ? 1 : 0)
      + taskOverlap(taskTokens, `${memory.title} ${memory.content} ${memory.scope.join(" ")}`);
  };
  const ranked = groupIdenticalMemories([...memories].filter(accepts).sort((a, b) => (
    rankMemory(b) - rankMemory(a) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)
  )));
  const staleCount = count(db, "SELECT COUNT(*) AS count FROM memories WHERE status IN ('stale', 'conflicted')");
  const failedIndexCount = count(db, "SELECT COUNT(*) AS count FROM index_runs WHERE status = 'failed'");
  const warnings: string[] = [];
  if (staleCount > 0) warnings.push(`${staleCount} memories are stale or conflicted and require review.`);
  if (staleCount > 0) {
    const review = recallMemories(db, task, {
      limit: 3, needsReview: true, includeTaskSummaries: recallSummaries, accepts,
    });
    if (review.length) warnings.push(`Task-related memories excluded pending review: ${
      review.map(({ memory }) => `${memory.id} (${memory.status})`).join(", ")
    }.`);
  }
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
    relevant: [],
    codeRelations: relatedCode(db, codeHits),
    warnings,
    budget: { requestedTokens: budgetTokens, usedTokens: 0, truncated: false },
  };
  const selectedIds = new Set([...context.constraints, ...context.decisions, ...context.lessons].map((item) => item.id));
  context.relevant = [
    ...ranked.filter((memory) => rankMemory(memory) > 0 && !selectedIds.has(memory.id)).map((memory): ContextSearchHit => ({
      kind: "memory", id: memory.id, title: memory.title, content: memory.content,
      source: memory.sourceRef, startLine: null, score: memoryScores.get(memory.id) ?? 0,
      status: memory.status, memoryType: memory.type, scope: memory.scope,
      sourceKind: memory.sourceKind, confidence: memory.confidence,
      ...(memory.supportingMemories ? { supportingMemories: memory.supportingMemories } : {}),
      ...(memory.graphRecall ? { graphRecall: memory.graphRecall } : {}),
    })),
    ...codeHits,
  ].sort((a, b) => b.score - a.score).slice(0, SEARCH_HIT_CANDIDATE_LIMIT);
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
  // Keep the representative's source intact; extra duplicate provenance is
  // optional under a tight budget, just like other omitted context records.
  for (const item of [...copy.constraints, ...copy.decisions, ...copy.lessons, ...copy.relevant]) {
    while (copy.budget.usedTokens > copy.budget.requestedTokens && item.supportingMemories?.length) {
      item.supportingMemories.pop();
      if (!item.supportingMemories.length) delete item.supportingMemories;
      copy.budget.usedTokens = estimateTokens(JSON.stringify(copy));
    }
  }
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
  const explicitPaths = normalizedTask.match(/(?:[a-z]:)?(?:[\p{L}\p{N}_@.$~+-]+\/)+[\p{L}\p{N}_@.$~+-]+/gu) ?? [];
  return memory.scope.some((scope) => {
    const normalizedScope = normalizeScopeText(scope);
    if (!normalizedScope) return false;
    // An explicit file/directory target takes precedence over fuzzy word matches
    // and incidental search hits. "src/storagex" is not inside "src/storage".
    if (normalizedScope.includes("/") && explicitPaths.length) {
      return explicitPaths.some((path) => pathMatchesScope(path, normalizedScope));
    }
    if (!normalizedScope.includes("/") && taskTokens.includes(normalizedScope)) return true;
    const scopeTokens = normalizedScope.split(/[\\/._-]+/u).filter((token) => (
      token.length >= 3 && !SCOPE_STOP_WORDS.has(token)
    ));
    if (scopeTokens.some((scopeToken) => taskTokens.some((taskToken) => (
      taskToken === scopeToken
      || taskToken.startsWith(scopeToken)
      || scopeToken.startsWith(taskToken)
    )))) return true;
    return relevant.some((hit) => {
      if (hit.kind === "memory" || !hit.source) return false;
      const source = normalizeScopeText(hit.source);
      return pathMatchesScope(source, normalizedScope);
    });
  });
}

function pathMatchesScope(path: string, scope: string): boolean {
  const source = path.replace(/^\.\//u, "").replace(/\/+$/u, "");
  const target = scope.replace(/^\.\//u, "").replace(/\/+$/u, "");
  if (!source || !target) return false;
  return source === target || source.startsWith(`${target}/`)
    || source.endsWith(`/${target}`) || source.includes(`/${target}/`)
    || target.endsWith(`/${source}`);
}

function groupIdenticalMemories(memories: ContextMemory[]): ContextMemory[] {
  const groups = new Map<string, ContextMemory>();
  for (const memory of memories) {
    // Deliberately exact: do not normalize case, punctuation, numbers, negation,
    // code whitespace or reasons. Different scopes and types remain distinct.
    // Task summaries describe separate executions and must not be consolidated.
    const key = memory.type === "task-summary" ? memory.id
      : JSON.stringify([memory.type, memory.title, memory.content, memory.reason, [...new Set(memory.scope)].sort()]);
    const existing = groups.get(key);
    if (!existing) groups.set(key, { ...memory });
    else {
      (existing.supportingMemories ??= []).push({
        id: memory.id, sourceKind: memory.sourceKind, sourceRef: memory.sourceRef, confidence: memory.confidence,
      });
    }
  }
  return [...groups.values()];
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
