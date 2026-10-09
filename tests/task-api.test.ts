import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectContextApp } from "../src/core/app.js";
import { startUiServer, type UiServerHandle } from "../src/ui/server.js";
import type { TaskCheckpoint } from "../src/tasks/task-service.js";
import { exportProject } from "../src/maintenance/maintenance-service.js";

describe("complete task browsing and history API", () => {
  let root: string;
  let app: ProjectContextApp;
  let ui: UiServerHandle;
  let cookie: string;
  let previous: Record<string, string | undefined>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "context-task-api-"));
    previous = Object.fromEntries(["PROJECT_CONTEXT_HOME", "PROJECT_CONTEXT_ALLOWED_ROOTS", "PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS"]
      .map(key => [key, process.env[key]]));
    process.env.PROJECT_CONTEXT_HOME = join(root, "memory");
    process.env.PROJECT_CONTEXT_ALLOWED_ROOTS = root;
    process.env.PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS = root;
    app = await ProjectContextApp.create();
    ui = await startUiServer({ openBrowser: false });
    const token = new URLSearchParams(new URL(ui.launchUrl).hash.slice(1)).get("token");
    const session = await fetch(`${ui.url}/api/session`, {
      method: "POST", headers: { Origin: ui.url, "X-Project-Context-UI": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    cookie = session.headers.get("set-cookie")!.split(";")[0]!;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await ui?.close();
    app?.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  async function project(name: string) {
    const path = join(root, name);
    await mkdir(path);
    return app.openProject(path);
  }

  function request(path: string, method = "GET") {
    return fetch(`${ui.url}${path}`, { method, headers: { Cookie: cookie, Origin: ui.url, "X-Project-Context-UI": "1" } });
  }

  it("authenticates missing-registration removal and refuses healthy databases or wrong confirmation", async () => {
    const target = await project("missing-registration");
    const path = `/api/projects/${target.id}/unregister-missing`;
    const send = (confirmation: string, authenticated = true) => fetch(`${ui.url}${path}`, {
      method: "POST", headers: { ...(authenticated ? { Cookie: cookie } : {}), Origin: ui.url, "X-Project-Context-UI": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ confirmProjectId: confirmation }),
    });
    expect((await send(target.id, false)).status).toBe(401);
    expect(await (await send("wrong")).json()).toMatchObject({ code: "PROJECT_UNREGISTER_CONFIRMATION_MISMATCH" });
    expect(await (await send(target.id)).json()).toMatchObject({ code: "PROJECT_DATABASE_PRESENT" });
    await rename(join(target.rootPath, ".project-context"), join(target.rootPath, "retained-index"));
    const result = await send(target.id);
    const payload = await result.json();
    expect(payload).toMatchObject({ projectId: target.id, unregistered: true, filesDeleted: false });
    expect(result.status).toBe(200);
    expect(app.projects.list(true).some(item => item.id === target.id)).toBe(false);
    expect((await readFile(join(target.rootPath, "retained-index", "project.db"))).length).toBeGreaterThan(0);
  });

  it("lists every task across projects and protects task/history reads with existing authentication", async () => {
    const a = await project("a");
    const b = await project("b");
    for (let n = 0; n < 13; n++) app.startTask(a.id, `任务 ${n}`);
    for (let n = 0; n < 7; n++) app.completeTask(b.id, app.startTask(b.id, `已完成 ${n}`).id);
    const cancelled = app.startTask(b.id, "取消的任务");
    app.cancelTask(b.id, cancelled.id);
    const seen: string[] = [];
    for (const offset of [0, 10, 20]) {
      const response = await request(`/api/tasks?limit=10&offset=${offset}`);
      expect(response.status).toBe(200);
      const page = await response.json();
      expect(page).toMatchObject({ total: 21, partial: false });
      seen.push(...page.items.map((item: { id: string }) => item.id));
    }
    expect(new Set(seen).size).toBe(21);
    const page = await (await request("/api/tasks?status=cancelled")).json();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: cancelled.id, projectId: b.id, projectName: "b" });
    for (const path of ["/api/tasks", `/api/projects/${b.id}/tasks/${cancelled.id}/history`]) {
      const denied = await fetch(`${ui.url}${path}`, { headers: { "X-Project-Context-UI": "1" } });
      expect(denied.status).toBe(401);
    }
    for (const query of ["limit=0", "offset=-1", "status=unknown", "sort=invalid", "includeArchived=maybe", `q=${"a".repeat(201)}`]) {
      expect((await request(`/api/tasks?${query}`)).status).toBe(400);
    }
    expect((await request("/api/tasks?projectId=missing")).status).toBe(404);
    expect((await request(`/api/projects/${a.id}/tasks/${cancelled.id}/history`)).status).toBe(404);
  });

  it("records correctly routed Web lifecycle events, exports history, and retains it through cleanup and restore", async () => {
    const a = await project("a");
    const b = await project("b");
    const unrelated = app.startTask(a.id, "Keep this task running");
    const target = app.startTask(b.id, "Review before completing");
    const checkpoint: TaskCheckpoint = {
      summary: "Verification does not imply all production cases passed", completed: ["local implementation"],
      next: ["remote validation"], changedFiles: ["src/very-long-module.ts"],
      verification: [{ command: "npm test", status: "passed", summary: "local fixtures only" }],
      blockers: [], risks: ["Remote database has not been tested"],
    };
    app.checkpoint(b.id, target.id, checkpoint, { requestId: "api-fixture", source: "test" });
    expect((await request(`/api/projects/${a.id}/tasks/${target.id}/complete`, "POST")).status).toBe(404);
    expect((await request(`/api/projects/${b.id}/tasks/${target.id}/complete`, "POST")).status).toBe(200);
    expect((await request(`/api/projects/${b.id}/tasks/${target.id}/complete`, "POST")).status).toBe(200);
    expect(app.task(a.id, unrelated.id).status).toBe("in_progress");
    const result = await (await request(`/api/projects/${b.id}/tasks/${target.id}/history?limit=1`)).json();
    expect(result).toMatchObject({ total: 3, limit: 1, offset: 0 });
    expect(result.items[0]).toMatchObject({ kind: "completed", source: "web", snapshot: { checkpoint } });
    const output = join(root, "export");
    await app.export(b.id, output);
    expect((await readFile(join(output, "task-events.jsonl"), "utf8")).trim().split("\n")).toHaveLength(3);
    expect((await readFile(join(output, "task-checkpoint-requests.jsonl"), "utf8"))).toContain("api-fixture");
    app.cleanupProject(b.id, { dryRun: false, vacuum: true, confirmProjectId: b.id });
    expect(app.taskHistory(b.id, target.id).total).toBe(3);
    const backup = join(root, "backup.db");
    await app.backup(b.id, backup);
    const restoreRoot = join(root, "restored");
    await mkdir(restoreRoot);
    const restored = (await app.restoreProject({ source: backup, root: restoreRoot })).project as { id: string };
    expect(app.taskHistory(restored.id, target.id).items).toEqual(app.taskHistory(b.id, target.id).items);
    expect(app.storageUsage(restored.id).counts.task_events).toBe(3);
  });

  it("exports latest tasks and history from one SQLite snapshot while another connection commits", async () => {
    const a = await project("export-snapshot");
    const task = app.startTask(a.id, "Snapshot consistency");
    const db = app.projects.projectDatabase(a.id);
    try {
      const originalPrepare = db.prepare.bind(db);
      let injected = false;
      vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
        const statement = originalPrepare(sql);
        if (sql === "SELECT * FROM tasks ORDER BY created_at") {
          const originalAll = statement.all.bind(statement);
          vi.spyOn(statement, "all").mockImplementation((...args: unknown[]) => {
            const rows = originalAll(...args);
            app.checkpoint(a.id, task.id, { ...task.checkpoint, summary: "Concurrent update" }, { requestId: "concurrent" });
            injected = true;
            return rows;
          });
        }
        return statement;
      }) as typeof db.prepare);
      const destination = join(root, "consistent-export");
      await exportProject(db, a, destination, [root]);
      expect(injected).toBe(true);
      const exported = JSON.parse((await readFile(join(destination, "tasks.jsonl"), "utf8")).trim());
      expect(JSON.parse(exported.checkpoint_json).summary).toBeUndefined();
      expect((await readFile(join(destination, "task-events.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
      expect(await readFile(join(destination, "task-checkpoint-requests.jsonl"), "utf8")).toBe("");
      expect(app.taskHistory(a.id, task.id).total).toBe(2);
    } finally { vi.restoreAllMocks(); db.close(); }
  });

  it("excludes archived projects unless requested and reports unavailable projects without losing available tasks", async () => {
    const a = await project("available");
    const b = await project("archived");
    const c = await project("unavailable");
    app.startTask(a.id, "Visible");
    app.startTask(b.id, "Archived");
    app.startTask(c.id, "Missing");
    app.archiveProject(b.id);
    await rename(c.rootPath, join(root, "moved-away"));
    const partial = await (await request("/api/tasks")).json();
    expect(partial).toMatchObject({ total: 1, partial: true });
    expect(partial.warnings).toEqual([expect.objectContaining({ projectId: c.id })]);
    const archived = await (await request(`/api/tasks?projectId=${b.id}&includeArchived=true`)).json();
    expect(archived.items[0]).toMatchObject({ projectId: b.id, projectArchived: true });
  });
});
