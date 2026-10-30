import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateProject } from "../src/storage/schema.js";
import { remember, listMemories, type MemoryRecord } from "../src/memory/memory-service.js";
import { buildProjectContext } from "../src/context/context-service.js";
import { replaceItemNgrams } from "../src/search/ngram-index.js";
import type { ProjectRecord } from "../src/projects/project-service.js";
import { recallMemories } from "../src/memory/recall-service.js";

const project: ProjectRecord = {
  id: "prj_fixture", name: "Memory fixture", rootPath: "/fixture", remoteUrl: null,
  createdAt: "", updatedAt: "", lastOpenedAt: "", archivedAt: null,
};

describe("local memory context recall", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrateProject(db);
  });
  afterEach(() => db.close());

  function memory(input: Partial<Parameters<typeof remember>[1]> = {}): MemoryRecord {
    return remember(db, {
      type: "decision", title: "Backup retention", content: "Database backup retention is seven days.",
      sourceKind: "user", ...input,
    });
  }

  function bury(item: MemoryRecord): void {
    db.prepare("UPDATE memories SET updated_at = '2000-01-01' WHERE id = ?").run(item.id);
    for (let i = 0; i < 80; i += 1) {
      memory({ title: `Typography ${i}`, content: `Fonts use a scale of ${i + 10} points.` });
    }
  }

  function chunk(id: string, path: string, content: string): void {
    db.prepare("INSERT OR IGNORE INTO sources VALUES (?, ?, 'file', 'hash', 1, 0, '')").run(path, path);
    db.prepare("INSERT INTO chunks VALUES (?, ?, ?, ?, 1, 1)").run(id, path, path, content);
    db.prepare("INSERT INTO chunks_fts VALUES (?, ?, ?)").run(id, path, content);
    replaceItemNgrams(db, "chunk", id, `${path}\n${content}`);
  }

  it("recalls an old decision despite matching code filling the mixed search quota", () => {
    const expected = memory();
    bury(expected);
    for (let i = 0; i < 120; i += 1) {
      chunk(`chunk_${i.toString().padStart(3, "0")}`, `src/backup${i}.ts`,
        "Database backup retention config implementation");
    }
    const context = buildProjectContext(db, project, "database backup retention");
    expect(context.decisions.map((item) => item.id)).toContain(expected.id);
    expect(context.budget.usedTokens).toBeLessThanOrEqual(3_000);
  });

  it("recalls an old Chinese decision from a conversational question", () => {
    const expected = memory({ title: "数据库备份保留期", content: "数据库备份保存七天，每天创建一个快照。" });
    bury(expected);
    const context = buildProjectContext(db, project, "请帮我查一下我们之前关于数据库备份保存多久的决定是什么");
    expect(context.decisions.map((item) => item.id)).toContain(expected.id);
    expect(context.decisions.every((item) => !item.title.startsWith("Typography"))).toBe(true);
  });

  it("continues past a candidate page full of memories from another module", () => {
    const expected = memory({ scope: ["src/auth.ts"] });
    bury(expected);
    for (let i = 0; i < 150; i += 1) memory({ scope: ["src/images.ts"] });
    const context = buildProjectContext(db, project, "backup retention src/auth.ts", 20_000);
    expect(context.decisions.map((item) => item.id)).toEqual([expected.id]);
    expect(JSON.stringify(context)).not.toContain("src/images.ts");
  });

  it("does not repeat structured knowledge in generic search hits", () => {
    const expected = memory();
    const context = buildProjectContext(db, project, "backup retention", 20_000);
    expect(context.decisions.map((item) => item.id)).toContain(expected.id);
    expect(context.relevant.filter((item) => item.id === expected.id)).toEqual([]);
  });

  it("groups identical conclusions while retaining their sources and stored records", () => {
    const first = memory({ sourceRef: "meeting:one" });
    const second = memory({ sourceRef: "meeting:two" });
    const context = buildProjectContext(db, project, "backup retention", 20_000);
    expect(context.decisions).toHaveLength(1);
    const chosen = context.decisions[0]!;
    const other = chosen.id === first.id ? second : first;
    expect(chosen).toMatchObject({
      supportingMemories: [{ id: other.id, sourceKind: "user", sourceRef: other.sourceRef }],
    });
    expect(listMemories(db)).toHaveLength(2);
  });

  it("keeps different numbers, negations, reasons, types, and scopes separate", () => {
    memory();
    memory({ content: "Database backup retention is thirty days." });
    memory({ content: "Database backup retention is not seven days." });
    memory({ reason: "Temporary exception during migration." });
    memory({ type: "assumption" });
    memory({ scope: ["src/backup.ts"] });
    const context = buildProjectContext(db, project, "backup retention src/backup.ts", 20_000);
    expect(context.decisions).toHaveLength(5);
    expect(context.relevant.filter((item) => item.kind === "memory")).toHaveLength(1);
  });

  it("excludes an unrelated scoped memory from all context sections", () => {
    const wrong = memory({ scope: ["src/images.ts"], sourceRef: "src/images.ts" });
    const context = buildProjectContext(db, project, "backup retention", 20_000);
    expect(JSON.stringify(context)).not.toContain(wrong.id);
  });

  it("matches directory scope to a source descendant but not a sibling prefix", () => {
    const right = memory({ scope: ["src/storage"] });
    const wrong = memory({ scope: ["src/store"] });
    chunk("chunk_storage", "src/storage/backup.ts", "snapshotExpiry retention workflow");
    const context = buildProjectContext(db, project, "snapshotExpiry retention", 20_000);
    expect(context.decisions.map((item) => item.id)).toContain(right.id);
    expect(JSON.stringify(context)).not.toContain(wrong.id);
  });

  it("uses path boundaries for explicit targets before trying fuzzy scope words", () => {
    const scoped = memory({ scope: ["src/storage"] });
    expect(buildProjectContext(db, project, "backup retention src/storage/backup.ts").decisions.map((item) => item.id))
      .toContain(scoped.id);
    expect(JSON.stringify(buildProjectContext(db, project, "backup retention src/storagex/backup.ts")))
      .not.toContain(scoped.id);
    expect(JSON.stringify(buildProjectContext(db, project, "backup retention src/storage-old/backup.ts")))
      .not.toContain(scoped.id);
  });

  it("reports relevant stale/conflicted IDs without returning their conclusions as knowledge", () => {
    const stale = memory({ status: "stale" });
    const conflict = memory({ status: "conflicted" });
    memory({ status: "stale", title: "Fonts", content: "Typography scale changed." });
    const context = buildProjectContext(db, project, "backup retention", 20_000);
    expect(context.decisions).toEqual([]);
    expect(context.relevant.filter((item) => item.kind === "memory")).toEqual([]);
    expect(context.warnings.join(" ")).toContain(stale.id);
    expect(context.warnings.join(" ")).toContain(conflict.id);
    expect(context.warnings.join(" ")).not.toContain("Typography");
  });

  it("keeps identical short conclusions under different subjects separate", () => {
    memory({ title: "Backup retention", content: "Must retain seven days." });
    memory({ title: "Audit logs retention", content: "Must retain seven days." });
    const context = buildProjectContext(db, project, "backup audit retention", 20_000);
    expect(context.decisions).toHaveLength(2);
  });

  it("recovers a scoped task summary by explicit task ID and hides it otherwise", () => {
    const summary = memory({
      type: "task-summary", title: "Auth rollout", content: "Authentication rollout completed.",
      sourceKind: "tool", sourceRef: "task:task_auth", scope: ["src/auth.ts"],
    });
    expect(buildProjectContext(db, project, "回顾任务 task_auth").lessons.map((item) => item.id)).toEqual([summary.id]);
    expect(JSON.stringify(buildProjectContext(db, project, "Authentication rollout"))).not.toContain(summary.id);
    expect(JSON.stringify(buildProjectContext(db, project, "回顾任务 task_other"))).not.toContain(summary.id);
  });

  it("filters inactive records and summaries before recall quotas and never changes their status", () => {
    const expected = memory({ title: "备份保存期", content: "数据库备份保存七天。" });
    const states = ["candidate", "stale", "conflicted", "superseded", "rejected", "deleted"] as const;
    for (let i = 0; i < 160; i += 1) {
      memory({ title: "备份保存期", content: "数据库备份保存七天。", status: states[i % states.length] });
      memory({ title: "备份保存期", content: "数据库备份保存七天。", type: "task-summary" });
    }
    expect(recallMemories(db, "请问数据库备份保存多久").map((item) => item.memory.id)).toEqual([expected.id]);
    expect(listMemories(db, "candidate", 500)).toHaveLength(27);
    expect(recallMemories(db, "", { limit: 0 })).toEqual([]);
    expect(recallMemories(db, "备份", { limit: Number.NaN })).toEqual([]);
  });

  it("recalls old facts, preferences and assumptions with explicit type and source metadata", () => {
    const records = ["fact", "preference", "assumption"].map((type) => memory({
      type: type as MemoryRecord["type"], sourceRef: "meeting:fixture",
    }));
    for (const item of records) bury(item);
    const context = buildProjectContext(db, project, "backup retention", 20_000);
    expect(context.relevant.map((item) => item.id).sort()).toEqual(records.map((item) => item.id).sort());
    expect(context.relevant.map((item) => item.memoryType).sort()).toEqual(["assumption", "fact", "preference"]);
    expect(context.relevant.every((item) => item.source === "meeting:fixture" && item.sourceKind === "user")).toBe(true);
  });

  it("fits duplicate evidence into the budget without changing the database or confidence", () => {
    for (let i = 0; i < 30; i += 1) memory({ sourceRef: `meeting:${i}`, confidence: 0.5 });
    const full = buildProjectContext(db, project, "backup retention", 20_000);
    expect(full.decisions[0]!.supportingMemories).toHaveLength(29);
    const small = buildProjectContext(db, project, "backup retention", 500);
    expect(small.budget.usedTokens).toBeLessThanOrEqual(500);
    expect(small.budget.truncated).toBe(true);
    expect(small.decisions[0]).toMatchObject({ confidence: 0.5, content: "Database backup retention is seven days." });
    expect(listMemories(db, "active", 100)).toHaveLength(30);
  });

  it("does not inject unrelated knowledge merely because it shares source and scope", () => {
    memory({ sourceRef: "meeting:retention", scope: ["src/storage"] });
    const neighbor = memory({
      title: "Deletion approval", content: "Owners must approve erasure.", sourceRef: "meeting:retention",
      scope: ["src/storage"],
    });
    bury(neighbor);
    memory({ title: "Image approval", content: "Owners must approve thumbnails.", sourceRef: "meeting:retention", scope: ["src/images"] });
    const context = buildProjectContext(db, project, "backup retention src/storage/backup.ts", 20_000);
    expect(context.decisions.find((item) => item.id === neighbor.id)).toBeUndefined();
    expect(JSON.stringify(context)).not.toContain("Image approval");
    expect(context.relevant.some((item) => item.id === neighbor.id)).toBe(false);
    const limited = buildProjectContext(db, project, "backup retention src/storage/backup.ts", 500);
    expect(limited.budget.usedTokens).toBeLessThanOrEqual(500);
  });

  it("does not use shared scope or missing provenance to invent a memory relation", () => {
    memory({ scope: ["src/storage"] });
    const unrelated = memory({
      title: "Deletion approval", content: "Owners must approve erasure.", scope: ["src/storage"],
    });
    bury(unrelated);
    const context = buildProjectContext(db, project, "backup retention src/storage/backup.ts", 20_000);
    expect(JSON.stringify(context)).not.toContain(unrelated.id);
  });

  it("adds explainable content neighbors from different sources only when the task also matches", () => {
    const seed = memory({ title: "refreshToken", content: "Replay prevention preserves token families.", scope: ["src/auth"] });
    const peer = memory({ title: "Refresh policy", content: "Refresh token families enforce replay prevention.", scope: ["src/auth"] });
    const context = buildProjectContext(db, project,
      "please carefully investigate how refreshToken behaves whenever authorization credentials become invalid during concurrent application sessions src/auth/index.ts", 3_000);
    const selected = context.decisions.find((item) => item.id === peer.id);
    expect(selected?.graphRecall).toMatchObject({
      relation: "content-related", possiblyRelated: true, fromMemoryId: seed.id,
      viaNodeId: `memory:${seed.id}`, sharedTerms: expect.arrayContaining(["prevention", "families"]),
      excerpts: { source: expect.stringContaining(seed.content), target: expect.stringContaining(peer.content) },
    });
    expect(context.budget.usedTokens).toBeLessThanOrEqual(3_000);
    expect(listMemories(db)).toHaveLength(2);
  });
});
