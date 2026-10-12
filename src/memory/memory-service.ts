import { z } from "zod/v4";
import type { SqliteDatabase } from "../storage/database.js";
import { createId, nowIso, sha256 } from "../shared/ids.js";
import { ProjectContextError } from "../shared/errors.js";
import { containsLikelySecret } from "../indexing/file-policy.js";
import { replaceItemNgrams } from "../search/ngram-index.js";

export const memoryTypeSchema = z.enum([
  "fact", "decision", "constraint", "preference", "lesson", "issue", "assumption", "task-summary",
]);
export const memoryStatusSchema = z.enum([
  "candidate", "active", "superseded", "stale", "conflicted", "rejected", "deleted",
]);

export interface MemoryRecord {
  id: string;
  type: z.infer<typeof memoryTypeSchema>;
  title: string;
  content: string;
  reason: string | null;
  status: z.infer<typeof memoryStatusSchema>;
  confidence: number;
  scope: string[];
  sourceKind: string;
  sourceRef: string | null;
  supersedesId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MemoryRow {
  id: string; type: string; title: string; content: string; reason: string | null; status: string;
  confidence: number; scope_json: string; source_kind: string; source_ref: string | null;
  supersedes_id: string | null; created_at: string; updated_at: string;
}

export function remember(db: SqliteDatabase, input: {
  type: z.infer<typeof memoryTypeSchema>;
  title: string;
  content: string;
  reason?: string;
  status?: z.infer<typeof memoryStatusSchema>;
  confidence?: number;
  scope?: string[];
  sourceKind: string;
  sourceRef?: string;
  supersedesId?: string;
}): MemoryRecord {
  if (input.supersedesId) ensureMemory(db, input.supersedesId);
  const sourceBinding = resolveSourceBinding(db, input.sourceKind, input.sourceRef);
  const timestamp = nowIso();
  const memory: MemoryRecord = {
    id: createId("mem"),
    type: input.type,
    title: input.title.trim(),
    content: input.content.trim(),
    reason: input.reason?.trim() || null,
    status: input.status ?? "active",
    confidence: input.confidence ?? (input.sourceKind === "inference" ? 0.5 : 0.9),
    scope: input.scope ?? [],
    sourceKind: input.sourceKind,
    sourceRef: input.sourceRef?.trim() || null,
    supersedesId: input.supersedesId ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  if (!memory.title || !memory.content) {
    throw new ProjectContextError("INVALID_MEMORY", "Memory title and content are required.");
  }
  if (containsLikelySecret(`${memory.title}\n${memory.content}\n${memory.reason ?? ""}`)) {
    throw new ProjectContextError(
      "SENSITIVE_MEMORY_REJECTED",
      "Memory appears to contain a credential or private key and was not stored.",
    );
  }
  const transaction = db.transaction(() => {
    if (memory.supersedesId) {
      db.prepare("UPDATE memories SET status = 'superseded', updated_at = ? WHERE id = ?")
        .run(timestamp, memory.supersedesId);
    }
    db.prepare(`
      INSERT INTO memories (
        id, type, title, content, reason, status, confidence, scope_json,
        source_kind, source_ref, supersedes_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      memory.id, memory.type, memory.title, memory.content, memory.reason, memory.status,
      memory.confidence, JSON.stringify(memory.scope), memory.sourceKind, memory.sourceRef,
      memory.supersedesId, memory.createdAt, memory.updatedAt,
    );
    db.prepare("INSERT INTO memories_fts (memory_id, title, content, reason) VALUES (?, ?, ?, ?)")
      .run(memory.id, memory.title, memory.content, memory.reason ?? "");
    replaceItemNgrams(db, "memory", memory.id, `${memory.title}\n${memory.content}\n${memory.reason ?? ""}`);
    db.prepare(`
      INSERT INTO memory_sources (
        id, memory_id, source_kind, source_ref, source_id, source_hash,
        start_line, end_line, git_commit, created_at, source_excerpt, source_excerpt_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      createId("msrc"), memory.id, memory.sourceKind, memory.sourceRef,
      sourceBinding.sourceId, sourceBinding.sourceHash, sourceBinding.startLine,
      sourceBinding.endLine, sourceBinding.gitCommit, timestamp,
      sourceBinding.sourceExcerpt, sourceBinding.sourceExcerptHash,
    );
  });
  transaction();
  return memory;
}

export function detectMemoryDrift(db: SqliteDatabase): string[] {
  const rows = db.prepare(`
    SELECT m.id, ms.id AS binding_id, ms.source_hash, ms.source_excerpt,
           ms.source_excerpt_hash, s.content_hash, s.path
    FROM memories m
    JOIN memory_sources ms ON ms.memory_id = m.id
    LEFT JOIN sources s ON s.id = ms.source_id
    WHERE m.status = 'active'
      AND ms.source_kind = 'file'
      AND (ms.source_id IS NULL OR s.id IS NULL OR ms.source_hash <> s.content_hash)
  `).all() as Array<{
    id: string;
    binding_id: string;
    source_hash: string | null;
    source_excerpt: string | null;
    source_excerpt_hash: string | null;
    content_hash: string | null;
    path: string | null;
  }>;
  if (rows.length === 0) return [];
  const update = db.prepare("UPDATE memories SET status = 'stale', updated_at = ? WHERE id = ?");
  const refresh = db.prepare(`
    UPDATE memory_sources
    SET source_hash = ?, start_line = ?, end_line = ?
    WHERE id = ?
  `);
  const timestamp = nowIso();
  const stale = new Set<string>();
  db.transaction(() => {
    for (const row of rows) {
      if (!row.path || !row.content_hash || !row.source_excerpt || !row.source_excerpt_hash) {
        stale.add(row.id);
        continue;
      }
      const currentContent = sourceContent(db, row.path);
      const located = locateExcerpt(currentContent, row.source_excerpt, row.source_excerpt_hash);
      if (!located) {
        stale.add(row.id);
        continue;
      }
      refresh.run(row.content_hash, located.startLine, located.endLine, row.binding_id);
    }
    for (const id of stale) update.run(timestamp, id);
  })();
  return [...stale];
}

export function listMemories(
  db: SqliteDatabase, status = "active", limit = 50, summaries: "include" | "exclude" | "only" = "include",
): MemoryRecord[] {
  const typeFilter = summaries === "exclude" ? " AND type <> 'task-summary'"
    : summaries === "only" ? " AND type = 'task-summary'" : "";
  const rows = db.prepare(`SELECT * FROM memories WHERE status = ?${typeFilter} ORDER BY updated_at DESC LIMIT ?`)
    .all(status, limit) as MemoryRow[];
  return rows.map(mapMemory);
}

export function getMemory(db: SqliteDatabase, memoryId: string): MemoryRecord {
  ensureMemory(db, memoryId);
  return mapMemory(db.prepare("SELECT * FROM memories WHERE id = ?").get(memoryId) as MemoryRow);
}

export function updateMemoryStatus(
  db: SqliteDatabase,
  memoryId: string,
  status: z.infer<typeof memoryStatusSchema>,
): MemoryRecord {
  ensureMemory(db, memoryId);
  db.prepare("UPDATE memories SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), memoryId);
  return mapMemory(db.prepare("SELECT * FROM memories WHERE id = ?").get(memoryId) as MemoryRow);
}

function ensureMemory(db: SqliteDatabase, id: string): void {
  if (!db.prepare("SELECT id FROM memories WHERE id = ?").get(id)) {
    throw new ProjectContextError("MEMORY_NOT_FOUND", `Unknown memory: ${id}`);
  }
}

function resolveSourceBinding(
  db: SqliteDatabase,
  sourceKind: string,
  sourceRef?: string,
): {
  sourceId: string | null;
  sourceHash: string | null;
  startLine: number | null;
  endLine: number | null;
  gitCommit: string | null;
  sourceExcerpt: string | null;
  sourceExcerptHash: string | null;
} {
  if (["git", "hg", "svn"].includes(sourceKind)) {
    return {
      sourceId: null, sourceHash: null, startLine: null, endLine: null,
      gitCommit: sourceRef?.split(":", 1)[0] || null, sourceExcerpt: null, sourceExcerptHash: null,
    };
  }
  if (sourceKind !== "file" || !sourceRef) {
    return {
      sourceId: null, sourceHash: null, startLine: null, endLine: null,
      gitCommit: null, sourceExcerpt: null, sourceExcerptHash: null,
    };
  }
  const match = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(sourceRef);
  const path = (match?.[1] ?? sourceRef).replaceAll("\\", "/");
  const source = db.prepare("SELECT id, content_hash FROM sources WHERE path = ?").get(path) as
    { id: string; content_hash: string } | undefined;
  const excerpt = source && match?.[2]
    ? paragraphExcerpt(sourceContent(db, path), Number(match[2]), match[3] ? Number(match[3]) : Number(match[2]))
    : null;
  return {
    sourceId: source?.id ?? null,
    sourceHash: source?.content_hash ?? null,
    startLine: excerpt?.startLine ?? (match?.[2] ? Number(match[2]) : null),
    endLine: excerpt?.endLine ?? (match?.[3] ? Number(match[3]) : null),
    gitCommit: null,
    sourceExcerpt: excerpt?.content ?? null,
    sourceExcerptHash: excerpt ? sha256(excerpt.content) : null,
  };
}

function sourceContent(db: SqliteDatabase, path: string): string {
  return (db.prepare(
    "SELECT content FROM chunks WHERE source_path = ? ORDER BY start_line",
  ).pluck().all(path) as string[]).join("\n");
}

function paragraphExcerpt(
  content: string,
  requestedStartLine: number,
  requestedEndLine: number,
): { content: string; startLine: number; endLine: number } | null {
  const lines = content.split("\n");
  if (requestedStartLine < 1 || requestedStartLine > lines.length) return null;
  let start = requestedStartLine - 1;
  let end = Math.min(lines.length - 1, Math.max(start, requestedEndLine - 1));
  while (start > 0 && lines[start - 1]!.trim() && end - start < 200) start -= 1;
  while (end + 1 < lines.length && lines[end + 1]!.trim() && end - start < 200) end += 1;
  let excerpt = normalizeExcerpt(lines.slice(start, end + 1).join("\n"));
  if (!excerpt) return null;
  if (excerpt.length > 4_000) {
    start = requestedStartLine - 1;
    end = Math.min(lines.length - 1, Math.max(start, requestedEndLine - 1));
    excerpt = normalizeExcerpt(lines.slice(start, end + 1).join("\n")).slice(0, 4_000);
  }
  return { content: excerpt, startLine: start + 1, endLine: end + 1 };
}

function locateExcerpt(
  currentContent: string,
  expectedExcerpt: string,
  expectedHash: string,
): { startLine: number; endLine: number } | null {
  const normalizedContent = normalizeExcerpt(currentContent);
  const normalizedExcerpt = normalizeExcerpt(expectedExcerpt);
  if (sha256(normalizedExcerpt) !== expectedHash) return null;
  const index = normalizedContent.indexOf(normalizedExcerpt);
  if (index < 0) return null;
  const startLine = normalizedContent.slice(0, index).split("\n").length;
  return { startLine, endLine: startLine + normalizedExcerpt.split("\n").length - 1 };
}

function normalizeExcerpt(value: string): string {
  return value.replaceAll("\r\n", "\n").trim();
}

function mapMemory(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    type: memoryTypeSchema.parse(row.type),
    title: row.title,
    content: row.content,
    reason: row.reason,
    status: memoryStatusSchema.parse(row.status),
    confidence: row.confidence,
    scope: JSON.parse(row.scope_json) as string[],
    sourceKind: row.source_kind,
    sourceRef: row.source_ref,
    supersedesId: row.supersedes_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
