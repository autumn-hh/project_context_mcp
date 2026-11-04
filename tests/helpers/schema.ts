import type { SqliteDatabase } from "../../src/storage/database.js";

/**
 * Put back the schema 10 n-gram table. Tests that rewind user_version on a fully migrated
 * database call this first, so the database looks like a real older one to the migrations.
 */
export function restoreSchema10Ngrams(db: SqliteDatabase): void {
  db.exec(`
    DROP VIEW IF EXISTS search_ngrams;
    DROP TABLE IF EXISTS search_terms;
    DROP TABLE IF EXISTS search_items;
    DROP TABLE IF EXISTS legacy_search_ngrams;
    DELETE FROM metadata WHERE key = 'legacy_ngram_cursor';
    CREATE TABLE search_ngrams (
      term TEXT NOT NULL,
      item_kind TEXT NOT NULL,
      item_id TEXT NOT NULL,
      PRIMARY KEY (term, item_kind, item_id)
    ) WITHOUT ROWID;
    CREATE INDEX search_ngrams_item_idx ON search_ngrams(item_kind, item_id);
  `);
}
