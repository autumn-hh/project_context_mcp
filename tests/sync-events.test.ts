import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type SqliteDatabase } from "../src/storage/database.js";
import { migrateProject } from "../src/storage/schema.js";
import { remember, updateMemoryStatus } from "../src/memory/memory-service.js";
import { startTask, checkpointTask, completeTask, cancelTask, listTaskHistory } from "../src/tasks/task-service.js";
import { initializeSync, outgoingEvents, receiveEvents, syncConflicts, syncStatus, resolveSyncConflict, acknowledgeEvents } from "../src/storage/sync/event-store.js";

describe("transactional sync events and causal merge", () => {
  let root: string; let a: SqliteDatabase; let b: SqliteDatabase;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sync-event-test-"));
    a = openDatabase(join(root, "a.db")); b = openDatabase(join(root, "b.db"));
    migrateProject(a); migrateProject(b); initializeSync(a, "space", "device-a"); initializeSync(b, "space", "device-b");
  });
  afterEach(async () => { a.close(); b.close(); await rm(root, { recursive: true, force: true }); });
  async function exchange() {
    const left = outgoingEvents(a); const right = outgoingEvents(b);
    await receiveEvents(b, left); await receiveEvents(a, right); acknowledgeEvents(a, left.map(e => e.id)); acknowledgeEvents(b, right.map(e => e.id));
  }
  it("appends events atomically and rolls both data and outbox back on transaction failure", () => {
    expect(() => a.transaction(() => { remember(a, { type: "fact", title: "one", content: "atomic", sourceKind: "user" }); throw new Error("rollback"); })()).toThrow("rollback");
    expect(outgoingEvents(a)).toEqual([]);
    expect(a.prepare("SELECT COUNT(*) FROM memories").pluck().get()).toBe(0);
    remember(a, { type: "fact", title: "one", content: "committed", sourceKind: "user" });
    expect(outgoingEvents(a).map(event => event.table)).toEqual(["memories", "memory_sources"]);
  });
  it("replays duplicates, buffers missing parents and never reverts a causal successor", async () => {
    const memory = remember(a, { type: "fact", title: "one", content: "initial", sourceKind: "user" });
    updateMemoryStatus(a, memory.id, "stale");
    const events = outgoingEvents(a); const latest = events.at(-1)!;
    expect((await receiveEvents(b, [latest])).status).toMatchObject({ waiting: 1 });
    await receiveEvents(b, events.slice(0, -1).reverse());
    expect(b.prepare("SELECT status FROM memories").pluck().get()).toBe("stale");
    expect((await receiveEvents(b, events)).inserted).toBe(0);
    expect(syncStatus(b)).toMatchObject({ waiting: 0, conflicts: 0 });
  });
  it("preserves concurrent branches, converges deterministically and resolves all parents explicitly", async () => {
    const memory = remember(a, { type: "decision", title: "one", content: "initial", sourceKind: "user" });
    await exchange();
    a.prepare("UPDATE memories SET content='left' WHERE id=?").run(memory.id);
    b.prepare("UPDATE memories SET content='right' WHERE id=?").run(memory.id);
    await exchange();
    expect(syncConflicts(a)).toHaveLength(1); expect(syncConflicts(b)).toHaveLength(1);
    expect(a.prepare("SELECT content,status FROM memories").get()).toEqual(b.prepare("SELECT content,status FROM memories").get());
    expect(a.prepare("SELECT status FROM memories").pluck().get()).toBe("conflicted");
    const conflict = syncConflicts(a)[0]!; const chosen = conflict.versions.find(event => (event.payload as any).content === "left")!;
    await resolveSyncConflict(a, conflict.table, conflict.entity, chosen.id); await exchange();
    expect(syncConflicts(b)).toEqual([]); expect(b.prepare("SELECT content,status FROM memories").get()).toEqual({ content: "left", status: "active" });
  });
  it("does not resurrect concurrently deleted knowledge when an offline edit returns", async () => {
    const memory = remember(a, { type: "fact", title: "one", content: "initial", sourceKind: "user" }); await exchange();
    updateMemoryStatus(a, memory.id, "deleted"); b.prepare("UPDATE memories SET content='offline edit' WHERE id=?").run(memory.id);
    await exchange();
    expect(a.prepare("SELECT status FROM memories").pluck().get()).toBe("deleted");
    expect(b.prepare("SELECT status FROM memories").pluck().get()).toBe("deleted");
    expect(syncConflicts(a)).toHaveLength(1);
  });
  it("merges independent task history sequences, receipts and competing terminal states", async () => {
    const task = startTask(a, "shared work"); await exchange();
    const left = { ...task.checkpoint, summary: "left" }; const right = { ...task.checkpoint, summary: "right" };
    checkpointTask(a, task.id, left, { requestId: "a:1" }); checkpointTask(b, task.id, right, { requestId: "b:1" });
    completeTask(a, task.id); cancelTask(b, task.id); await exchange();
    expect(syncConflicts(a).some(conflict => conflict.table === "tasks")).toBe(true);
    expect(listTaskHistory(a, task.id).total).toBe(5); expect(listTaskHistory(b, task.id).total).toBe(5);
    const current = b.prepare("SELECT checkpoint_json FROM tasks WHERE id=?").pluck().get(task.id);
    expect(JSON.stringify(checkpointTask(b, task.id, left, { requestId: "a:1" }).checkpoint)).toBe(current);
    expect(a.prepare("SELECT status FROM tasks").pluck().get()).toBe(b.prepare("SELECT status FROM tasks").pluck().get());
  });
  it("rejects event identity reuse and cross-entity parent claims transactionally", async () => {
    const task=startTask(a,"immutable history");const history=outgoingEvents(a).find(event=>event.table==='task_events')!;
    await receiveEvents(b,outgoingEvents(a));
    await expect(receiveEvents(b,[{...history,id:'evt_history_collision',payload:{...history.payload as object,kind:'cancelled'}}])).rejects.toMatchObject({code:'SYNC_HISTORY_COLLISION'});
    await expect(receiveEvents(b,[{...history,id:'evt_history_revision',version:2,parents:[history.id]}])).rejects.toMatchObject({code:'INVALID_SYNC_EVENT'});
    expect(listTaskHistory(b,task.id).total).toBe(1);
    acknowledgeEvents(a,outgoingEvents(a).map(event=>event.id));
    remember(a, { type: "fact", title: "one", content: "initial", sourceKind: "user" });
    const events = outgoingEvents(a); await receiveEvents(b, events);
    await expect(receiveEvents(b, [{ ...events[0], payload: { ...events[0]!.payload as object, content: "changed" } }]))
      .rejects.toMatchObject({ code: "SYNC_EVENT_COLLISION" });
    await expect(receiveEvents(b, [{ ...events[1], id: "evt_bad", parents: [events[0]!.id], version: 2 }]))
      .rejects.toMatchObject({ code: "INVALID_SYNC_ANCESTRY" });
    expect(b.prepare("SELECT COUNT(*) FROM sync_events WHERE id='evt_bad'").pluck().get()).toBe(0);
  });
  it("persists offline queues across reopen and rejects cloned device identity", async () => {
    remember(a, { type: "fact", title: "one", content: "offline", sourceKind: "user" });
    const before = outgoingEvents(a); a.close(); a = openDatabase(join(root, "a.db"));
    expect(outgoingEvents(a)).toEqual(before); expect(initializeSync(a, "space", "device-a")).toMatchObject({ pending: 2 });
    expect(() => initializeSync(a, "space", "device-new")).toThrow(/already bound/);
    await receiveEvents(b, before); expect(b.prepare("SELECT content FROM memories").pluck().get()).toBe("offline");
  });
});
