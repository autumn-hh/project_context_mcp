import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { openDatabase, type SqliteDatabase } from "../src/storage/database.js";
import { migrateProject, migrateRegistry } from "../src/storage/schema.js";
import { remember, detectMemoryDrift } from "../src/memory/memory-service.js";
import { UserMemoryService } from "../src/memory/user-memory-service.js";
import { checkpointTask, startTask, completeTask, listTaskHistory } from "../src/tasks/task-service.js";
import { exportKnowledgePack, inspectKnowledgePack, restoreKnowledgePack } from "../src/storage/remote-pack/pack.js";
import { PACK_MAGIC, PACK_LIMITS } from "../src/storage/remote-pack/schema.js";

describe("knowledge snapshot packages", () => {
  let root: string; let db: SqliteDatabase; let registry: SqliteDatabase; let rules: UserMemoryService;
  const project = { id: "prj_source", name: "知识项目" };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "context-pack-test-"));
    db = openDatabase(join(root, "source.db")); migrateProject(db);
    registry = openDatabase(join(root, "registry.db")); migrateRegistry(registry);
    rules = new UserMemoryService(root);
  });
  afterEach(async () => { db.close(); registry.close(); rules.close(); await rm(root, { recursive: true, force: true }); });
  const encode = (manifest: any, body: Buffer) => {
    const json = Buffer.from(JSON.stringify(manifest)); const size = Buffer.alloc(4); size.writeUInt32BE(json.length);
    return Buffer.concat([PACK_MAGIC, size, json, body]);
  };
  async function pack() {
    const path = join(root, "knowledge.pcmp");
    await exportKnowledgePack({ db, project, destination: path, allowedRoots: [root] });
    return path;
  }
  async function rewrite(path: string, change: (manifest: any, body: Buffer) => Buffer | void) {
    const bytes = await readFile(path); const length = bytes.readUInt32BE(PACK_MAGIC.length);
    const manifest = JSON.parse(bytes.subarray(13, 13 + length).toString());
    const body = bytes.subarray(13 + length);
    const replacement = change(manifest, body);
    await writeFile(path, encode(manifest, replacement ?? body));
  }

  it("round-trips replacements, provenance, history and receipts without exporting code or implicit rules", async () => {
    const old = remember(db, { type: "decision", title: "原方案", content: "旧内容", sourceKind: "user" });
    const current = remember(db, { type: "decision", title: "新方案", content: "选择明确可恢复的包格式", sourceKind: "user", supersedesId: old.id });
    const task = startTask(db, "同步开发");
    const checkpoint = { ...task.checkpoint, summary: "已完成包格式", completed: ["导出", "恢复"] };
    checkpointTask(db, task.id, checkpoint, { requestId: "device-a:1" }); completeTask(db, task.id);
    db.prepare("INSERT INTO sources VALUES ('src', 'index.ts', 'code', 'hash', 12, 0, ?)").run(new Date().toISOString());
    db.prepare("INSERT INTO chunks VALUES ('chunk', 'src', 'index.ts', 'SOURCE_ONLY_SENTINEL', 1, 1)").run();
    db.prepare("UPDATE memory_sources SET source_id = 'src', source_hash = 'hash', source_excerpt = 'EXCERPT_ONLY_SENTINEL'").run();
    rules.remember({ type: "preference", title: "个人规则", content: "PERSONAL_ONLY_SENTINEL", sourceKind: "user" });
    const path = await pack(); const bytes = await readFile(path);
    for (const sentinel of ["SOURCE_ONLY_SENTINEL", "EXCERPT_ONLY_SENTINEL", "PERSONAL_ONLY_SENTINEL"]) expect(bytes.includes(Buffer.from(sentinel))).toBe(false);
    expect(await inspectKnowledgePack(path, [root])).toMatchObject({ policy: { codeIndex: false, sourceExcerpts: false } });
    const restored = await restoreKnowledgePack(path, join(root, "restored"), [root]);
    const copy = openDatabase(restored.projectDatabase);
    try {
      expect(copy.prepare("SELECT id, supersedes_id FROM memories WHERE status='active'").get()).toEqual({ id: current.id, supersedes_id: old.id });
      expect(copy.prepare("SELECT source_id, source_hash FROM memory_sources LIMIT 1").get()).toEqual({ source_id: null, source_hash: "hash" });
      expect(listTaskHistory(copy, task.id).items).toEqual(listTaskHistory(db, task.id).items);
      expect(checkpointTask(copy, task.id, checkpoint, { requestId: "device-a:1" }).status).toBe("completed");
      expect(copy.prepare("SELECT COUNT(*) FROM chunks").pluck().get()).toBe(0);
      expect(copy.prepare("SELECT COUNT(*) FROM memories_fts").pluck().get()).toBe(2);
      expect(copy.prepare("SELECT COUNT(*) FROM search_ngrams").pluck().get()).toBeGreaterThan(0);
      expect(copy.pragma("foreign_key_check")).toEqual([]);
    } finally { copy.close(); }
    expect(restored.rulesApplied).toBe(false);
  });

  it("exports only selected rules and replacement ancestors, staged without applying personal scopes", async () => {
    const old = rules.remember({ type: "constraint", title: "旧规则", content: "规则一", sourceKind: "user", scopeLevel: "project", projectId: project.id });
    const current = rules.remember({ type: "constraint", title: "新规则", content: "规则二", sourceKind: "user", scopeLevel: "project", projectId: project.id, supersedesId: old.id });
    rules.remember({ type: "preference", title: "私有", content: "不选择", sourceKind: "user" });
    const path = join(root, "rules.pcmp");
    await exportKnowledgePack({ db, registry, project, destination: path, allowedRoots: [root], userMemoryIds: [current.id] });
    const result = await restoreKnowledgePack(path, join(root, "restored"), [root]);
    const restored = openDatabase(result.rulesDatabase);
    try { expect(restored.prepare("SELECT id FROM user_memories ORDER BY id").pluck().all()).toEqual([old.id, current.id].sort()); }
    finally { restored.close(); }
    const other = rules.remember({ type: "fact", title: "其他项目", content: "不共享", sourceKind: "user", scopeLevel: "project", projectId: "prj_other" });
    await expect(exportKnowledgePack({ db, registry, project, destination: join(root, "bad.pcmp"), allowedRoots: [root], userMemoryIds: [other.id] }))
      .rejects.toMatchObject({ code: "INVALID_REMOTE_PACK" });
    expect(await readdir(root)).not.toContain("bad.pcmp");
  });

  it("reattaches imported file provenance after indexing without hiding content drift", async () => {
    const timestamp = new Date().toISOString();
    db.prepare("INSERT INTO sources VALUES ('original', 'notes.md', 'text', 'original-hash', 12, 0, ?)").run(timestamp);
    const memory = remember(db, { type: "decision", title: "File fact", content: "Useful knowledge", sourceKind: "file", sourceRef: "notes.md" });
    const path = await pack();
    for (const [folder, hash] of [["matching", "original-hash"], ["changed", "new-hash"]]) {
      const restored = await restoreKnowledgePack(path, join(root, folder), [root]);
      const copy = openDatabase(restored.projectDatabase);
      try {
        copy.prepare("INSERT INTO sources VALUES ('local', 'notes.md', 'text', ?, 12, 0, ?)").run(hash, timestamp);
        expect(detectMemoryDrift(copy)).toEqual(hash === "original-hash" ? [] : [memory.id]);
        expect(copy.prepare("SELECT source_id FROM memory_sources").pluck().get()).toBe("local");
      } finally { copy.close(); }
    }
  });

  it.each(["version", "schema", "table", "checksum", "rows", "unknown"])("rejects invalid %s before publishing restore", async mutation => {
    remember(db, { type: "fact", title: "Test", content: "One row", sourceKind: "user" });
    const path = await pack();
    await rewrite(path, manifest => {
      if (mutation === "version") manifest.version = 999;
      if (mutation === "schema") manifest.schemaVersion = 999;
      if (mutation === "table") manifest.shards[0].table = "../../registry";
      if (mutation === "checksum") manifest.shards[0].sha256 = "0".repeat(64);
      if (mutation === "rows") manifest.shards[0].rows++;
      if (mutation === "unknown") manifest.executable = "anything";
    });
    await expect(restoreKnowledgePack(path, join(root, "restored"), [root])).rejects.toMatchObject({ code: "INVALID_REMOTE_PACK" });
    expect((await readdir(root)).filter(name => name.startsWith(".remote-") || name === "restored")).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) FROM memories").pluck().get()).toBe(1);
  });

  it("rejects invalid record fields even with a recomputed checksum", async () => {
    remember(db, { type: "fact", title: "Test", content: "One row", sourceKind: "user" });
    const path = await pack();
    await rewrite(path, (manifest, body) => {
      const shard = manifest.shards[0]; const row = JSON.parse(body.subarray(0, shard.bytes).toString());
      row.confidence = 9; const replacement = Buffer.from(JSON.stringify(row) + "\n");
      const next = Buffer.concat([replacement, body.subarray(shard.bytes)]);
      shard.bytes = replacement.length; shard.sha256 = createHash("sha256").update(replacement).digest("hex");
      return next;
    });
    await expect(inspectKnowledgePack(path, [root])).rejects.toMatchObject({ code: "INVALID_REMOTE_PACK" });
  });

  it("rejects missing references transactionally and leaves existing destinations intact", async () => {
    remember(db, { type: "fact", title: "Test", content: "One row", sourceKind: "user" });
    const path = await pack(); const original = await readFile(path);
    await expect(exportKnowledgePack({ db, project, destination: path, allowedRoots: [root] })).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path)).toEqual(original);
    await mkdir(join(root, "existing")); await writeFile(join(root, "existing", "keep"), "unchanged");
    await expect(restoreKnowledgePack(path, join(root, "existing"), [root])).rejects.toMatchObject({ code: "PACK_RESTORE_FAILED" });
    expect(await readFile(join(root, "existing", "keep"), "utf8")).toBe("unchanged");
    await rewrite(path, (manifest, body) => { const first = manifest.shards.shift(); return body.subarray(first.bytes); });
    await expect(restoreKnowledgePack(path, join(root, "failed"), [root])).rejects.toMatchObject({ code: "PACK_RESTORE_FAILED" });
    expect(await readdir(root)).not.toContain("failed");
  });

  it("rejects truncation, trailing bytes, oversized headers and unauthorized paths", async () => {
    const path = await pack(); const original = await readFile(path);
    for (const bytes of [original.subarray(0, 8), Buffer.concat([original, Buffer.from("x")])]) {
      await writeFile(path, bytes); await expect(inspectKnowledgePack(path, [root])).rejects.toMatchObject({ code: "INVALID_REMOTE_PACK" });
    }
    const prefix = Buffer.alloc(13); PACK_MAGIC.copy(prefix); prefix.writeUInt32BE(PACK_LIMITS.manifest + 1, 9);
    await writeFile(path, prefix); await expect(inspectKnowledgePack(path, [root])).rejects.toMatchObject({ code: "INVALID_REMOTE_PACK" });
    await expect(inspectKnowledgePack(path, [join(root, "other")])).rejects.toMatchObject({ code: "PACK_SOURCE_NOT_AUTHORIZED" });
    await expect(exportKnowledgePack({ db, project, destination: "relative.pcmp", allowedRoots: [root] })).rejects.toMatchObject({ code: "INVALID_OUTPUT_PATH" });
  });

  it("splits large logical tables into bounded shards and rejects oversized records", async () => {
    const template = startTask(db, "large task");
    const insert = db.prepare("INSERT INTO tasks (id,goal,status,checkpoint_json,created_at,updated_at,completed_at) VALUES (?,?,?,?,?,?,?)");
    const payload = JSON.stringify({ ...template.checkpoint, summary: "A".repeat(3 * 1024 * 1024) });
    for (let index = 0; index < 6; index++) insert.run(`large-${index}`, "Large checkpoint", "in_progress", payload, template.createdAt, template.updatedAt, null);
    const path = await pack();
    const manifest = await inspectKnowledgePack(path, [root]);
    expect(manifest.shards.filter(shard => shard.table === "tasks").length).toBeGreaterThan(1);
    expect(manifest.shards.every(shard => shard.bytes <= PACK_LIMITS.shard)).toBe(true);
    db.prepare("UPDATE tasks SET checkpoint_json = ? WHERE id = ?").run(JSON.stringify({ ...template.checkpoint, summary: "B".repeat(PACK_LIMITS.row) }), template.id);
    await expect(exportKnowledgePack({ db, project, destination: join(root, "too-large.pcmp"), allowedRoots: [root] }))
      .rejects.toMatchObject({ code: "INVALID_REMOTE_PACK" });
    expect(await readdir(root)).not.toContain("too-large.pcmp");
  });
});
