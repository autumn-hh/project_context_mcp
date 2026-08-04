import type { SqliteDatabase } from "../storage/database.js";
import type { VersionControlSnapshot } from "../vcs/vcs-service.js";
import { containsLikelySecret } from "../indexing/file-policy.js";
import { createId, nowIso, sha256 } from "../shared/ids.js";
import { ProjectContextError } from "../shared/errors.js";
import { remember, type MemoryRecord, memoryTypeSchema } from "./memory-service.js";
import type { TaskRecord } from "../tasks/task-service.js";

export interface MemoryCandidate {
  id: string;
  type: "decision" | "constraint" | "lesson" | "issue" | "task-summary" | "assumption";
  title: string;
  content: string;
  reason: string | null;
  confidence: number;
  scope: string[];
  sourceKind: string;
  sourceRef: string | null;
  evidence: Record<string, unknown>;
  fingerprint: string;
  status: "pending" | "accepted" | "rejected" | "superseded";
  createdAt: string;
  updatedAt: string;
}

interface CandidateRow {
  id: string; type: MemoryCandidate["type"]; title: string; content: string; reason: string | null;
  confidence: number; scope_json: string; source_kind: string; source_ref: string | null;
  evidence_json: string; fingerprint: string; status: MemoryCandidate["status"];
  created_at: string; updated_at: string;
}

export interface IndexedSourceChange {
  path: string;
  previousHash: string | null;
  currentHash: string;
  content: string;
}

export function generateVersionControlCandidates(
  db: SqliteDatabase,
  snapshot: VersionControlSnapshot,
): MemoryCandidate[] {
  if (!snapshot.available || !snapshot.diff) return [];
  const additions = addedLinesByFile(snapshot.diff);
  const created: MemoryCandidate[] = [];
  for (const [path, lines] of additions) {
    if (!isKnowledgeSource(path)) continue;
    const relevantLines = lines.filter(isDurableKnowledgeLine).slice(0, 8);
    const content = relevantLines.join("\n").trim().slice(0, 1_200);
    if (!content || containsLikelySecret(content)) continue;
    const candidate = documentCandidate({
      path,
      content,
      sourceKind: snapshot.kind!,
      sourceRef: snapshot.revision ? `${snapshot.revision}:${path}` : path,
      reason: `Generated from added lines in the current ${snapshot.kind} diff; review before accepting.`,
      confidence: 0.55,
      evidence: { path, diffHash: snapshot.diffHash, changeCount: lines.length },
    });
    if (insertCandidate(db, candidate, path)) created.push(candidate);
  }
  return created;
}

export function generateFileCandidates(
  db: SqliteDatabase,
  changes: IndexedSourceChange[],
): MemoryCandidate[] {
  const created: MemoryCandidate[] = [];
  for (const change of changes) {
    if (!isKnowledgeSource(change.path)) continue;
    const lines = change.content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const content = lines.filter(isDurableKnowledgeLine).slice(0, 8).join("\n").trim().slice(0, 1_200);
    if (!content || containsLikelySecret(content)) continue;
    const candidate = documentCandidate({
      path: change.path,
      content,
      sourceKind: "file",
      sourceRef: change.path,
      reason: "Generated from an indexed knowledge-document change; review before accepting.",
      confidence: change.previousHash ? 0.6 : 0.5,
      evidence: {
        path: change.path,
        previousHash: change.previousHash,
        currentHash: change.currentHash,
        changeKind: change.previousHash ? "updated" : "added",
      },
    });
    if (insertCandidate(db, candidate, change.path)) created.push(candidate);
  }
  return created;
}

