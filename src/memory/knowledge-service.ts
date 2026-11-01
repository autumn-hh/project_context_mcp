import type { SqliteDatabase } from "../storage/database.js";
import { getMemory, type MemoryRecord } from "./memory-service.js";
import {
  knowledgeDocumentSchema, knowledgeRowSchema, KNOWLEDGE_STATUSES,
  type KnowledgeDocument, type KnowledgeEntity, type KnowledgeRow, type KnowledgeStatus,
} from "./knowledge-schema.js";
import { containsLikelySecret } from "../indexing/file-policy.js";
import { sha256, nowIso } from "../shared/ids.js";
import { ProjectContextError } from "../shared/errors.js";

export interface MemoryKnowledgeRecord {
  id: string;
  memoryId: string;
  memoryHash: string;
  document: KnowledgeDocument;
  status: KnowledgeStatus;
  effectiveStatus: KnowledgeStatus | "stale";
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeSnapshot {
  entities: Array<{
    id: string; name: string; type: KnowledgeEntity["type"]; aliases: string[]; memoryIds: string[];
  }>;
  relations: Array<{
    id: string; from: string; to: string; type: KnowledgeDocument["relations"][number]["type"];
    memoryId: string; quote: string; annotationId: string;
  }>;
  bindings: Array<{ entityId: string; memoryId: string; annotationId: string; quote: string }>;
  truncated: boolean;
}

interface JoinedRow extends KnowledgeRow {
  current_title: string; current_content: string; current_status: string; current_type: string;
}
const EFFECTIVE_STATUSES = [...KNOWLEDGE_STATUSES, "all", "stale"];
const SNAPSHOT_ENTITY_LIMIT = 200;
const SNAPSHOT_RELATION_LIMIT = 400;
const SNAPSHOT_BINDING_LIMIT = 400;
const JOIN_SELECT = `SELECT k.*,m.title AS current_title,m.content AS current_content,
  m.status AS current_status,m.type AS current_type FROM memory_knowledge k
  JOIN memories m ON m.id=k.memory_id`;

export function memoryKnowledgeHash(memory: Pick<MemoryRecord, "title" | "content">): string {
  return sha256(`${memory.title}\n${memory.content}`);
}

export function proposeMemoryKnowledge(
  db: SqliteDatabase, memoryId: string, document: unknown, expectedMemoryHash?: string,
): MemoryKnowledgeRecord {
  checkId(memoryId);
  if (expectedMemoryHash !== undefined && !/^[a-f0-9]{64}$/u.test(expectedMemoryHash)) invalid("Invalid expected memory hash.");
  const parsed = canonicalDocument(knowledgeDocumentSchema.parse(document));
  if (containsLikelySecret(JSON.stringify(parsed))) {
    throw new ProjectContextError("SENSITIVE_MEMORY_REJECTED", "Knowledge annotation appears to contain a credential or private key.");
  }
  return db.transaction(() => {
    const memory = getMemory(db, memoryId);
    if (memory.status !== "active" || memory.type === "task-summary") {
      throw new ProjectContextError("KNOWLEDGE_MEMORY_INACTIVE", "Only active non-summary memories can receive knowledge proposals.");
    }
    const hash = memoryKnowledgeHash(memory);
    if (expectedMemoryHash !== undefined && expectedMemoryHash !== hash) stale();
    validateEvidence(memory, parsed);
    const serialized = JSON.stringify(parsed);
    const id = `mknow_${sha256(JSON.stringify([memoryId, hash, parsed]))}`;
    const existing = readRecord(db, id);
    if (existing) return existing; // Idempotent retries never reactivate rejected or superseded proposals.
    const now = nowIso();
    db.prepare(`INSERT INTO memory_knowledge
      (id,memory_id,memory_hash,document_json,status,version,created_at,updated_at)
      VALUES (?,?,?,?,'pending',1,?,?)`).run(id, memoryId, hash, serialized, now, now);
    return readRecord(db, id)!;
  }).immediate();
}

export function reviewMemoryKnowledge(
  db: SqliteDatabase, input: { id: string; action: "accept" | "reject"; expectedVersion: number },
): MemoryKnowledgeRecord {
  if (!/^mknow_[a-f0-9]{64}$/u.test(input.id)) invalid("Invalid annotation ID.");
  if (input.action !== "accept" && input.action !== "reject") invalid("Unknown review action.");
  bounded(input.expectedVersion, 1, 1, Number.MAX_SAFE_INTEGER);
  return db.transaction(() => {
    const record = readRecord(db, input.id);
    if (!record) throw new ProjectContextError("KNOWLEDGE_NOT_FOUND", "Knowledge annotation is unavailable in this project.");
    if (record.version !== input.expectedVersion) {
      throw new ProjectContextError("KNOWLEDGE_VERSION_CONFLICT", "Knowledge annotation changed; reload before reviewing.", { currentVersion: record.version });
    }
    if (input.action === "reject" && record.status === "rejected") return record;
    const memory = getMemory(db, record.memoryId);
    const evidenceCurrent = memory.status === "active" && memory.type !== "task-summary"
      && memoryKnowledgeHash(memory) === record.memoryHash;
    const concurrentAccepted = acceptedCount(db, record.memoryId);
    if (input.action === "accept" && record.status === "accepted" && concurrentAccepted <= 1) {
      if (!evidenceCurrent) stale();
      return record;
    }
    if (input.action === "accept" && record.status !== "pending" && !(record.status === "accepted" && concurrentAccepted > 1)) {
      throw new ProjectContextError("KNOWLEDGE_REVIEW_STATE", "Only pending knowledge annotations can be accepted.");
    }
    const now = nowIso();
    if (input.action === "accept") {
      // Accepting a reviewed winner also resolves multiple concurrent accepted
      // annotations; changed underlying memory evidence still cannot be revived.
      if (!evidenceCurrent) stale();
      validateEvidence(memory, record.document);
      if (containsLikelySecret(JSON.stringify(record.document))) {
        throw new ProjectContextError("SENSITIVE_MEMORY_REJECTED", "Knowledge annotation appears to contain a credential or private key.");
      }
      db.prepare(`UPDATE memory_knowledge SET status='superseded',version=version+1,updated_at=?
        WHERE memory_id=? AND status='accepted' AND id<>?`).run(now, record.memoryId, record.id);
    }
    db.prepare("UPDATE memory_knowledge SET status=?,version=version+1,updated_at=? WHERE id=? AND version=?")
      .run(input.action === "accept" ? "accepted" : "rejected", now, record.id, record.version);
    return readRecord(db, record.id)!;
  }).immediate();
}

export function listMemoryKnowledge(
  db: SqliteDatabase,
  options: {
    memoryId?: string | undefined;
    status?: KnowledgeStatus | "all" | "stale" | undefined;
    query?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
  } = {},
): { items: MemoryKnowledgeRecord[]; total: number; limit: number; offset: number } {
  if (options.memoryId !== undefined) checkId(options.memoryId);
  const status = options.status ?? "all";
  if (!EFFECTIVE_STATUSES.includes(status)) invalid("Unknown knowledge annotation status.");
  const limit = bounded(options.limit, 30, 1, 100);
  const offset = bounded(options.offset, 0, 0, 1_000_000);
  const query = normalizeQuery(options.query);
  const parameters = options.memoryId === undefined ? [] : [options.memoryId];
  const rows = db.prepare(`${JOIN_SELECT} ${options.memoryId === undefined ? "" : "WHERE k.memory_id=?"}
    ORDER BY k.updated_at DESC,k.id`).iterate(...parameters) as Iterable<JoinedRow>;
  const conflicted = conflictingAcceptedMemories(db);
  const items: MemoryKnowledgeRecord[] = [];
  let total = 0;
  for (const row of rows) {
    const record = mapRecord(row, conflicted.has(row.memory_id));
    if (status !== "all" && record.effectiveStatus !== status) continue;
    if (query && !recordMatches(record, row, query)) continue;
    if (total >= offset && items.length < limit) items.push(record);
    total += 1;
  }
  return { items, total, limit, offset };
}

export function knowledgeSnapshot(
  db: SqliteDatabase,
  options: {
    memoryId?: string | undefined; entityId?: string | undefined; matchedName?: string | undefined;
    query?: string | undefined; limit?: number | undefined;
  } = {},
): KnowledgeSnapshot {
  if (options.memoryId !== undefined) checkId(options.memoryId);
  if (options.entityId !== undefined && !/^kent_[a-f0-9]{64}$/u.test(options.entityId)) invalid("Invalid entity ID.");
  const limit = bounded(options.limit, 50, 1, 100);
  const query = normalizeQuery(options.query);
  const matchedName = normalizeQuery(options.matchedName);
  const entities = new Map<string, KnowledgeSnapshot["entities"][number]>();
  const relations = new Map<string, KnowledgeSnapshot["relations"][number]>();
  const bindings = new Map<string, KnowledgeSnapshot["bindings"][number]>();
  let truncated = false;
  let selected = 0;
  const conflicted = conflictingAcceptedMemories(db);
  const rows = db.prepare(`${JOIN_SELECT} WHERE k.status='accepted' AND m.status='active' AND m.type<>'task-summary'
    ${options.memoryId === undefined ? "" : "AND k.memory_id=?"} ORDER BY k.updated_at DESC,k.id`)
    .iterate(...(options.memoryId === undefined ? [] : [options.memoryId])) as Iterable<JoinedRow>;
  for (const row of rows) {
    // Stream all accepted rows until enough current records are found: a stale
    // history page must not hide valid older knowledge. No complete history array.
    const record = mapRecord(row, conflicted.has(row.memory_id));
    if (record.effectiveStatus !== "accepted" || (query && !recordMatches(record, row, query))) continue;
    if (matchedName && !record.document.entities.some((entity) =>
      [entity.name, ...entity.aliases].some((name) => normalizeName(name) === matchedName))) continue;
    if (options.entityId !== undefined && !record.document.entities.some((entity) => entityId(entity) === options.entityId)) continue;
    if (selected >= limit) { truncated = true; break; }
    selected += 1;
    const keys = new Map<string, string>();
    for (const entity of record.document.entities) {
      const id = entityId(entity);
      const existing = entities.get(id);
      if (!existing && entities.size >= SNAPSHOT_ENTITY_LIMIT) { truncated = true; continue; }
      if (!existing) {
        entities.set(id, { id, name: entity.name, type: entity.type, aliases: [], memoryIds: [] });
      }
      const current = entities.get(id)!;
      if (!current.memoryIds.includes(record.memoryId)) current.memoryIds.push(record.memoryId);
      const aliases = [...new Set([...current.aliases, ...entity.aliases])]
        .filter((alias) => normalizeName(alias) !== normalizeName(current.name)).sort();
      if (aliases.length > 32) truncated = true;
      current.aliases = aliases.slice(0, 32);
      keys.set(entity.key, id);
      if (bindings.size >= SNAPSHOT_BINDING_LIMIT) truncated = true;
      else {
        const key = JSON.stringify([id, record.id, entity.evidence]);
        bindings.set(key, { entityId: id, memoryId: record.memoryId, annotationId: record.id, quote: entity.evidence });
      }
    }
    for (const relation of record.document.relations) {
      const from = keys.get(relation.from);
      const to = keys.get(relation.to);
      if (!from || !to || from === to) { truncated = true; continue; }
      if (relations.size >= SNAPSHOT_RELATION_LIMIT) { truncated = true; continue; }
      const id = `krel_${sha256(JSON.stringify([record.id, from, to, relation.type, relation.evidence]))}`;
      relations.set(id, {
        id, from, to, type: relation.type, memoryId: record.memoryId, quote: relation.evidence, annotationId: record.id,
      });
    }
  }
  return {
    entities: [...entities.values()], relations: [...relations.values()], bindings: [...bindings.values()], truncated,
  };
}

function readRecord(db: SqliteDatabase, id: string): MemoryKnowledgeRecord | undefined {
  const row = db.prepare(`${JOIN_SELECT} WHERE k.id=?`).get(id) as JoinedRow | undefined;
  return row ? mapRecord(row, acceptedCount(db, row.memory_id) > 1) : undefined;
}

function mapRecord(row: JoinedRow, concurrentAccepted = false): MemoryKnowledgeRecord {
  const { current_title, current_content, current_status, current_type, ...stored } = row;
  const parsed = knowledgeRowSchema.parse(stored);
  const document = knowledgeDocumentSchema.parse(JSON.parse(parsed.document_json));
  let invalidProvenance = false;
  try {
    validateEvidence({ title: current_title, content: current_content }, document);
    invalidProvenance = containsLikelySecret(JSON.stringify(document));
  } catch (error) {
    if (!(error instanceof ProjectContextError) || error.code !== "KNOWLEDGE_EVIDENCE_INVALID") throw error;
    invalidProvenance = true;
  }
  const changed = current_status !== "active" || current_type === "task-summary" || invalidProvenance
    || (parsed.status === "accepted" && concurrentAccepted)
    || memoryKnowledgeHash({ title: current_title, content: current_content }) !== parsed.memory_hash;
  return {
    id: parsed.id, memoryId: parsed.memory_id, memoryHash: parsed.memory_hash,
    document,
    status: parsed.status,
    effectiveStatus: changed && (parsed.status === "pending" || parsed.status === "accepted") ? "stale" : parsed.status,
    version: parsed.version, createdAt: parsed.created_at, updatedAt: parsed.updated_at,
  };
}

function validateEvidence(memory: Pick<MemoryRecord, "title" | "content">, document: KnowledgeDocument): void {
  const original = `${memory.title}\n${memory.content}`;
  const hasExactQuote = (quote: string): void => {
    if (!original.includes(quote)) {
      throw new ProjectContextError("KNOWLEDGE_EVIDENCE_INVALID", "Evidence must be an exact continuous quotation from the memory title and content.");
    }
  };
  const entities = new Map(document.entities.map((entity) => [entity.key, entity]));
  const canonical = new Set<string>();
  for (const entity of document.entities) {
    hasExactQuote(entity.evidence);
    if (!mentionsEntity(entity.evidence, entity)) invalidEvidence("Entity evidence must include its name or an explicitly supplied alias.");
    const id = entityId(entity);
    if (canonical.has(id)) invalidEvidence("One annotation cannot repeat the same normalized entity.");
    canonical.add(id);
  }
  for (const relation of document.relations) {
    hasExactQuote(relation.evidence);
    const from = entities.get(relation.from)!;
    const to = entities.get(relation.to)!;
    if (entityId(from) === entityId(to)) invalidEvidence("Normalized self relationships are not allowed.");
    if (!mentionsEntity(relation.evidence, from) || !mentionsEntity(relation.evidence, to)) {
      invalidEvidence("Relationship evidence must mention both declared endpoint names or aliases.");
    }
  }
}

function mentionsEntity(quote: string, entity: KnowledgeEntity): boolean {
  return [entity.name, ...entity.aliases].some((name) => {
    let offset = 0;
    while (offset <= quote.length) {
      const index = quote.indexOf(name, offset);
      if (index < 0) return false;
      const before = quote[index - 1] ?? "";
      const after = quote[index + name.length] ?? "";
      const startsLatin = /^[A-Za-z0-9_]/u.test(name);
      const endsLatin = /[A-Za-z0-9_]$/u.test(name);
      if ((!startsLatin || !/[A-Za-z0-9_]/u.test(before)) && (!endsLatin || !/[A-Za-z0-9_]/u.test(after))) return true;
      offset = index + 1;
    }
    return false;
  });
}

function canonicalDocument(document: KnowledgeDocument): KnowledgeDocument {
  return {
    entities: document.entities.map((entity) => ({ ...entity, aliases: [...new Set(entity.aliases)].sort() }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    relations: [...document.relations].sort((a, b) =>
      JSON.stringify([a.from, a.to, a.type, a.evidence]).localeCompare(JSON.stringify([b.from, b.to, b.type, b.evidence]))),
  };
}

function recordMatches(record: MemoryKnowledgeRecord, memory: { current_title: string; current_content: string }, query: string): boolean {
  const content = normalizeName(`${memory.current_title}\n${memory.current_content}`);
  if (query.length < 2) return false;
  const latinQuery = /^[a-z0-9_ .-]+$/u.test(query);
  const containsTerm = (text: string): boolean => {
    if (!latinQuery) return text.includes(query);
    let offset = 0;
    while (offset <= text.length) {
      const index = text.indexOf(query, offset);
      if (index < 0) return false;
      if (!/[a-z0-9_]/u.test(text[index - 1] ?? "") && !/[a-z0-9_]/u.test(text[index + query.length] ?? "")) return true;
      offset = index + 1;
    }
    return false;
  };
  if (containsTerm(content)) return true;
  const eligibleAliases = new Map<string, number>();
  for (const entity of record.document.entities) {
    for (const alias of new Set(entity.aliases.map(normalizeName))) {
      eligibleAliases.set(alias, (eligibleAliases.get(alias) ?? 0) + 1);
    }
  }
  return record.document.entities.some((entity) => containsTerm(normalizeName(entity.name))
    || entity.aliases.some((alias) => {
      const normalized = normalizeName(alias);
      // Alias-only queries require a complete, nontrivial, unambiguous name.
      // Snapshot consumers still resolve ambiguity across different annotations.
      return normalized.length >= 3 && normalized === query && eligibleAliases.get(normalized) === 1;
    }));
}
function normalizeName(value: string): string { return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase(); }
function acceptedCount(db: SqliteDatabase, memoryId: string): number {
  return db.prepare("SELECT COUNT(*) FROM memory_knowledge WHERE memory_id=? AND status='accepted'").pluck().get(memoryId) as number;
}
function conflictingAcceptedMemories(db: SqliteDatabase): Set<string> {
  return new Set(db.prepare("SELECT memory_id FROM memory_knowledge WHERE status='accepted' GROUP BY memory_id HAVING COUNT(*)>1")
    .pluck().all() as string[]);
}
function entityId(entity: Pick<KnowledgeEntity, "type" | "name">): string {
  return `kent_${sha256(JSON.stringify([entity.type, normalizeName(entity.name)]))}`;
}
function normalizeQuery(query: string | undefined): string {
  if (query === undefined) return "";
  if (typeof query !== "string" || query.length > 200) invalid("Knowledge query must not exceed 200 characters.");
  return normalizeName(query);
}
function checkId(value: string): void {
  if (typeof value !== "string" || !value || value.length > 200) invalid("Invalid memory ID.");
}
function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) invalid(`Expected integer ${min}..${max}.`);
  return value;
}
function invalid(message: string): never { throw new ProjectContextError("INVALID_MEMORY_KNOWLEDGE", message); }
function invalidEvidence(message: string): never { throw new ProjectContextError("KNOWLEDGE_EVIDENCE_INVALID", message); }
function stale(): never { throw new ProjectContextError("KNOWLEDGE_STALE", "Memory evidence changed or is inactive; propose a fresh annotation before accepting."); }
