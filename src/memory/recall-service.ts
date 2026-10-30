import type { SqliteDatabase } from "../storage/database.js";
import { getMemory, type MemoryRecord } from "./memory-service.js";
import { taskTokens, taskOverlap } from "../shared/task-relevance.js";
import { rrfMerge } from "../search/rank-fusion.js";

export interface MemoryRecall {
  memory: MemoryRecord;
  score: number;
}

const MAX_QUERY_TERMS = 64;
const CHANNEL_LIMIT = 128;
const MAX_CHANNEL_PAGES = 4;
const QUESTION_TERMS = new Set([
  "please", "what", "why", "how", "does", "about", "之前", "关于", "我们", "什么",
  "为何", "为什么", "请问", "帮我", "查一", "查看", "一下", "决定", "现在",
]);

/**
 * Recall knowledge independently of code quotas. This is local lexical retrieval,
 * not semantic inference: FTS words and Han bigrams use separate ranked channels.
 * Status/type filtering precedes each channel's LIMIT; all queries stay bounded.
 */
export function recallMemories(
  db: SqliteDatabase,
  query: string,
  options: {
    limit?: number;
    includeTaskSummaries?: boolean;
    needsReview?: boolean;
    accepts?: (memory: MemoryRecord) => boolean;
  } = {},
): MemoryRecall[] {
  const limit = Math.min(64, Math.max(0, Math.floor(options.limit ?? 32)));
  if (!Number.isFinite(limit) || limit === 0) return [];
  const terms = taskTokens(query).filter((term) => !QUESTION_TERMS.has(term)).slice(0, MAX_QUERY_TERMS);
  if (terms.length === 0) return [];
  const statusFilter = options.needsReview ? "m.status IN ('stale', 'conflicted')" : "m.status = 'active'";
  const typeFilter = options.includeTaskSummaries ? "" : "AND m.type <> 'task-summary'";
  const ftsQuery = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
  // Preserve SQLite's ascending (negative) BM25 order; do not invert its strength.
  const exactQuery = db.prepare(`
    SELECT m.id FROM memories_fts JOIN memories m ON m.id = memories_fts.memory_id
    WHERE memories_fts MATCH ? AND ${statusFilter} ${typeFilter}
    ORDER BY bm25(memories_fts, 0, 2, 1, 0.5), m.updated_at DESC, m.id LIMIT ? OFFSET ?
  `);
  const cached = new Map<string, MemoryRecord>();
  // Scope is evaluated using task/source evidence. Fetch additional bounded pages
  // when inapplicable modules fill a page, without scanning all stored memories.
  const collect = (page: (offset: number) => Array<{ id: string }>): MemoryRecord[] => {
    const accepted: MemoryRecord[] = [];
    for (let index = 0; index < MAX_CHANNEL_PAGES && accepted.length < CHANNEL_LIMIT; index += 1) {
      const rows = page(index * CHANNEL_LIMIT);
      for (const { id } of rows) {
        let memory = cached.get(id);
        if (!memory) {
          memory = getMemory(db, id);
          cached.set(id, memory);
        }
        if (!options.accepts || options.accepts(memory)) accepted.push(memory);
      }
      if (rows.length < CHANNEL_LIMIT) break;
    }
    return accepted.slice(0, CHANNEL_LIMIT);
  };
  const exact = collect((offset) => exactQuery.all(ftsQuery, CHANNEL_LIMIT, offset) as Array<{ id: string }>);

  // A question's filler words must not require 60% coverage of the entire sentence.
  // The existing n-gram index already stores Han bigrams; no migration/rebuild needed.
  const hanTerms = terms.filter((term) => /^\p{Script=Han}{2}$/u.test(term));
  const partialQuery = hanTerms.length ? db.prepare(`
    SELECT m.id FROM search_ngrams n JOIN memories m ON m.id = n.item_id
    WHERE n.item_kind = 'memory' AND n.term IN (${hanTerms.map(() => "?").join(", ")})
      AND ${statusFilter} ${typeFilter}
    GROUP BY m.id
    ORDER BY COUNT(*) DESC, m.updated_at DESC, m.id LIMIT ? OFFSET ?
  `) : null;
  const partial = partialQuery ? collect(
    (offset) => partialQuery.all(...hanTerms, CHANNEL_LIMIT, offset) as Array<{ id: string }>,
  ) : [];

  const ranked = rrfMerge([{ items: exact }, { items: partial }], (item) => item.id)
    .map(({ item: memory, score }) => {
      const overlap = taskOverlap(terms, memory.content) + 2 * taskOverlap(terms, memory.title);
      return { memory, score: score * (1 + overlap / terms.length) };
    })
    .sort((a, b) => b.score - a.score
      || b.memory.updatedAt.localeCompare(a.memory.updatedAt)
      || a.memory.id.localeCompare(b.memory.id));
  const maximum = ranked[0]?.score ?? 1;
  return ranked.slice(0, limit).map(({ memory, score }) => ({ memory, score: score / maximum }));
}
