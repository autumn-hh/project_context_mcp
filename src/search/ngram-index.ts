import type { SqliteDatabase } from "../storage/database.js";
import { isLowRelevanceSourcePath } from "../indexing/file-policy.js";

export type SearchItemKind = "chunk" | "symbol" | "memory";

// Describes which terms are generated, not how they are stored, so older clients that read the
// same rows through the search_ngrams view agree on it and never trigger rebuilds back and forth.
const NGRAM_SCHEMA_VERSION = "1";
const ITEM_BATCH_SIZE = 25;
const INSERT_BATCH_SIZE = 250;
const DELETE_BATCH_SIZE = 500;
const LEGACY_BATCH_ROWS = 20_000;
const MAX_LATIN_TOKEN_LENGTH = 128;

export interface NgramRebuildOptions {
  signal?: AbortSignal;
  onBatch?: () => void | Promise<void>;
}

export function replaceItemNgrams(
  db: SqliteDatabase,
  kind: SearchItemKind,
  itemId: string,
  content: string,
): void {
  deleteItemNgrams(db, kind, itemId);
  const terms = [...ngrams(content)];
  if (terms.length === 0) return;
  const item = Number(db.prepare("INSERT INTO search_items (kind, item_id) VALUES (?, ?)").run(kind, itemId).lastInsertRowid);
  insertTerms(db, item, terms);
}

export function deleteItemNgrams(db: SqliteDatabase, kind: SearchItemKind, itemId: string): void {
  deleteItemsNgrams(db, kind, [itemId]);
}