export function generateTaskCandidates(db: SqliteDatabase, task: TaskRecord): MemoryCandidate[] {
  const sourceRef = `task:${task.id}`;
  const existing = db.prepare("SELECT 1 FROM memory_candidates WHERE source_ref = ? LIMIT 1").get(sourceRef);
  if (existing) return [];

  const inputs: Array<{ type: MemoryCandidate["type"]; content: string; field: string; confidence: number }> = [];
  if (task.checkpoint.summary?.trim()) {
    inputs.push({ type: "task-summary", content: task.checkpoint.summary, field: "summary", confidence: 0.75 });
  }
  const firstRisk = task.checkpoint.risks.find((risk) => risk.trim());
  if (firstRisk) {
    inputs.push({ type: "issue", content: firstRisk, field: "risks", confidence: 0.7 });
  }
  const firstDurableCompleted = task.checkpoint.completed.find(isDurableKnowledgeLine);
  if (firstDurableCompleted) {
    inputs.push({
      type: inferType(firstDurableCompleted), content: firstDurableCompleted, field: "completed", confidence: 0.7,
    });
  }

  const created: MemoryCandidate[] = [];
  const taskLabel = task.goal.trim().replace(/\s+/g, " ").slice(0, 80);
  for (const input of inputs) {
    const content = input.content.trim().slice(0, 1_200);
    if (!content || containsLikelySecret(content)) continue;
    const timestamp = nowIso();
    const candidate: MemoryCandidate = {
      id: createId("cand"),
      type: input.type,
      title: `Review ${input.type} from task: ${taskLabel}`,
      content,
      reason: "Generated from a completed task checkpoint; review before accepting.",
      confidence: input.confidence,
      scope: task.checkpoint.changedFiles.slice(0, 8),
      sourceKind: "tool",
      sourceRef,
      evidence: { taskId: task.id, goal: task.goal, checkpointField: input.field },
      fingerprint: sha256(`task:${task.id}:${input.type}:${normalizeCandidate(content)}`),
      status: "pending",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (insertCandidate(db, candidate)) {
      created.push(candidate);
      break;
    }
  }
  return created;
}

export function listCandidates(db: SqliteDatabase, status = "pending", limit = 50): MemoryCandidate[] {
  return (db.prepare("SELECT * FROM memory_candidates WHERE status = ? ORDER BY created_at DESC LIMIT ?")
    .all(status, limit) as CandidateRow[]).map(mapCandidate);
}

export function acceptCandidate(db: SqliteDatabase, candidateId: string): MemoryRecord {
  return db.transaction(() => {
    const candidate = getPendingCandidate(db, candidateId);
    const memory = remember(db, {
      type: memoryTypeSchema.parse(candidate.type),
      title: candidate.title,
      content: candidate.content,
      status: "active",
      confidence: candidate.confidence,
      scope: candidate.scope,
      sourceKind: candidate.sourceKind,
      ...(candidate.reason ? { reason: candidate.reason } : {}),
      ...(candidate.sourceRef ? { sourceRef: candidate.sourceRef } : {}),
    });
    db.prepare("UPDATE memory_candidates SET status = 'accepted', updated_at = ? WHERE id = ?")
      .run(nowIso(), candidateId);
    return memory;
  })();
}

export function rejectCandidate(db: SqliteDatabase, candidateId: string): MemoryCandidate {
  const row = db.prepare("SELECT * FROM memory_candidates WHERE id = ?").get(candidateId) as CandidateRow | undefined;
  if (row?.status === "rejected") return mapCandidate(row);
  if (!row || row.status !== "pending") {
    throw new ProjectContextError("CANDIDATE_NOT_FOUND", `Unknown pending memory candidate: ${candidateId}`);
  }
  db.prepare("UPDATE memory_candidates SET status = 'rejected', updated_at = ? WHERE id = ?")
    .run(nowIso(), candidateId);
  return mapCandidate(db.prepare("SELECT * FROM memory_candidates WHERE id = ?").get(candidateId) as CandidateRow);
}

function getPendingCandidate(db: SqliteDatabase, id: string): MemoryCandidate {
  const row = db.prepare("SELECT * FROM memory_candidates WHERE id = ? AND status = 'pending'").get(id) as CandidateRow | undefined;
  if (!row) throw new ProjectContextError("CANDIDATE_NOT_FOUND", `Unknown pending memory candidate: ${id}`);
  return mapCandidate(row);
}

function addedLinesByFile(diff: string): Map<string, string[]> {
  const files = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      const headerPath = line.slice(4).split("\t", 1)[0]!.trim();
      current = headerPath === "/dev/null" ? null : headerPath.replace(/^b\//, "");
      if (!current) continue;
      if (!files.has(current)) files.set(current, []);
    } else if (current && line.startsWith("+") && !line.startsWith("+++")) {
      const value = line.slice(1).trim();
      if (value && !value.startsWith("//") && !value.startsWith("*")) files.get(current)!.push(value);
    }
  }
  return files;
}

