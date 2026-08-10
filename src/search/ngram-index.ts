import type { SqliteDatabase } from "../storage/database.js";

export type SearchItemKind = "chunk" | "symbol" | "memory";

const NGRAM_SCHEMA_VERSION = "1";
const ITEM_BATCH_SIZE = 25;
const INSERT_BATCH_SIZE = 250;
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
  db.prepare("DELETE FROM search_ngrams WHERE item_kind = ? AND item_id = ?").run(kind, itemId);
  insertTerms(db, kind, itemId, [...ngrams(content)]);
}

export function deleteItemNgrams(db: SqliteDatabase, kind: SearchItemKind, itemId: string): void {
  db.prepare("DELETE FROM search_ngrams WHERE item_kind = ? AND item_id = ?").run(kind, itemId);
}

export function matchingNgramItems(
  db: SqliteDatabase,
  query: string,
  limit: number,
): Array<{ kind: SearchItemKind; id: string; matches: number; coverage: number }> {
  const terms = [...ngrams(query)];
  if (terms.length === 0) return [];
  const minimumMatches = Math.max(1, Math.ceil(terms.length * 0.6));
  const placeholders = terms.map(() => "?").join(", ");
  const matches = db.prepare(`
    SELECT item_kind AS kind, item_id AS id, COUNT(*) AS matches
    FROM search_ngrams
    WHERE term IN (${placeholders})
      AND (
        item_kind <> 'memory'
        OR EXISTS (
          SELECT 1 FROM memories
          WHERE memories.id = search_ngrams.item_id
            AND memories.status = 'active'
        )
      )
    GROUP BY item_kind, item_id
    HAVING COUNT(*) >= ?
    ORDER BY matches DESC, item_kind ASC, item_id ASC
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
    content: (row) => `${String(row.source_path)}\n${String(row.content)}`,
  }, options);
  await rebuildKind(db, "symbol", {
    select: "SELECT id, name, qualified_name, signature FROM symbols WHERE id > ? ORDER BY id LIMIT ?",
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
  const selectItems = db.prepare(`
    SELECT item_kind, item_id FROM search_ngrams
    GROUP BY item_kind, item_id LIMIT ?
  `);
  const remove = db.prepare("DELETE FROM search_ngrams WHERE item_kind = ? AND item_id = ?");
  const removeBatch = db.transaction((rows: Array<{ item_kind: string; item_id: string }>) => {
    for (const row of rows) remove.run(row.item_kind, row.item_id);
  });
  while (true) {
    throwIfCancelled(options.signal);
    const rows = selectItems.all(ITEM_BATCH_SIZE) as Array<{ item_kind: string; item_id: string }>;
    if (rows.length === 0) return;
    removeBatch(rows);
    await batchBoundary(options);
  }
}

async function rebuildKind(
  db: SqliteDatabase,
  kind: SearchItemKind,
  source: { select: string; content: (row: Record<string, unknown>) => string },
  options: NgramRebuildOptions,
): Promise<void> {
  const select = db.prepare(source.select);
  const insertBatch = db.transaction((rows: Array<Record<string, unknown>>) => {
    for (const row of rows) replaceItemNgrams(db, kind, String(row.id), source.content(row));
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

function insertTerms(db: SqliteDatabase, kind: SearchItemKind, itemId: string, terms: string[]): void {
  for (let offset = 0; offset < terms.length; offset += INSERT_BATCH_SIZE) {
    const batch = terms.slice(offset, offset + INSERT_BATCH_SIZE);
    const values = batch.map(() => "(?, ?, ?)").join(", ");
    const parameters = batch.flatMap((term) => [term, kind, itemId]);
    db.prepare(`INSERT OR IGNORE INTO search_ngrams (term, item_kind, item_id) VALUES ${values}`)
      .run(...parameters);
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