export function deleteItemsNgrams(db: SqliteDatabase, kind: SearchItemKind, itemIds: readonly string[]): void {
  for (let offset = 0; offset < itemIds.length; offset += DELETE_BATCH_SIZE) {
    const batch = itemIds.slice(offset, offset + DELETE_BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(", ");
    // Unconverted rows of a replaced item must not be converted back later.
    db.prepare(`DELETE FROM legacy_search_ngrams WHERE item_kind = ? AND item_id IN (${placeholders})`).run(kind, ...batch);
    const items = db.prepare(`SELECT id FROM search_items WHERE kind = ? AND item_id IN (${placeholders})`)
      .pluck().all(kind, ...batch) as number[];
    if (items.length === 0) continue;
    const itemPlaceholders = items.map(() => "?").join(", ");
    db.prepare(`DELETE FROM search_terms WHERE item IN (${itemPlaceholders})`).run(...items);
    db.prepare(`DELETE FROM search_items WHERE id IN (${itemPlaceholders})`).run(...items);
  }
}

/** Whether any of the items still has terms, e.g. after a source moved to the low-relevance tier. */
export function hasItemNgrams(db: SqliteDatabase, kind: SearchItemKind, itemIds: readonly string[]): boolean {
  for (let offset = 0; offset < itemIds.length; offset += DELETE_BATCH_SIZE) {
    const batch = itemIds.slice(offset, offset + DELETE_BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(", ");
    for (const table of ["search_items", "legacy_search_ngrams"]) {
      const kindColumn = table === "search_items" ? "kind" : "item_kind";
      if (db.prepare(`SELECT 1 FROM ${table} WHERE ${kindColumn} = ? AND item_id IN (${placeholders}) LIMIT 1`).get(kind, ...batch)) return true;
    }
  }
  return false;
}

/**
 * Copy schema 10 rows into the integer-item tables in term order. Each batch commits on its own
 * and advances legacy_ngram_cursor, which the search_ngrams view reads, so the conversion can be
 * interrupted and resumed while other connections keep reading and writing. Converted rows stay
 * in place until the end: deleting them row by row costs most of the conversion time. The item
 * index is likewise built once at the end; updating it per row made a 14M-row conversion take
 * 13 minutes instead of 42 seconds. Meanwhile deleting one item's terms scans the table, so memory
 * edits made by other connections during the conversion are slower; index runs wait on the lease.
 */
export async function convertLegacyNgrams(db: SqliteDatabase, options: NgramRebuildOptions = {}): Promise<void> {
  if (!db.prepare("SELECT 1 FROM legacy_search_ngrams LIMIT 1").get()) {
    // Also restores the index if an earlier run stopped between converting and building it.
    db.exec("CREATE INDEX IF NOT EXISTS search_terms_item_idx ON search_terms(item)");
    return;
  }
  db.exec("DROP INDEX IF EXISTS search_terms_item_idx");
  const readCursor = db.prepare("SELECT value FROM metadata WHERE key = 'legacy_ngram_cursor'").pluck();
  const batchEnd = db.prepare(`SELECT term FROM legacy_search_ngrams WHERE term > ? ORDER BY term LIMIT 1 OFFSET ${LEGACY_BATCH_ROWS - 1}`).pluck();
  const lastTerm = db.prepare("SELECT MAX(term) FROM legacy_search_ngrams WHERE term > ?").pluck();
  const convert = db.transaction((from: string, to: string) => {
    db.prepare(`INSERT OR IGNORE INTO search_items (kind, item_id)
      SELECT DISTINCT item_kind, item_id FROM legacy_search_ngrams WHERE term > ? AND term <= ?`).run(from, to);
    db.prepare(`INSERT OR IGNORE INTO search_terms (term, item)
      SELECT l.term, i.id FROM legacy_search_ngrams l JOIN search_items i ON i.kind = l.item_kind AND i.item_id = l.item_id
      WHERE l.term > ? AND l.term <= ?`).run(from, to);
    db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('legacy_ngram_cursor', ?)").run(to);
  });
  while (true) {
    throwIfCancelled(options.signal);
    const from = (readCursor.get() as string | undefined) ?? "";
    const to = (batchEnd.get(from) ?? lastTerm.get(from)) as string | null;
    if (to === null) break;
    convert.immediate(from, to);
    await batchBoundary(options);
  }
  db.exec("CREATE INDEX IF NOT EXISTS search_terms_item_idx ON search_terms(item)");
  resetLegacyNgrams(db);
}

/** Empty the legacy table by replacing it, which is far cheaper than deleting millions of rows. */
function resetLegacyNgrams(db: SqliteDatabase): void {
  db.transaction(() => db.exec(`
    DROP TABLE legacy_search_ngrams;
    CREATE TABLE legacy_search_ngrams (
      term TEXT NOT NULL,
      item_kind TEXT NOT NULL,
      item_id TEXT NOT NULL,
      PRIMARY KEY (term, item_kind, item_id)
    ) WITHOUT ROWID;
    DELETE FROM metadata WHERE key = 'legacy_ngram_cursor';
  `)).immediate();
}

export function matchingNgramItems(
  db: SqliteDatabase,
  query: string,
  limit: number,
  options: { excludeTaskSummaries?: boolean } = {},
): Array<{ kind: SearchItemKind; id: string; matches: number; coverage: number }> {
  const terms = [...ngrams(query)];
  if (terms.length === 0) return [];
  const minimumMatches = Math.max(1, Math.ceil(terms.length * 0.6));
  const placeholders = terms.map(() => "?").join(", ");
  // Until the first index after upgrading converts all schema 10 rows, read through the view.
  const legacy = Boolean(db.prepare("SELECT 1 FROM legacy_search_ngrams LIMIT 1").get());
  const [source, term, kind, id, group] = legacy
    ? ["search_ngrams n", "n.term", "n.item_kind", "n.item_id", "n.item_kind, n.item_id"]
    : ["search_terms t JOIN search_items i ON i.id = t.item", "t.term", "i.kind", "i.item_id", "t.item"];
  const matches = db.prepare(`
    SELECT ${kind} AS kind, ${id} AS id, COUNT(*) AS matches
    FROM ${source}
    WHERE ${term} IN (${placeholders})
      AND (
        ${kind} <> 'memory'
        OR EXISTS (
          SELECT 1 FROM memories
          WHERE memories.id = ${id}
            AND memories.status = 'active'
            ${options.excludeTaskSummaries ? "AND memories.type <> 'task-summary'" : ""}
        )
      )
    GROUP BY ${group}
    HAVING COUNT(*) >= ?
    ORDER BY matches DESC, ${kind} ASC, ${id} ASC
    LIMIT ?
  `).all(...terms, minimumMatches, limit) as Array<{ kind: SearchItemKind; id: string; matches: number }>;
  return matches.map((item) => ({ ...item, coverage: item.matches / terms.length }));
}

export function isNgramIndexCurrent(db: SqliteDatabase): boolean {
  return db.prepare("SELECT value FROM metadata WHERE key = 'ngram_schema_version'").pluck().get()
    === NGRAM_SCHEMA_VERSION;
}

export async function rebuildNgramIndexIfNeeded(
  db: SqliteDatabase,
  options: NgramRebuildOptions = {},
): Promise<boolean> {
  if (isNgramIndexCurrent(db)) return false;
  await rebuildNgramIndex(db, options);
  return true;
}

export async function rebuildNgramIndex(
  db: SqliteDatabase,
  options: NgramRebuildOptions = {},
): Promise<void> {
  db.prepare("DELETE FROM metadata WHERE key = 'ngram_schema_version'").run();
  await clearNgramIndex(db, options);
  await rebuildKind(db, "chunk", {
    select: "SELECT id, source_path, content FROM chunks WHERE id > ? ORDER BY id LIMIT ?",
    include: (row) => !isLowRelevanceSourcePath(String(row.source_path)),
    content: (row) => `${String(row.source_path)}\n${String(row.content)}`,
  }, options);
  await rebuildKind(db, "symbol", {
    select: "SELECT id, source_path, name, qualified_name, signature FROM symbols WHERE id > ? ORDER BY id LIMIT ?",
    include: (row) => !isLowRelevanceSourcePath(String(row.source_path)),
    content: (row) => `${String(row.name)}\n${String(row.qualified_name)}\n${String(row.signature ?? "")}`,
  }, options);
  await rebuildKind(db, "memory", {
    select: "SELECT id, title, content, reason FROM memories WHERE id > ? ORDER BY id LIMIT ?",
    content: (row) => `${String(row.title)}\n${String(row.content)}\n${String(row.reason ?? "")}`,
  }, options);
  throwIfCancelled(options.signal);
  db.prepare("INSERT INTO metadata (key, value) VALUES ('ngram_schema_version', ?)")
    .run(NGRAM_SCHEMA_VERSION);
}

async function clearNgramIndex(db: SqliteDatabase, options: NgramRebuildOptions): Promise<void> {
  // An interrupted conversion may have left the item index absent; per-item deletes need it.
  db.exec("CREATE INDEX IF NOT EXISTS search_terms_item_idx ON search_terms(item)");
  const selectItems = db.prepare("SELECT id FROM search_items ORDER BY id LIMIT ?");
  const removeBatch = db.transaction((items: number[]) => {
    const placeholders = items.map(() => "?").join(", ");
    db.prepare(`DELETE FROM search_terms WHERE item IN (${placeholders})`).run(...items);
    db.prepare(`DELETE FROM search_items WHERE id IN (${placeholders})`).run(...items);
  });
  while (true) {
    throwIfCancelled(options.signal);
    const items = selectItems.pluck().all(ITEM_BATCH_SIZE) as number[];
    if (items.length === 0) break;
    removeBatch(items);
    await batchBoundary(options);
  }
  // Terms left without an item, e.g. by an interrupted delete in an older client.
  db.prepare("DELETE FROM search_terms WHERE item NOT IN (SELECT id FROM search_items)").run();
  if (db.prepare("SELECT 1 FROM legacy_search_ngrams LIMIT 1").get()) resetLegacyNgrams(db);
}

async function rebuildKind(
  db: SqliteDatabase,
  kind: SearchItemKind,
  source: {
    select: string;
    include?: (row: Record<string, unknown>) => boolean;
    content: (row: Record<string, unknown>) => string;
  },
  options: NgramRebuildOptions,
): Promise<void> {
  const select = db.prepare(source.select);
  const insertBatch = db.transaction((rows: Array<Record<string, unknown>>) => {
    for (const row of rows) {
      if (source.include && !source.include(row)) continue;
      replaceItemNgrams(db, kind, String(row.id), source.content(row));
    }
  });
  let cursor = "";
  while (true) {
    throwIfCancelled(options.signal);
    const rows = select.all(cursor, ITEM_BATCH_SIZE) as Array<Record<string, unknown>>;
    if (rows.length === 0) return;
    insertBatch(rows);
    cursor = String(rows.at(-1)!.id);
    await batchBoundary(options);
  }
}

function insertTerms(db: SqliteDatabase, item: number, terms: string[]): void {
  for (let offset = 0; offset < terms.length; offset += INSERT_BATCH_SIZE) {
    const batch = terms.slice(offset, offset + INSERT_BATCH_SIZE);
    const values = batch.map(() => "(?, ?)").join(", ");
    const parameters = batch.flatMap((term) => [term, item]);
    db.prepare(`INSERT OR IGNORE INTO search_terms (term, item) VALUES ${values}`).run(...parameters);
  }
}

async function batchBoundary(options: NgramRebuildOptions): Promise<void> {
  await options.onBatch?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  throwIfCancelled(options.signal);
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error("Project indexing was cancelled.");
    error.name = "AbortError";
    throw error;
  }
}

function ngrams(value: string): Set<string> {
  const normalized = value.normalize("NFKC").toLowerCase();
  const terms = new Set<string>();
  for (const sequence of normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) ?? []) {
    const characters = [...sequence];
    for (const size of [2, 3]) {
      for (let index = 0; index + size <= characters.length; index += 1) {
        terms.add(characters.slice(index, index + size).join(""));
      }
    }
  }
  for (const token of normalized.match(/[\p{L}\p{N}_-]+/gu) ?? []) {
    if ([...token].some((character) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(character))) continue;
    if (token.length > MAX_LATIN_TOKEN_LENGTH) continue;
    if (token.length < 3) terms.add(token);
    else for (let index = 0; index + 3 <= token.length; index += 1) terms.add(token.slice(index, index + 3));
  }
  return terms;
}