function documentCandidate(input: {
  path: string;
  content: string;
  sourceKind: "git" | "hg" | "svn" | "file";
  sourceRef: string;
  reason: string;
  confidence: number;
  evidence: Record<string, unknown>;
}): MemoryCandidate {
  const type = inferType(input.content);
  const timestamp = nowIso();
  return {
    id: createId("cand"),
    type,
    title: `Review ${type} candidate from ${input.path}`,
    content: input.content,
    reason: input.reason,
    confidence: input.confidence,
    scope: [input.path.split("/")[0] ?? input.path],
    sourceKind: input.sourceKind,
    sourceRef: input.sourceRef,
    evidence: input.evidence,
    fingerprint: sha256(`${input.path}:${type}:${normalizeCandidate(input.content)}`),
    status: "pending",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function insertCandidate(db: SqliteDatabase, candidate: MemoryCandidate, documentPath?: string): boolean {
  const result = db.prepare(`
    INSERT OR IGNORE INTO memory_candidates (
      id, type, title, content, reason, confidence, scope_json, source_kind, source_ref,
      evidence_json, fingerprint, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidate.id, candidate.type, candidate.title, candidate.content, candidate.reason,
    candidate.confidence, JSON.stringify(candidate.scope), candidate.sourceKind, candidate.sourceRef,
    JSON.stringify(candidate.evidence), candidate.fingerprint, candidate.status,
    candidate.createdAt, candidate.updatedAt,
  );
  if (result.changes === 0) return false;
  if (documentPath) {
    db.prepare(`
      UPDATE memory_candidates SET status = 'superseded', updated_at = ?
      WHERE status = 'pending' AND id <> ?
        AND (source_ref = ? OR source_ref LIKE ?)
    `).run(candidate.updatedAt, candidate.id, documentPath, `%:${documentPath}`);
  }
  return true;
}

function inferType(content: string): MemoryCandidate["type"] {
  const lowered = content.toLowerCase();
  if (/\b(must|shall|required|constraint)\b|不得|必须/u.test(lowered)) return "constraint";
  if (/\b(decision|decided|choose|chosen)\b|选择|决定/u.test(lowered)) return "decision";
  if (/\b(fix|bug|issue|error)\b|问题|错误/u.test(lowered)) return "issue";
  if (/\b(lesson|learned|avoid)\b|经验|教训/u.test(lowered)) return "lesson";
  return "task-summary";
}

function isKnowledgeSource(path: string): boolean {
  return /(?:^|\/)(?:readme|changelog|adr|decision|architecture|docs?)(?:[\/._-]|$)/i.test(path)
    || /\.(?:md|mdx|rst|txt)$/i.test(path);
}

function isDurableKnowledgeLine(line: string): boolean {
  const value = line.trim().replace(/^[-*+]\s+/, "");
  if (!value || /^(?:#{1,6}\s|```|~~~|--|(?:npm|npx|node|git)\s)/i.test(value)) return false;
  const minimumLength = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value)
    ? 8
    : 20;
  if (value.length < minimumLength) return false;
  return /\b(?:decision|decided|must|shall|required|constraint|lesson|learned|issue|risk|architecture)\b|决定|选择|必须|不得|约束|经验|教训|问题|风险/iu
    .test(value);
}

function normalizeCandidate(content: string): string {
  return content.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function mapCandidate(row: CandidateRow): MemoryCandidate {
  return {
    id: row.id, type: row.type, title: row.title, content: row.content, reason: row.reason,
    confidence: row.confidence, scope: JSON.parse(row.scope_json) as string[],
    sourceKind: row.source_kind, sourceRef: row.source_ref,
    evidence: JSON.parse(row.evidence_json) as Record<string, unknown>,
    fingerprint: row.fingerprint, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
