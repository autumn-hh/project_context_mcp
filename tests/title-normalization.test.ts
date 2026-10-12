import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type SqliteDatabase } from "../src/storage/database.js";
import { migrateProject } from "../src/storage/schema.js";
import { remember } from "../src/memory/memory-service.js";
import { normalizeTaskSummaryTitles, previewTaskSummaryTitles } from "../src/memory/title-normalization.js";
import { searchProject } from "../src/search/search-service.js";

describe("legacy task summary title normalization", () => {
  let db: SqliteDatabase;
  beforeEach(() => { db = openDatabase(":memory:"); migrateProject(db); });
  afterEach(() => db.close());

  function summary(title = "Review task-summary from task: old work", status: "active" | "stale" = "active") {
    return remember(db, { type: "task-summary", title, status,
      content: "- 持久化邻居查询已完成。\n完整内容保持不变。", sourceKind: "tool", sourceRef: "task:task_legacy" });
  }

  it("previews without writes and changes only titles while refreshing search indexes", () => {
    const old = summary();
    const stable = summary("Stable existing title");
    const stale = summary("Review task-summary from task: obsolete", "stale");
    const before = db.prepare("SELECT * FROM memories ORDER BY id").all() as Array<Record<string, unknown>>;
    const sources = db.prepare("SELECT * FROM memory_sources ORDER BY id").all();
    const preview = previewTaskSummaryTitles(db);
    expect(preview.changes).toEqual([{ id: old.id, oldTitle: old.title, newTitle: "持久化邻居查询已完成。" }]);
    expect(db.prepare("SELECT * FROM memories ORDER BY id").all()).toEqual(before);
    expect(normalizeTaskSummaryTitles(db, preview.previewHash).changed).toBe(1);
    const after = db.prepare("SELECT * FROM memories ORDER BY id").all() as Array<Record<string, unknown>>;
    expect(after).toEqual(before.map((row) => row.id === old.id ? { ...row, title: "持久化邻居查询已完成。" } : row));
    expect(db.prepare("SELECT * FROM memory_sources ORDER BY id").all()).toEqual(sources);
    expect(searchProject(db, "持久化邻居", 5)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: old.id, title: "持久化邻居查询已完成。" }),
    ]));
    expect(db.prepare("SELECT title FROM memories_fts WHERE memory_id = ?").pluck().get(old.id)).toBe("持久化邻居查询已完成。");
    expect(previewTaskSummaryTitles(db).changes).toEqual([]);
    expect([stable.id, stale.id]).toHaveLength(2);
  });

  it("rejects stale previews and rolls back cancelled work including derived search rows", () => {
    summary();
    const preview = previewTaskSummaryTitles(db);
    summary("Review task-summary from task: new work");
    expect(() => normalizeTaskSummaryTitles(db, preview.previewHash)).toThrow(/Preview again/u);
    const fresh = previewTaskSummaryTitles(db);
    const snapshot = ["memories", "memory_sources", "memories_fts", "search_ngrams"].map((table) =>
      db.prepare(`SELECT * FROM ${table}`).all());
    const controller = new AbortController();
    controller.abort();
    expect(() => normalizeTaskSummaryTitles(db, fresh.previewHash, { signal: controller.signal })).toThrow(/cancelled/u);
    let reads = 0;
    const signal = { get aborted() { reads += 1; return reads >= 3; } } as AbortSignal;
    expect(() => normalizeTaskSummaryTitles(db, fresh.previewHash, { signal })).toThrow(/cancelled/u);
    expect(["memories", "memory_sources", "memories_fts", "search_ngrams"].map((table) =>
      db.prepare(`SELECT * FROM ${table}`).all())).toEqual(snapshot);
  });
});
