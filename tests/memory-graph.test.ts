import Database from "better-sqlite3";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { migrateProject } from "../src/storage/schema.js";
import { remember, updateMemoryStatus, type MemoryRecord } from "../src/memory/memory-service.js";
import { startTask, checkpointTask } from "../src/tasks/task-service.js";
import { memoryGraph, memoryGraphNode, relatedGraphMemories } from "../src/memory/graph-service.js";

describe("derived local memory graph", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrateProject(db);
  });
  afterEach(() => db.close());

  function memory(input: Partial<Parameters<typeof remember>[1]> = {}): MemoryRecord {
    return remember(db, {
      type: "decision", title: "备份保留策略", content: "备份保留七天。", sourceKind: "user", ...input,
    });
  }
  function source(path = "docs/storage.md"): void {
    db.prepare("INSERT INTO sources VALUES (?,?,'file','current-hash',100,0,'')").run(path, path);
    db.prepare("INSERT INTO chunks VALUES (?,?,?, ?,1,5)")
      .run(path, path, path, "Backup storage.\nRetain seven days.\n\nRestore testing.\nTest monthly.");
  }
  function node(id: string): string { return `memory:${id}`; }

  it("shows explicit provenance, real tasks, scopes and superseding history without writing records", () => {
    source();
    const task = startTask(db, "备份存储改造");
    const older = memory({ sourceKind: "file", sourceRef: "docs/storage.md:1-2" });
    const current = memory({
      sourceKind: "file", sourceRef: "docs/storage.md:1-2", scope: ["src/storage"], supersedesId: older.id,
    });
    memory({ type: "constraint", sourceKind: "tool", sourceRef: `task:${task.id}` });
    const changes = db.prepare("SELECT total_changes() AS count").get();
    const graph = memoryGraph(db, { includeInactive: true, limit: 100 });
    expect(new Set(graph.nodes.map((item) => item.nodeType))).toEqual(new Set(["memory", "source", "task", "scope"]));
    expect(new Set(graph.edges.map((item) => item.relationType)))
      .toEqual(new Set(["SOURCED_FROM", "PRODUCED_BY", "APPLIES_TO", "SUPERSEDES"]));
    expect(graph.edges).toContainEqual(expect.objectContaining({
      source: node(current.id), target: node(older.id), relationType: "SUPERSEDES",
    }));
    expect(graph.edges.every((edge) => edge.evidence.length > 0)).toBe(true);
    expect(db.prepare("SELECT total_changes() AS count").get()).toEqual(changes);
  });

  it("excludes unreviewed/deleted/rejected memories and gates historical nodes", () => {
    const active = memory();
    const historic = ["stale", "conflicted", "superseded"].map((status) => memory({ status: status as MemoryRecord["status"] }));
    const hidden = ["candidate", "rejected", "deleted"].map((status) => memory({ status: status as MemoryRecord["status"] }));
    const current = memoryGraph(db);
    expect(current.nodes.filter((item) => item.nodeType === "memory").map((item) => item.id)).toEqual([node(active.id)]);
    const history = memoryGraph(db, { includeInactive: true });
    expect(history.nodes.filter((item) => item.nodeType === "memory")).toHaveLength(4);
    for (const item of historic) {
      expect(() => memoryGraphNode(db, node(item.id))).toThrow(/unavailable/u);
      expect(memoryGraphNode(db, node(item.id), { includeInactive: true }).memory?.status).toBe(item.status);
    }
    for (const item of hidden) expect(() => memoryGraphNode(db, node(item.id), { includeInactive: true })).toThrow(/unavailable/u);
  });

  it("expands two hops via shared evidence and supports source roots and empty relation filters", () => {
    const a = memory({ sourceRef: "meeting:storage" });
    const b = memory({ title: "恢复检查", content: "恢复后校验摘要。", sourceRef: "meeting:storage" });
    const first = memoryGraph(db, { nodeId: node(a.id), depth: 1 });
    expect(first.nodes.some((item) => item.id === node(b.id))).toBe(false);
    const sourceNode = first.nodes.find((item) => item.nodeType === "source")!;
    const second = memoryGraph(db, { nodeId: node(a.id), depth: 2 });
    expect(second.nodes.map((item) => item.id)).toContain(node(b.id));
    expect(memoryGraph(db, { nodeId: sourceNode.id }).nodes.map((item) => item.id)).toContain(node(b.id));
    expect(memoryGraph(db, { nodeId: node(a.id), relationTypes: [] })).toMatchObject({
      counts: { nodes: 1, edges: 0 }, truncated: false,
    });
    expect(memoryGraphNode(db, sourceNode.id).source?.bindings?.map((item) => item.memoryId).sort())
      .toEqual([a.id, b.id].sort());
  });

  it("keeps unreferenced user evidence separate and never promotes a missing task to a real task", () => {
    const a = memory();
    const b = memory();
    const missing = memory({ sourceRef: "task:task_missing", sourceKind: "tool" });
    memory({ sourceRef: "task:task_missing", sourceKind: "tool" });
    const graph = memoryGraph(db);
    expect(graph.nodes.filter((item) => item.nodeType === "task")).toEqual([]);
    expect(graph.nodes.filter((item) => item.nodeType === "source" && item.sourceRef === null)).toHaveLength(2);
    expect(graph.nodes.find((item) => item.sourceRef === "task:task_missing")).toMatchObject({ missing: true });
    expect(relatedGraphMemories(db, [a.id, b.id, missing.id])).toEqual([]);
  });

  it("returns indexed paragraph evidence and marks disappeared file provenance without disk access", () => {
    source();
    const item = memory({ sourceKind: "file", sourceRef: "docs/storage.md:1-2" });
    const sourceNode = memoryGraph(db, { nodeId: node(item.id) }).nodes.find((entry) => entry.nodeType === "source")!;
    expect(memoryGraphNode(db, sourceNode.id).source).toMatchObject({
      sourceKind: "file", sourceRef: "docs/storage.md:1-2", missing: false,
      startLine: 1, endLine: 2, excerpt: "Backup storage.\nRetain seven days.", sourceHash: "current-hash",
    });
    db.prepare("DELETE FROM sources WHERE id=?").run("docs/storage.md");
    expect(memoryGraphNode(db, sourceNode.id).source).toMatchObject({ missing: true, sourceId: null });
    expect(memoryGraphNode(db, sourceNode.id).source?.excerpt).toContain("Retain seven days.");
  });

  it("searches Chinese memory terms and task goals across bounded seed retrieval", () => {
    const target = memory({ title: "数据库备份保留期", content: "数据库备份保存七天。" });
    for (let index = 0; index < 60; index += 1) memory({ title: `Typography ${index}`, content: "Font scale." });
    const task = startTask(db, "数据库迁移计划");
    const graph = memoryGraph(db, { query: "请问数据库备份保存多久" });
    expect(graph.nodes.map((item) => item.id)).toContain(node(target.id));
    expect(graph.nodes.some((item) => item.label.startsWith("Typography"))).toBe(false);
    expect(memoryGraph(db, { query: "迁移计划" }).nodes.map((item) => item.id)).toContain(`task:${task.id}`);
    expect(memoryGraph(db, { query: "notpresentanywhere" })).toMatchObject({ counts: { nodes: 0, edges: 0 }, truncated: false });
  });

  it("caps nodes and edges, reports omissions and never emits dangling edges", () => {
    const seed = memory({ sourceRef: "meeting:shared" });
    for (let index = 0; index < 170; index += 1) {
      memory({ title: `Rule ${index}`, sourceRef: "meeting:shared", scope: [`src/module${index}`] });
    }
    const graph = memoryGraph(db, { nodeId: node(seed.id), depth: 2, limit: 12 });
    expect(graph.nodes).toHaveLength(12);
    expect(graph.truncated).toBe(true);
    const ids = new Set(graph.nodes.map((item) => item.id));
    expect(graph.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
    expect(graph.edges.length).toBeLessThanOrEqual(450);
    expect(memoryGraph(db, { limit: 1 }).truncated).toBe(true);
    expect(memoryGraph(db, { nodeId: node(seed.id), relationTypes: ["APPLIES_TO"] })).toMatchObject({
      counts: { nodes: 1, edges: 0 }, truncated: false,
    });
  });

  it("bounds memory and task details with an explicit truncation flag", () => {
    const item = memory({ content: "Long knowledge. ".repeat(1000) });
    const details = memoryGraphNode(db, node(item.id));
    expect(details.truncated).toBe(true);
    expect(details.memory!.content.length).toBeLessThanOrEqual(8001);
    const task = startTask(db, "A task");
    checkpointTask(db, task.id, {
      completed: Array.from({ length: 30 }, (_, index) => `Completed ${index}`),
      next: [], changedFiles: [], blockers: [], risks: [], verification: [],
    });
    const taskDetails = memoryGraphNode(db, `task:${task.id}`);
    expect(taskDetails.truncated).toBe(true);
    expect(taskDetails.task?.checkpoint.completed).toHaveLength(10);
  });

  it("retains long node titles and exact source references in accessible details", () => {
    const title = "数据库备份规划".repeat(100);
    const ref = "meeting:" + "long-reference-".repeat(90);
    const item = memory({ title, sourceRef: ref });
    const graph = memoryGraph(db);
    expect(graph.nodes.find((entry) => entry.id === node(item.id))?.label.length).toBeLessThan(title.length);
    expect(memoryGraphNode(db, node(item.id)).memory?.title).toBe(title);
    const sourceNode = graph.nodes.find((entry) => entry.nodeType === "source")!;
    expect(memoryGraphNode(db, sourceNode.id).source?.sourceRef).toBe(ref);
  });

  it("rejects malformed and cross-project IDs and validates traversal bounds", () => {
    const item = memory({ sourceRef: "meeting:local" });
    const sourceNode = memoryGraph(db).nodes.find((entry) => entry.nodeType === "source")!;
    const other = new Database(":memory:");
    migrateProject(other);
    try {
      expect(() => memoryGraphNode(other, node(item.id))).toThrow(/unavailable/u);
      expect(() => memoryGraphNode(other, sourceNode.id)).toThrow(/unavailable/u);
    } finally { other.close(); }
    for (const id of ["source:{}", "source:YQ", "scope:!!!", "unknown:abc", "a".repeat(8193)]) {
      expect(() => memoryGraphNode(db, id)).toThrow();
    }
    for (const options of [{ depth: 3 }, { limit: 0 }, { limit: Number.NaN }, { query: "x".repeat(201) }]) {
      expect(() => memoryGraph(db, options)).toThrow();
    }
  });

  it("recalls active same-task knowledge with path explanations and filters before the result limit", () => {
    const task = startTask(db, "Storage rollout");
    const seed = memory({ sourceKind: "tool", sourceRef: `task:${task.id}` });
    const good = memory({ title: "Restore checks", sourceKind: "tool", sourceRef: `task:${task.id}`, scope: ["src/auth"] });
    for (let i = 0; i < 6; i += 1) memory({
      title: `Wrong module ${i}`, sourceKind: "tool", sourceRef: `task:${task.id}`, scope: ["src/images"],
    });
    const summary = memory({ type: "task-summary", sourceKind: "tool", sourceRef: `task:${task.id}` });
    const stale = memory({ status: "stale", sourceKind: "tool", sourceRef: `task:${task.id}` });
    const related = relatedGraphMemories(db, [seed.id], 1, (record) => record.scope.includes("src/auth"));
    expect(related).toHaveLength(1);
    expect(related[0]).toMatchObject({
      memory: { id: good.id }, fromMemoryId: seed.id, viaNodeId: `task:${task.id}`, relation: "same-task",
    });
    expect(relatedGraphMemories(db, [seed.id]).every((entry) => ![seed.id, summary.id, stale.id].includes(entry.memory.id))).toBe(true);
    expect(relatedGraphMemories(db, [seed.id, good.id]).every((entry) => entry.memory.id !== good.id)).toBe(true);
  });

  it("does not cross paragraph evidence, missing sources, lifecycle, or scope-only relationships", () => {
    source();
    const seed = memory({ sourceKind: "file", sourceRef: "docs/storage.md:1-2", scope: ["src/storage"] });
    const peer = memory({ title: "Restore verification", sourceKind: "file", sourceRef: "docs/storage.md:1-2" });
    memory({ title: "Other paragraph", sourceKind: "file", sourceRef: "docs/storage.md:4-5" });
    memory({ title: "Same scope only", scope: ["src/storage"] });
    expect(relatedGraphMemories(db, [seed.id]).map((entry) => entry.memory.id)).toEqual([peer.id]);
    db.prepare("UPDATE sources SET content_hash='changed-hash' WHERE id=?").run("docs/storage.md");
    expect(relatedGraphMemories(db, [seed.id])).toEqual([]);
    db.prepare("UPDATE sources SET content_hash='current-hash' WHERE id=?").run("docs/storage.md");
    updateMemoryStatus(db, peer.id, "deleted");
    expect(relatedGraphMemories(db, [seed.id])).toEqual([]);
    updateMemoryStatus(db, peer.id, "active");
    db.prepare("DELETE FROM sources WHERE id=?").run("docs/storage.md");
    expect(relatedGraphMemories(db, [seed.id])).toEqual([]);
  });

  it("returns no recall for inactive seeds or zero limits and does not repeat peers", () => {
    const a = memory({ sourceRef: "meeting:shared" });
    const b = memory({ sourceRef: "meeting:shared" });
    const c = memory({ sourceRef: "meeting:shared" });
    expect(relatedGraphMemories(db, [a.id, b.id]).map((entry) => entry.memory.id)).toEqual([c.id]);
    updateMemoryStatus(db, a.id, "stale");
    expect(relatedGraphMemories(db, [a.id])).toEqual([]);
    expect(relatedGraphMemories(db, [b.id], 0)).toEqual([]);
  });

  it("excludes task summaries before same-task recall candidate limits", () => {
    const task = startTask(db, "Task provenance");
    const seed = memory({ sourceKind: "tool", sourceRef: `task:${task.id}` });
    const peer = memory({ title: "Durable rule", sourceKind: "tool", sourceRef: `task:${task.id}` });
    db.prepare("UPDATE memories SET updated_at='2000-01-01' WHERE id=?").run(peer.id);
    for (let i = 0; i < 25; i += 1) memory({
      title: `Execution summary ${i}`, type: "task-summary", sourceKind: "tool", sourceRef: `task:${task.id}`,
    });
    expect(relatedGraphMemories(db, [seed.id]).map((entry) => entry.memory.id)).toEqual([peer.id]);
    expect(memoryGraph(db, { nodeId: `task:${task.id}`, limit: 80 }).nodes
      .some((entry) => entry.memoryType === "task-summary")).toBe(true);
  });

  it("never returns a graph recall explanation whose source node ID cannot be opened", () => {
    const sourceRef = "meeting:" + "x".repeat(7000);
    const seed = memory({ sourceRef });
    memory({ title: "Peer", sourceRef });
    const related = relatedGraphMemories(db, [seed.id]);
    expect(related).toEqual([]);
    for (const item of related) expect(() => memoryGraphNode(db, item.viaNodeId)).not.toThrow();
  });
});
