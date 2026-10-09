import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateProject } from "../src/storage/schema.js";
import { openDatabase, type SqliteDatabase } from "../src/storage/database.js";
import {
  cancelTask, checkpointTask, completeTask, getTask, listTaskHistory, startTask, type TaskCheckpoint,
} from "../src/tasks/task-service.js";

const databases: SqliteDatabase[] = [];
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function database(): SqliteDatabase {
  const db = new Database(":memory:");
  databases.push(db);
  db.pragma("foreign_keys = ON");
  migrateProject(db);
  return db;
}

function checkpoint(summary: string): TaskCheckpoint {
  return { summary, completed: [summary], next: ["verify"], changedFiles: ["src/example.ts"],
    verification: [{ command: "test", status: "passed", summary: "focused" }], blockers: [], risks: ["remote unverified"] };
}

function downgradeToVersion7(db: SqliteDatabase): void {
  db.exec("DROP TABLE task_checkpoint_requests; DROP TABLE task_events;");
  for (const column of ["updated", "created", "completed"]) {
    db.exec(`DROP INDEX tasks_${column}_id_idx; DROP INDEX tasks_status_${column}_id_idx;`);
  }
  db.pragma("user_version = 7");
}

describe("persistent task history", () => {
  it("migrates each existing task to one explicitly timed snapshot without changing its record", () => {
    const db = database();
    const active = startTask(db, "existing active task");
    checkpointTask(db, active.id, checkpoint("existing progress"));
    const done = startTask(db, "existing completed task");
    completeTask(db, done.id, checkpoint("done"));
    const cancelled = startTask(db, "existing cancelled task");
    cancelTask(db, cancelled.id);
    db.prepare("UPDATE tasks SET created_at = ?, updated_at = ?").run("2020-01-01T00:00:00.000Z", "2020-02-01T00:00:00.000Z");
    const before = db.prepare("SELECT * FROM tasks ORDER BY id").all();
    downgradeToVersion7(db);
    const startedAt = new Date().toISOString();
    migrateProject(db);
    expect(db.pragma("user_version", { simple: true })).toBe(8);
    expect(db.prepare("SELECT * FROM tasks ORDER BY id").all()).toEqual(before);
    for (const task of [active, done, cancelled]) {
      const history = listTaskHistory(db, task.id);
      expect(history.total).toBe(1);
      expect(history.items[0]).toMatchObject({ kind: "migration_snapshot", source: "migration:v8", snapshot: getTask(db, task.id) });
      // SQLite's Windows clock may have coarser resolution than JavaScript's clock.
      expect(Date.parse(history.items[0]!.recordedAt)).toBeGreaterThanOrEqual(Date.parse(startedAt) - 1000);
      expect(Date.parse(history.items[0]!.recordedAt)).toBeLessThanOrEqual(Date.now() + 1000);
    }
    migrateProject(db);
    expect(db.prepare("SELECT count(*) AS n FROM task_events").get()).toEqual({ n: 3 });
    expect(db.pragma("quick_check", { simple: true })).toBe("ok");
  });

  it("rolls a failed migration back, preserving old records and schema version", () => {
    const db = database();
    const task = startTask(db, "legacy invalid JSON");
    downgradeToVersion7(db);
    db.prepare("UPDATE tasks SET checkpoint_json = ? WHERE id = ?").run("invalid JSON", task.id);
    const before = db.prepare("SELECT * FROM tasks").all();
    expect(() => migrateProject(db)).toThrow();
    expect(db.pragma("user_version", { simple: true })).toBe(7);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('task_events','task_checkpoint_requests')").all()).toEqual([]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'tasks_%_id_idx'").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM tasks").all()).toEqual(before);
    expect(db.pragma("quick_check", { simple: true })).toBe("ok");
    db.prepare("UPDATE tasks SET checkpoint_json = ? WHERE id = ?").run(JSON.stringify(checkpoint("repaired")), task.id);
    migrateProject(db);
    expect(listTaskHistory(db, task.id).total).toBe(1);
  });

  it("uses six narrow indexes for the three ordered task views with and without a status filter", () => {
    const db = database();
    for (let index = 0; index < 20; index++) {
      const task = startTask(db, `indexed task ${index}`);
      if (index % 2 === 0) completeTask(db, task.id);
    }
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'tasks_%_id_idx'").all();
    expect(indexes).toHaveLength(6);
    for (const column of ["updated", "created", "completed"]) {
      for (const status of [false, true]) {
        const query = `EXPLAIN QUERY PLAN SELECT id, goal, checkpoint_json FROM tasks
          ${status ? "WHERE status = ?" : ""} ORDER BY ${column}_at DESC, id COLLATE BINARY ASC LIMIT 10 OFFSET 0`;
        const details = (db.prepare(query).all(...(status ? ["completed"] : [])) as Array<{ detail: string }>)
          .map(row => row.detail).join("\n");
        expect(details).toContain(`tasks_${status ? "status_" : ""}${column}_id_idx`);
        expect(details).not.toContain("TEMP B-TREE");
      }
    }
  });

  it("rechecks the migration version after another connection upgrades before write lock acquisition", () => {
    const directory = mkdtempSync(join(tmpdir(), "task-migration-race-"));
    directories.push(directory);
    const first = openDatabase(join(directory, "project.db"));
    const second = openDatabase(join(directory, "project.db"));
    databases.push(first, second);
    const transaction = first.transaction.bind(first);
    let competingMigrationRan = false;
    vi.spyOn(first, "transaction").mockImplementation(((fn: () => unknown) => {
      const tx = transaction(fn);
      const immediate = tx.immediate.bind(tx);
      const interleaved = () => {
        if (!competingMigrationRan) {
          competingMigrationRan = true;
          migrateProject(second);
        }
        return immediate();
      };
      return Object.assign(interleaved, { immediate: interleaved, deferred: tx.deferred, exclusive: tx.exclusive });
    }) as typeof first.transaction);
    expect(() => migrateProject(first)).not.toThrow();
    expect(competingMigrationRan).toBe(true);
    expect(first.pragma("user_version", { simple: true })).toBe(8);
    expect(first.pragma("quick_check", { simple: true })).toBe("ok");
  });

  it("pages more than ten changes in stable newest-first order and preserves terminal snapshots", () => {
    const db = database();
    const task = startTask(db, "history paging", { source: "mcp" });
    for (let index = 0; index < 12; index++) checkpointTask(db, task.id, checkpoint(`step ${index}`), { source: "mcp" });
    const final = completeTask(db, task.id, undefined, { source: "web" });
    completeTask(db, task.id);
    const first = listTaskHistory(db, task.id, { limit: 10 });
    const second = listTaskHistory(db, task.id, { limit: 10, offset: 10 });
    expect(first.total).toBe(14);
    expect(second.total).toBe(14);
    expect(first.items).toHaveLength(10);
    expect(second.items).toHaveLength(4);
    const all = [...first.items, ...second.items];
    expect(new Set(all.map(item => item.sequence)).size).toBe(14);
    expect(all.map(item => item.sequence)).toEqual(all.map(item => item.sequence).sort((a, b) => b - a));
    expect(first.items[0]).toMatchObject({ kind: "completed", source: "web", snapshot: final });
    expect(first.items[0]!.snapshot.checkpoint).toEqual(checkpoint("step 11"));
    expect(all.at(-1)).toMatchObject({ kind: "created", source: "mcp", snapshot: task });
    expect(listTaskHistory(db, task.id, { offset: 100 }).items).toEqual([]);
  });

  it("deduplicates canonical content and persists receipts even when no new event is needed", () => {
    const db = database();
    const task = startTask(db, "idempotent retries");
    const firstPayload = checkpoint("first");
    const saved = checkpointTask(db, task.id, firstPayload, { requestId: "request-1" });
    const reordered = { risks: firstPayload.risks, blockers: firstPayload.blockers, verification: [
      { summary: "focused", status: "passed", command: "test" },
    ], changedFiles: firstPayload.changedFiles, next: firstPayload.next, completed: firstPayload.completed, summary: "first" };
    expect(checkpointTask(db, task.id, reordered)).toEqual(saved);
    expect(checkpointTask(db, task.id, reordered, { requestId: "same-state-request" })).toEqual(saved);
    expect(listTaskHistory(db, task.id).total).toBe(2);
    const newer = checkpointTask(db, task.id, checkpoint("newer"));
    expect(checkpointTask(db, task.id, reordered, { requestId: "request-1" })).toEqual(newer);
    expect(checkpointTask(db, task.id, reordered, { requestId: "same-state-request" })).toEqual(newer);
    expect(() => checkpointTask(db, task.id, checkpoint("different"), { requestId: "request-1" }))
      .toThrow(expect.objectContaining({ code: "TASK_REQUEST_CONFLICT" }));
    expect(getTask(db, task.id)).toEqual(newer);
    expect(listTaskHistory(db, task.id).total).toBe(3);
  });

  it("retains the checkpoint when cancelled and rejects impossible terminal transitions", () => {
    const db = database();
    const task = startTask(db, "cancel after progress");
    checkpointTask(db, task.id, checkpoint("in progress"));
    const cancelled = cancelTask(db, task.id, { source: "web" });
    expect(cancelTask(db, task.id)).toEqual(cancelled);
    expect(listTaskHistory(db, task.id)).toMatchObject({ total: 3, items: [
      { kind: "cancelled", source: "web", snapshot: { checkpoint: checkpoint("in progress"), status: "cancelled" } },
      { kind: "checkpoint" }, { kind: "created" },
    ] });
    expect(() => completeTask(db, task.id)).toThrow(expect.objectContaining({ code: "TASK_TRANSITION_BLOCKED" }));
    expect(listTaskHistory(db, task.id).total).toBe(3);
  });

  it("recognizes a saved retry from another database connection after later completion", () => {
    const directory = mkdtempSync(join(tmpdir(), "task-retry-"));
    directories.push(directory);
    const path = join(directory, "project.db");
    const first = openDatabase(path);
    databases.push(first);
    migrateProject(first);
    const task = startTask(first, "persistent retry receipt");
    checkpointTask(first, task.id, checkpoint("first"), { requestId: "persistent-request" });
    const completed = completeTask(first, task.id, checkpoint("final result"));
    const second = openDatabase(path);
    databases.push(second);
    migrateProject(second);
    expect(checkpointTask(second, task.id, checkpoint("first"), { requestId: "persistent-request" })).toEqual(completed);
    expect(() => checkpointTask(second, task.id, checkpoint("changed"), { requestId: "persistent-request" }))
      .toThrow(expect.objectContaining({ code: "TASK_REQUEST_CONFLICT" }));
    expect(listTaskHistory(second, task.id).total).toBe(3);
  });

  it("atomically rolls back task writes and request receipts when recording an event fails", () => {
    const db = database();
    const task = startTask(db, "atomic writes");
    db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON task_events BEGIN SELECT RAISE(ABORT, 'injected event failure'); END;");
    expect(() => startTask(db, "must not remain")).toThrow("injected event failure");
    expect(() => checkpointTask(db, task.id, checkpoint("must not remain"), { requestId: "retry-after-failure" })).toThrow("injected event failure");
    expect(() => completeTask(db, task.id)).toThrow("injected event failure");
    expect(() => cancelTask(db, task.id)).toThrow("injected event failure");
    expect(getTask(db, task.id)).toEqual(task);
    expect(db.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM task_checkpoint_requests").get()).toEqual({ n: 0 });
    expect(listTaskHistory(db, task.id).total).toBe(1);
    db.exec("DROP TRIGGER fail_event;");
    checkpointTask(db, task.id, checkpoint("retry succeeds"), { requestId: "retry-after-failure" });
    expect(listTaskHistory(db, task.id).total).toBe(2);
    expect(db.pragma("quick_check", { simple: true })).toBe("ok");
  });

  it("bounds metadata and pagination, and rejects edits to historical snapshots", () => {
    const db = database();
    const task = startTask(db, "immutable history");
    expect(() => checkpointTask(db, task.id, checkpoint("invalid source"), { source: "raw\nchat" })).toThrow();
    expect(() => checkpointTask(db, task.id, checkpoint("invalid source"), { source: "x".repeat(81) })).toThrow();
    expect(() => checkpointTask(db, task.id, checkpoint("invalid request"), { requestId: "" })).toThrow();
    for (const options of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 0.5 }]) {
      expect(() => listTaskHistory(db, task.id, options)).toThrow();
    }
    expect(() => listTaskHistory(db, "unknown")).toThrow(expect.objectContaining({ code: "TASK_NOT_FOUND" }));
    expect(() => db.prepare("UPDATE task_events SET source = 'changed'").run()).toThrow("append-only");
    expect(() => db.prepare("DELETE FROM task_events").run()).toThrow("append-only");
    expect(listTaskHistory(db, task.id).total).toBe(1);
  });
});
