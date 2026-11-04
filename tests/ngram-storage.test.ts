import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexProject } from "../src/indexing/indexer.js";
import { doctorProject } from "../src/maintenance/maintenance-service.js";
import {
  convertLegacyNgrams, deleteItemNgrams, isNgramIndexCurrent, matchingNgramItems, replaceItemNgrams,
} from "../src/search/ngram-index.js";
import { openDatabase, type SqliteDatabase } from "../src/storage/database.js";
import { migrateProject } from "../src/storage/schema.js";
import type { ProjectRecord } from "../src/projects/project-service.js";
import { restoreSchema10Ngrams } from "./helpers/schema.js";

describe("integer n-gram storage", () => {
  let root: string;
  let db: SqliteDatabase;
  let project: ProjectRecord;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "context-ngram-storage-"));
    await writeFile(join(root, "guide.md"), "这是用于验证中文子串检索的说明文档。\n", "utf8");
    db = openDatabase(":memory:");
    project = { id: "prj_ngram", rootPath: root } as ProjectRecord;
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  const matches = () => matchingNgramItems(db, "子串检索", 10).map((item) => item.kind);

  it("starts a new database with a current index and finds Han substrings", async () => {
    migrateProject(db);
    expect(isNgramIndexCurrent(db)).toBe(true);
    await indexProject(db, project);
    expect(matches()).toEqual(["chunk"]);
  });

  it("keeps schema 10 rows searchable after the upgrade and converts them on the next index", async () => {
    migrateProject(db);
    await indexProject(db, project);
    const rows = db.prepare("SELECT term, item_kind, item_id FROM search_ngrams ORDER BY term, item_kind, item_id").all();
    restoreSchema10Ngrams(db);
    const insert = db.prepare("INSERT INTO search_ngrams (term, item_kind, item_id) VALUES (?, ?, ?)");
    for (const row of rows as Array<{ term: string; item_kind: string; item_id: string }>) insert.run(row.term, row.item_kind, row.item_id);
    db.pragma("user_version = 10");

    migrateProject(db);
    expect(db.prepare("SELECT type FROM sqlite_master WHERE name = 'search_ngrams'").pluck().get()).toBe("view");
    expect(db.prepare("SELECT COUNT(*) FROM search_terms").pluck().get()).toBe(0);
    expect(isNgramIndexCurrent(db)).toBe(true);
    expect(matches()).toEqual(["chunk"]);
    expect(db.prepare("SELECT term, item_kind, item_id FROM search_ngrams ORDER BY term, item_kind, item_id").all()).toEqual(rows);

    await indexProject(db, project);
    expect(db.prepare("SELECT COUNT(*) FROM legacy_search_ngrams").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM search_terms").pluck().get()).toBe(rows.length);
    expect(matches()).toEqual(["chunk"]);
    expect(db.prepare("SELECT term, item_kind, item_id FROM search_ngrams ORDER BY term, item_kind, item_id").all()).toEqual(rows);
  });

  it("does not convert rows back for items replaced or deleted during the conversion", async () => {
    migrateProject(db);
    restoreSchema10Ngrams(db);
    const insert = db.prepare("INSERT INTO search_ngrams (term, item_kind, item_id) VALUES (?, 'memory', ?)");
    for (const [term, item] of [["一甲", "kept"], ["二乙", "replaced"], ["三丙", "deleted"], ["四丁", "replaced"]]) insert.run(term, item);
    db.pragma("user_version = 10");
    migrateProject(db);
    // A first batch converted terms up to "二乙"; then writers replaced and deleted items.
    db.prepare("INSERT INTO metadata (key, value) VALUES ('legacy_ngram_cursor', '')").run();
    db.prepare("INSERT INTO search_items (kind, item_id) VALUES ('memory', 'kept'), ('memory', 'replaced')").run();
    db.prepare(`INSERT INTO search_terms (term, item) SELECT '一甲', id FROM search_items WHERE item_id = 'kept'
      UNION ALL SELECT '二乙', id FROM search_items WHERE item_id = 'replaced'`).run();
    db.prepare("DELETE FROM legacy_search_ngrams WHERE term <= '二乙'").run();
    db.prepare("UPDATE metadata SET value = '二乙' WHERE key = 'legacy_ngram_cursor'").run();
    replaceItemNgrams(db, "memory", "replaced", "新内容");
    deleteItemNgrams(db, "memory", "deleted");

    await convertLegacyNgrams(db);
    expect(db.prepare("SELECT item_id, term FROM search_ngrams ORDER BY item_id, term").all()).toEqual([
      { item_id: "kept", term: "一甲" },
      { item_id: "replaced", term: "内容" },
      { item_id: "replaced", term: "新内" },
      { item_id: "replaced", term: "新内容" },
    ]);
  });

  it("reports a pending conversion and finishes it when asked to repair", async () => {
    migrateProject(db);
    await indexProject(db, project);
    const rows = db.prepare("SELECT term, item_kind, item_id FROM search_ngrams").all() as Array<{ term: string; item_kind: string; item_id: string }>;
    restoreSchema10Ngrams(db);
    const insert = db.prepare("INSERT INTO search_ngrams (term, item_kind, item_id) VALUES (?, ?, ?)");
    for (const row of rows) insert.run(row.term, row.item_kind, row.item_id);
    db.pragma("user_version = 10");
    migrateProject(db);

    expect((await doctorProject(db, project, false)).issues).toEqual([expect.stringContaining("Schema 10 search rows")]);
    const repaired = await doctorProject(db, project, true);
    expect(repaired).toMatchObject({ ok: true, repaired: ["Converted the remaining schema 10 search rows."] });
    expect(db.prepare("SELECT COUNT(*) FROM legacy_search_ngrams").pluck().get()).toBe(0);
    expect(matches()).toEqual(["chunk"]);
  });

  it("lets older clients keep reading and writing through the search_ngrams view", async () => {
    migrateProject(db);
    db.prepare("INSERT OR IGNORE INTO search_ngrams (term, item_kind, item_id) VALUES (?, 'memory', 'mem_old')").run("旧版");
    db.prepare("INSERT OR IGNORE INTO search_ngrams (term, item_kind, item_id) VALUES (?, 'memory', 'mem_old')").run("旧版");
    expect(db.prepare("SELECT term, item_kind, item_id FROM search_ngrams").all())
      .toEqual([{ term: "旧版", item_kind: "memory", item_id: "mem_old" }]);
    db.prepare("DELETE FROM search_ngrams WHERE item_kind = 'memory' AND item_id = 'mem_old'").run();
    expect(db.prepare("SELECT (SELECT COUNT(*) FROM search_terms) + (SELECT COUNT(*) FROM search_items)").pluck().get()).toBe(0);
  });
});
