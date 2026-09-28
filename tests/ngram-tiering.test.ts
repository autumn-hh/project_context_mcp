import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateProject } from "../src/storage/schema.js";
import {
  isNgramIndexCurrent,
  matchingNgramItems,
  rebuildNgramIndex,
  rebuildNgramIndexIfNeeded,
  replaceItemNgrams,
} from "../src/search/ngram-index.js";

describe("tiered ngram rebuild", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrateProject(db);
  });

  afterEach(() => db.close());

  function addSource(id: string, path: string): void {
    db.prepare("INSERT INTO sources VALUES (?, ?, 'code', 'hash', 100, 0, 'now')").run(id, path);
    db.prepare("INSERT INTO chunks VALUES (?, ?, ?, ?, 1, 1)")
      .run(id, id, path, "gradingCalculator 实验评分");
    db.prepare("INSERT INTO chunks_fts (chunk_id, source_path, content) VALUES (?, ?, ?)")
      .run(id, path, "gradingCalculator 实验评分");
    // Simulate symbols left by an older indexer before tiering was introduced.
    db.prepare("INSERT INTO symbols VALUES (?, ?, ?, 'gradingCalculator', 'gradingCalculator', 'function', NULL, 1, 1, 'hash')")
      .run(id, id, path);
    replaceItemNgrams(db, "chunk", id, "gradingCalculator 实验评分");
    replaceItemNgrams(db, "symbol", id, "gradingCalculator");
  }

  it("removes old low-relevance ngrams while keeping FTS, business recall and memory recall", async () => {
    addSource("business", "src/grading.ts");
    for (const [index, path] of [
      "static/copy.js", "src/plugins/copy.ts", "src/vendor/copy.ts",
      "src/icons/icon.svg", "src/copy.min.js", "src\\ASSETS\\copy.ts",
    ].entries()) addSource(`low-${index}`, path);
    db.prepare(`INSERT INTO memories
      (id, type, title, content, status, confidence, scope_json, source_kind, created_at, updated_at)
      VALUES ('memory', 'decision', 'gradingCalculator', '实验评分', 'active', 1, '{}', 'user', 'now', 'now')`).run();
    db.prepare("DELETE FROM metadata WHERE key = 'ngram_schema_version'").run();

    expect(await rebuildNgramIndexIfNeeded(db)).toBe(true);
    expect(isNgramIndexCurrent(db)).toBe(true);
    expect(db.prepare("SELECT COUNT(*) FROM search_ngrams WHERE item_id LIKE 'low-%'").pluck().get()).toBe(0);
    expect(matchingNgramItems(db, "gradingCalc", 20).map(({ kind, id }) => `${kind}:${id}`))
      .toEqual(expect.arrayContaining(["chunk:business", "symbol:business", "memory:memory"]));
    expect(matchingNgramItems(db, "实验", 20).map(({ kind, id }) => `${kind}:${id}`))
      .toEqual(expect.arrayContaining(["chunk:business", "memory:memory"]));
    expect(db.prepare("SELECT COUNT(*) FROM chunks_fts WHERE chunks_fts MATCH 'gradingCalc*'").pluck().get()).toBe(7);
    expect(await rebuildNgramIndexIfNeeded(db)).toBe(false);

    await rebuildNgramIndex(db);
    expect(db.prepare("SELECT COUNT(*) FROM search_ngrams WHERE item_id LIKE 'low-%'").pluck().get()).toBe(0);
  });

  it("continues past a whole excluded batch to later business rows", async () => {
    for (let index = 0; index < 30; index += 1) {
      addSource(`a-${String(index).padStart(2, "0")}`, `static/copy-${index}.js`);
    }
    addSource("z-business", "src/business.ts");
    await rebuildNgramIndex(db);
    expect(matchingNgramItems(db, "gradingCalc", 20).map(({ id }) => id))
      .toEqual(["z-business", "z-business"]);
  });

  it("does not mark an interrupted rebuild current and allows retry", async () => {
    addSource("business", "src/business.ts");
    const controller = new AbortController();
    await expect(rebuildNgramIndex(db, {
      signal: controller.signal,
      onBatch: () => controller.abort(),
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(isNgramIndexCurrent(db)).toBe(false);
    expect(await rebuildNgramIndexIfNeeded(db)).toBe(true);
    expect(matchingNgramItems(db, "实验", 20)).toEqual([
      expect.objectContaining({ kind: "chunk", id: "business" }),
    ]);
  });
});
