import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryTasks, queryWorkspaceTasks, taskQuerySchema } from "../src/tasks/task-query.js";
import type { ProjectRecord } from "../src/projects/project-service.js";
import { ProjectContextError } from "../src/shared/errors.js";

const databases: Database.Database[] = [];
function fixture() {
  const db = new Database(":memory:"); databases.push(db);
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, goal TEXT, status TEXT, checkpoint_json TEXT,
    created_at TEXT, updated_at TEXT, completed_at TEXT)`);
  const insert = db.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (let i = 0; i < 23; i++) {
    const status = i < 12 ? "in_progress" : i < 20 ? "completed" : "cancelled";
    insert.run(`task_${String(i).padStart(2, "0")}`, `Goal ${i}`, status,
      JSON.stringify({ summary: i === 1 ? "fix 100%_literal\\path 中文" : "ordinary", completed: [], next: [] }),
      "2026-01-01", "2026-01-02", status === "in_progress" ? null : "2026-01-03");
  }
  return db;
}
function project(id: string, archived = false): ProjectRecord {
  return { id, name: id, rootPath: `/${id}`, remoteUrl: null, createdAt: "2026-01-01", updatedAt: "2026-01-01",
    lastOpenedAt: "2026-01-01", archivedAt: archived ? "2026-01-02" : null };
}
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); });

describe("complete task queries", () => {
  it("returns every status beyond the former six/four limits with stable pages", () => {
    const db = fixture();
    expect(queryTasks(db, { status: "in_progress" }).total).toBe(12);
    expect(queryTasks(db, { status: "completed" }).items).toHaveLength(8);
    expect(queryTasks(db, { status: "cancelled" }).items).toHaveLength(3);
    const ids = [0, 10, 20].flatMap(offset => queryTasks(db, { limit: 10, offset }).items.map(task => task.id));
    expect(ids).toHaveLength(23);
    expect(new Set(ids).size).toBe(23);
    expect(ids).toEqual([...ids].sort());
    expect(queryTasks(db, { offset: 100 }).items).toEqual([]);
  });
  it("searches goal and summary literally, never checkpoint keys or other fields", () => {
    const db = fixture();
    for (const q of ["100%_literal\\path", "%", "_", "中文", "  中文  "]) {
      expect(queryTasks(db, { q }).items.map(task => task.id)).toEqual(["task_01"]);
    }
    expect(queryTasks(db, { q: "Goal 22" }).total).toBe(1);
    expect(queryTasks(db, { q: "completed" }).total).toBe(0);
    expect(queryTasks(db, { q: "' OR 1=1 --" }).total).toBe(0);
  });
  it("orders by selected dates, putting missing completion dates last", () => {
    const db = fixture();
    db.prepare("UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?").run("2026-03-01", "2026-02-01", "task_07");
    expect(queryTasks(db, { sort: "created" }).items[0]!.id).toBe("task_07");
    expect(queryTasks(db, { sort: "updated" }).items[0]!.id).toBe("task_07");
    const rows = queryTasks(db, { sort: "completed", limit: 100 }).items;
    expect(rows[0]!.id).toBe("task_12");
    expect(rows[11]!.completedAt).toBeNull();
  });
  it("validates bounds and does not coerce string booleans", () => {
    expect(taskQuerySchema.parse({})).toMatchObject({ limit: 20, offset: 0, status: "all", includeArchived: false });
    for (const input of [{ limit: 101 }, { offset: -1 }, { offset: 100001 }, { includeArchived: "false" }, { q: "a".repeat(201) }]) {
      expect(taskQuerySchema.safeParse(input).success).toBe(false);
    }
  });
});

describe("workspace task queries", () => {
  it("uses direct SQL pagination for a single selected project, without parsing earlier checkpoints", () => {
    const db = fixture();
    db.prepare("UPDATE tasks SET checkpoint_json = 'invalid' WHERE id = 'task_00'").run();
    const result = queryWorkspaceTasks([project("one"), project("two")], () => db,
      { projectId: "one", offset: 10, limit: 5 });
    expect(result).toMatchObject({ total: 23, partial: false, offset: 10, limit: 5 });
    expect(result.items.map(task => task.id)).toEqual(["task_10", "task_11", "task_12", "task_13", "task_14"]);
    expect(db.open).toBe(false);
  });
  it("merges stable pages across project boundaries and closes every opened database", () => {
    const projects = [project("b"), project("a")];
    const opened: Database.Database[] = [];
    const open = () => { const db = fixture(); opened.push(db); return db; };
    const results = [0, 10, 20, 30, 40].map(offset => queryWorkspaceTasks(projects, open, { limit: 10, offset }));
    expect(results.every(page => page.total === 46 && !page.partial)).toBe(true);
    const ids = results.flatMap(page => page.items.map(task => `${task.projectId}/${task.id}`));
    expect(ids).toHaveLength(46);
    expect(new Set(ids).size).toBe(46);
    expect(ids).toEqual([...ids].sort());
    expect(opened.every(db => !db.open)).toBe(true);
    expect(results[0]!.items[0]).toMatchObject({ projectName: "a", projectRoot: "/a", projectArchived: false });
  });
  it("excludes archives by default, even for explicit selection, and validates unknown IDs", () => {
    const projects = [project("active"), project("archive", true)];
    expect(queryWorkspaceTasks(projects, fixture).total).toBe(23);
    expect(queryWorkspaceTasks(projects, fixture, { projectId: "archive" }).total).toBe(0);
    const page = queryWorkspaceTasks(projects, fixture, { projectId: "archive", includeArchived: true });
    expect(page.total).toBe(23);
    expect(page.items.every(task => task.projectArchived)).toBe(true);
    expect(queryWorkspaceTasks(projects, fixture, { includeArchived: true }).total).toBe(46);
    expect(() => queryWorkspaceTasks(projects, fixture, { projectId: "missing" })).toThrow("Unknown project");
  });
  it("globally orders dates before project IDs and matches a full result slice", () => {
    const projects = [project("a"), project("z")];
    const open = (id: string) => {
      const db = fixture();
      db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?")
        .run(id === "z" ? "2026-04-01" : "2026-03-01", "task_22");
      return db;
    };
    const full = queryWorkspaceTasks(projects, open, { limit: 100 });
    expect(full.items.slice(0, 2).map(task => task.projectId)).toEqual(["z", "a"]);
    const page = queryWorkspaceTasks(projects, open, { offset: 19, limit: 10 });
    expect(page.items).toEqual(full.items.slice(19, 29));
    const completed = queryWorkspaceTasks(projects, open, { sort: "completed", limit: 100 });
    expect(completed.items.slice(0, 22).every(task => task.completedAt !== null)).toBe(true);
    expect(completed.items.slice(22).every(task => task.completedAt === null)).toBe(true);
  });
  it("returns remaining results with explicit missing and migration warnings", () => {
    const result = queryWorkspaceTasks([project("missing"), project("busy"), project("ok")], id => {
      if (id === "missing") throw new ProjectContextError("PROJECT_DATABASE_MISSING", "Database is missing");
      if (id === "busy") throw new ProjectContextError("INDEX_MIGRATION_RUNNING", "Maintenance in progress");
      return fixture();
    });
    expect(result).toMatchObject({ total: 23, partial: true });
    expect(result.warnings.map(item => item.code)).toEqual(["PROJECT_DATABASE_MISSING", "INDEX_MIGRATION_RUNNING"]);
    expect(result.items.every(task => task.projectId === "ok")).toBe(true);
  });
  it("closes a database after query failure and includes no partial rows from it", () => {
    const broken = fixture();
    broken.prepare("UPDATE tasks SET checkpoint_json = 'invalid' WHERE id = 'task_05'").run();
    const result = queryWorkspaceTasks([project("broken"), project("ok")], id => id === "broken" ? broken : fixture());
    expect(result.total).toBe(23);
    expect(result.partial).toBe(true);
    expect(result.warnings[0]!.projectId).toBe("broken");
    expect(broken.open).toBe(false);
    expect(result.items.every(task => task.projectId === "ok")).toBe(true);
  });
  it("reports cleanup errors once per project and continues without publishing failed-project rows", () => {
    const cleanupOnly = fixture();
    const queryAndCleanup = fixture();
    queryAndCleanup.prepare("UPDATE tasks SET checkpoint_json = 'invalid' WHERE id = 'task_00'").run();
    for (const db of [cleanupOnly, queryAndCleanup]) {
      const close = db.close.bind(db);
      vi.spyOn(db, "close").mockImplementation(() => { close(); throw new Error("cleanup error"); });
    }
    const result = queryWorkspaceTasks([project("cleanup"), project("both"), project("ok")], id =>
      id === "cleanup" ? cleanupOnly : id === "both" ? queryAndCleanup : fixture());
    expect(result.total).toBe(23);
    expect(result.partial).toBe(true);
    expect(result.items.every(task => task.projectId === "ok")).toBe(true);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toMatchObject({ projectId: "cleanup", code: "PROJECT_DATABASE_CLOSE_FAILED" });
    expect(result.warnings[1]).toMatchObject({ projectId: "both", code: "PROJECT_TASK_QUERY_FAILED" });
    expect(result.warnings.every(warning => warning.message.includes("cleanup error"))).toBe(true);
    expect(cleanupOnly.open).toBe(false);
    expect(queryAndCleanup.open).toBe(false);
  });
});
