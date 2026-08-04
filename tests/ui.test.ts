import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectContextApp } from "../src/core/app.js";
import { startUiServer, type UiServerHandle } from "../src/ui/server.js";

describe("localhost rule manager", () => {
  let tempRoot: string;
  let projectRoot: string;
  let previousEnvironment: Record<string, string | undefined>;
  let ui: UiServerHandle | undefined;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "project-context-ui-"));
    projectRoot = join(tempRoot, "project");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(join(projectRoot, "README.md"), "# UI test\n", "utf8");
    await mkdir(join(projectRoot, "src"), { recursive: true });
    await writeFile(join(projectRoot, "src", "service.ts"), `
      import { helper } from "./helper";
      export function run() { return helper(); }
    `, "utf8");
    await writeFile(join(projectRoot, "src", "helper.ts"), `
      export function helper() { return "ok"; }
    `, "utf8");
    previousEnvironment = {
      PROJECT_CONTEXT_HOME: process.env.PROJECT_CONTEXT_HOME,
      PROJECT_CONTEXT_ALLOWED_ROOTS: process.env.PROJECT_CONTEXT_ALLOWED_ROOTS,
      PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS: process.env.PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS,
    };
    process.env.PROJECT_CONTEXT_HOME = join(tempRoot, "memory");
    process.env.PROJECT_CONTEXT_ALLOWED_ROOTS = tempRoot;
    process.env.PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS = tempRoot;
  });

  afterEach(async () => {
    await ui?.close();
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("authenticates locally and completes create, version, soft-delete, and context-preview flows", async () => {
    const app = await ProjectContextApp.create();
    const project = await app.openProject(projectRoot);
    await app.index(project.id);
    const staleMemory = app.remember(project.id, {
      type: "decision", title: "Old UI baseline", content: "The previous UI baseline is obsolete.",
      status: "stale", sourceKind: "user",
    });
    const activeMemory = app.remember(project.id, {
      type: "constraint", title: "Keep active", content: "Active project memory must not be deleted by stale cleanup.",
      sourceKind: "user",
    });
    const reviewTask = app.startTask(project.id, "Generate review candidates");
    app.completeTask(project.id, reviewTask.id, {
      summary: "The project portrait must expose explicit knowledge review actions.",
      completed: [], next: [], changedFiles: [], verification: [], blockers: [],
      risks: ["Automatic indexing must never accept memory candidates."],
    });
    await writeFile(
      join(projectRoot, "README.md"),
      "# UI test\n\nDecision: project memory review remains explicit.\n",
      "utf8",
    );
    await app.index(project.id);
    const taskToComplete = app.startTask(project.id, "Finish project portrait cleanup");
    const taskToCancel = app.startTask(project.id, "Retire obsolete project portrait work");
    app.close();
    ui = await startUiServer({ openBrowser: false });
    const origin = ui.url;
    const page = await fetch(origin);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const pageHtml = await page.text();
    expect(pageHtml).toContain("Project Context");
    expect(pageHtml).toContain("任务流水线");
    expect(pageHtml).toContain("task-workspace");
    expect(pageHtml).toContain('<section id="task-view" class="task-view">');
    expect(pageHtml).toContain('<section id="portrait-view" class="portrait-view" hidden>');
    expect(pageHtml).toContain("task-project-search");
    const [styles, appScript] = await Promise.all([
      fetch(`${origin}/styles.css`).then((response) => response.text()),
      fetch(`${origin}/app.js`).then((response) => response.text()),
    ]);
    expect(styles).toContain(".factory-scene");
    expect(styles).toContain(".task-toolbar { position: relative; z-index: 10;");
    expect(styles).toContain(".task-project-results { position: absolute;");
    expect(styles).toContain("max-height: min(262px, 42vh);");
    expect(appScript).toContain('event.key === "Escape") { event.preventDefault(); closeTaskProjectResults();');
    expect(appScript).toContain('els["task-project-search"].addEventListener("click"');
    expect(appScript).toContain('var TASK_PROJECT_STORAGE_KEY = "project-context-mcp:task-project-id";');
    expect(appScript).toContain('current = readTaskProjectId()');
    expect(appScript).toContain('storeTaskProjectId(els["task-project"].value)');
    expect(appScript).toContain('if (select === els["task-project"]) storeTaskProjectId(select.value);');
    expect(styles).toContain(".factory-station-label");
    expect(appScript).toContain("流水线正在生产");
    expect(appScript).toContain('"factory-station-label"');
    expect(appScript).toContain("factory-work-orders");
    expect(appScript).toContain("等待验证结果");

    const unauthenticated = await api(origin, "/api/bootstrap");
    expect(unauthenticated.response.status).toBe(401);

    const launch = new URL(ui.launchUrl);
    const token = new URLSearchParams(launch.hash.slice(1)).get("token");
    const session = await api(origin, "/api/session", { method: "POST", body: { token } });
    expect(session.response.status).toBe(200);
    const cookie = session.response.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toMatch(/^project_context_ui=/);
    const browserStyleGet = await fetch(`${origin}/api/bootstrap`, {
      headers: { "X-Project-Context-UI": "1", Cookie: cookie ?? "" },
    });
    expect(browserStyleGet.status).toBe(200);

    const portrait = await api(origin, `/api/projects/${project.id}/portrait`, { cookie });
    expect(portrait.response.status).toBe(200);
    expect(portrait.body).toMatchObject({
      project: { id: project.id, name: "project" },
      health: { sources: 3, schemaVersion: 6 },
      statuses: {
        memories: { active: 1, stale: 1 }, candidates: { pending: 2 },
        tasks: { completed: 1, in_progress: 2 },
      },
    });
    expect((portrait.body as { fileTypes: Array<{ extension: string; count: number }> }).fileTypes)
      .toEqual(expect.arrayContaining([expect.objectContaining({ extension: ".ts", count: 2 })]));
    expect((portrait.body as { activeTasks: Array<{ id: string; checkpoint: { next: string[] } }> }).activeTasks)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: taskToComplete.id, checkpoint: expect.objectContaining({ next: [] }) }),
      ]));
    expect((portrait.body as { completedTasks: Array<{ id: string }> }).completedTasks)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: reviewTask.id })]));
    expect((portrait.body as { pendingCandidates: Array<{ sourceRef: string | null }> }).pendingCandidates
      .filter((candidate) => candidate.sourceRef === `task:${reviewTask.id}`)).toHaveLength(1);

    await writeFile(join(projectRoot, "src", "generated.ts"), "export const generated = true;\n", "utf8");
    const indexedGenerated = await api(origin, `/api/projects/${project.id}/index`, { method: "POST", cookie, body: {} });
    expect(indexedGenerated.body).toMatchObject({ errors: [] });
    const initialIgnore = await api(origin, `/api/projects/${project.id}/ignore`, { cookie });
    expect(initialIgnore.body).toEqual({ content: "" });
    const previewIgnore = await api(origin, `/api/projects/${project.id}/ignore/preview`, {
      method: "POST", cookie, body: { content: "src/generated.ts\n" },
    });
    expect(previewIgnore.response.status).toBe(200);
    expect(previewIgnore.body).toMatchObject({ matchedCount: 1, totalIndexed: 4, samplePaths: ["src/generated.ts"] });
    await expect(readFile(join(projectRoot, ".project-context-ignore"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const invalidPreview = await api(origin, `/api/projects/${project.id}/ignore/preview`, {
      method: "POST", cookie, body: { content: "src/generated.ts\n", unexpected: true },
    });
    expect(invalidPreview.response.status).toBe(400);
    const savedIgnore = await api(origin, `/api/projects/${project.id}/ignore`, {
      method: "PUT", cookie, body: { content: "src/generated.ts\r\n*.o\r\n*.a\r\n" },
    });
    expect(savedIgnore.response.status).toBe(200);
    expect(savedIgnore.body).toMatchObject({
      content: "src/generated.ts\n*.o\n*.a\n",
      index: { removed: 1, errors: [] },
    });
    expect(await readFile(join(projectRoot, ".project-context-ignore"), "utf8"))
      .toBe("src/generated.ts\n*.o\n*.a\n");
    const invalidIgnore = await api(origin, `/api/projects/${project.id}/ignore`, {
      method: "PUT", cookie, body: { content: "bad\0pattern" },
    });
    expect(invalidIgnore.response.status).toBe(400);
    const unexpectedIgnoreField = await api(origin, `/api/projects/${project.id}/ignore`, {
      method: "PUT", cookie, body: { content: "dist/\n", unexpected: true },
    });
    expect(unexpectedIgnoreField.response.status).toBe(400);
    const oversizedIgnore = await api(origin, `/api/projects/${project.id}/ignore`, {
      method: "PUT", cookie, body: { content: "x".repeat(60_001) },
    });
    expect(oversizedIgnore.response.status).toBe(400);
    const missingProjectIgnore = await api(origin, "/api/projects/not-a-project/ignore", { cookie });
    expect(missingProjectIgnore.response.status).toBe(404);

    const indexed = await api(origin, `/api/projects/${project.id}/index`, { method: "POST", cookie, body: {} });
    expect(indexed.body).toMatchObject({ errors: [] });
    const watchStarted = await api(origin, `/api/projects/${project.id}/watch`, {
      method: "POST", cookie, body: {},
    });
    expect(watchStarted.body).toMatchObject({ projectId: project.id, debounceMs: 300 });
    const watchedPortrait = await api(origin, `/api/projects/${project.id}/portrait`, { cookie });
    expect(watchedPortrait.body).toMatchObject({ watch: { projectId: project.id } });
    const watchStopped = await api(origin, `/api/projects/${project.id}/watch`, { method: "DELETE", cookie });
    expect(watchStopped.body).toMatchObject({ projectId: project.id });

    const projectMemoryBlocked = await api(origin, `/api/projects/${project.id}/memories/${activeMemory.id}/status`, {
      method: "PATCH", cookie, body: { status: "deleted" },
    });
    expect(projectMemoryBlocked.response.status).toBe(400);
    expect(projectMemoryBlocked.body).toMatchObject({ code: "PROJECT_MEMORY_DELETE_BLOCKED" });
    const staleDeleted = await api(origin, `/api/projects/${project.id}/memories/${staleMemory.id}/status`, {
      method: "PATCH", cookie, body: { status: "deleted" },
    });
    expect(staleDeleted.body).toMatchObject({ id: staleMemory.id, status: "deleted" });

    const candidates = (portrait.body as { pendingCandidates: Array<{ id: string }> }).pendingCandidates;
    const accepted = await api(origin, `/api/projects/${project.id}/candidates/${candidates[0]!.id}/accept`, {
      method: "POST", cookie, body: {},
    });
    expect(accepted.body).toMatchObject({ status: "active" });
    const rejected = await api(origin, `/api/projects/${project.id}/candidates/${candidates[1]!.id}/reject`, {
      method: "POST", cookie, body: {},
    });
    expect(rejected.body).toMatchObject({ status: "rejected" });

    const completedTask = await api(origin, `/api/projects/${project.id}/tasks/${taskToComplete.id}/complete`, {
      method: "POST", cookie, body: {},
    });
    expect(completedTask.body).toMatchObject({ status: "completed" });
    const cancelledTask = await api(origin, `/api/projects/${project.id}/tasks/${taskToCancel.id}/cancel`, {
      method: "POST", cookie, body: {},
    });
    expect(cancelledTask.body).toMatchObject({ status: "cancelled" });
    const cleanPortrait = await api(origin, `/api/projects/${project.id}/portrait`, { cookie });
    expect(cleanPortrait.body).toMatchObject({
      statuses: {
        memories: { active: 2, deleted: 1 }, candidates: { accepted: 1, rejected: 1 },
        tasks: { completed: 2, cancelled: 1 },
      },
      staleMemories: [], activeTasks: [], pendingCandidates: [], watch: null,
    });

    const vendor = await fetch(`${origin}/vendor/cytoscape.js`);
    expect(vendor.status).toBe(200);
    expect(await vendor.text()).toContain("cytoscape");

    const graph = await api(origin, `/api/projects/${project.id}/graph?relation=CALLS&relation=IMPORTS`, { cookie });
    expect(graph.response.status).toBe(200);
    expect(graph.body).toMatchObject({ mode: "files", truncated: false });
    expect((graph.body as { nodes: unknown[]; edges: unknown[] }).nodes).toHaveLength(4);
    expect((graph.body as { edges: Array<{ relationType: string }> }).edges.map((edge) => edge.relationType))
      .toEqual(expect.arrayContaining(["CALLS", "IMPORTS"]));

    const graphSearch = await api(origin, `/api/projects/${project.id}/graph/search?q=run`, { cookie });
    expect(graphSearch.response.status).toBe(200);
    const graphResult = (graphSearch.body as { results: Array<{ id: string; label: string }> }).results[0]!;
    expect(graphResult.label).toBe("run");

    const graphNode = await api(origin, `/api/projects/${project.id}/graph/nodes/${encodeURIComponent(graphResult.id)}`, { cookie });
    expect(graphNode.body).toMatchObject({ id: graphResult.id, nodeType: "symbol", name: "run" });

    const graphNeighbors = await api(origin, `/api/projects/${project.id}/graph/neighbors?node=${encodeURIComponent(graphResult.id)}&depth=1`, { cookie });
    expect(graphNeighbors.body).toMatchObject({ mode: "symbols", root: graphResult.id });
    expect((graphNeighbors.body as { nodes: Array<{ label: string }> }).nodes.map((node) => node.label)).toContain("helper");

    const invalidGraphDepth = await api(origin, `/api/projects/${project.id}/graph/neighbors?node=${encodeURIComponent(graphResult.id)}&depth=3`, { cookie });
    expect(invalidGraphDepth.response.status).toBe(400);
    const invalidGraphRelation = await api(origin, `/api/projects/${project.id}/graph?relation=EXECUTES`, { cookie });
    expect(invalidGraphRelation.response.status).toBe(400);

    const created = await api(origin, "/api/memories", {
      method: "POST",
      cookie,
      body: {
        type: "constraint",
        title: "Project checks",
        content: "Run typecheck before tests.",
        scopeLevel: "project",
        projectId: project.id,
      },
    });
    expect(created.response.status).toBe(200);
    const createdMemory = created.body as { id: string };

    const versioned = await api(origin, `/api/memories/${createdMemory.id}`, {
      method: "PUT",
      cookie,
      body: {
        type: "constraint",
        title: "Project checks",
        content: "Run typecheck and focused tests before the full suite.",
        scopeLevel: "project",
        projectId: project.id,
      },
    });
    expect(versioned.response.status).toBe(200);
    const newMemory = versioned.body as { id: string; supersedesId: string };
    expect(newMemory.supersedesId).toBe(createdMemory.id);
    const invalidReactivation = await api(origin, `/api/memories/${createdMemory.id}/status`, {
      method: "PATCH", cookie, body: { status: "active" },
    });
    expect(invalidReactivation.response.status).toBe(400);
    expect(invalidReactivation.body).toMatchObject({ code: "USER_MEMORY_REACTIVATION_BLOCKED" });

    const preview = await api(origin, "/api/context-preview", {
      method: "POST",
      cookie,
      body: { projectId: project.id, task: "run project checks", budgetTokens: 2_000 },
    });
    expect(preview.response.status).toBe(200);
    expect((preview.body as { userMemories: Array<{ id: string }> }).userMemories.map((item) => item.id))
      .toContain(newMemory.id);

    const deleted = await api(origin, `/api/memories/${newMemory.id}/status`, {
      method: "PATCH", cookie, body: { status: "deleted" },
    });
    expect(deleted.body).toMatchObject({ id: newMemory.id, status: "deleted" });
    const bootstrap = await api(origin, "/api/bootstrap", { cookie });
    const memories = (bootstrap.body as { memories: Array<{ id: string; status: string }> }).memories;
    expect(memories).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: createdMemory.id, status: "superseded" }),
      expect.objectContaining({ id: newMemory.id, status: "deleted" }),
    ]));
  });

  it("automatically finds a renamed project directory and rebinds its active watcher", async () => {
    const app = await ProjectContextApp.create();
    const project = await app.openProject(projectRoot);
    await app.index(project.id);
    app.close();

    ui = await startUiServer({ openBrowser: false });
    const origin = ui.url;
    const launch = new URL(ui.launchUrl);
    const token = new URLSearchParams(launch.hash.slice(1)).get("token");
    const session = await api(origin, "/api/session", { method: "POST", body: { token } });
    const cookie = session.response.headers.get("set-cookie")?.split(";")[0];

    const watchStarted = await api(origin, `/api/projects/${project.id}/watch`, {
      method: "POST", cookie, body: { debounceMs: 450 },
    });
    expect(watchStarted.body).toMatchObject({ rootPath: projectRoot, debounceMs: 450 });

    const renamedRoot = join(tempRoot, "renamed-project");
    await rename(projectRoot, renamedRoot);
    const bootstrap = await api(origin, "/api/bootstrap", { cookie });
    expect(bootstrap.body).toMatchObject({
      projects: [expect.objectContaining({ id: project.id, name: "renamed-project", rootPath: renamedRoot })],
    });
    const portrait = await api(origin, `/api/projects/${project.id}/portrait`, { cookie });
    expect(portrait.body).toMatchObject({
      project: { id: project.id, name: "renamed-project", rootPath: renamedRoot },
      watch: { projectId: project.id, rootPath: renamedRoot, debounceMs: 450 },
    });

    const updated = await api(origin, `/api/projects/${project.id}`, {
      method: "PUT", cookie, body: { name: "Renamed Project", rootPath: renamedRoot },
    });
    expect(updated.response.status).toBe(200);
    expect(updated.body).toMatchObject({ id: project.id, name: "Renamed Project", rootPath: renamedRoot });

    const invalid = await api(origin, `/api/projects/${project.id}`, {
      method: "PUT", cookie, body: { name: "", rootPath: renamedRoot },
    });
    expect(invalid.response.status).toBe(400);
    await api(origin, `/api/projects/${project.id}/watch`, { method: "DELETE", cookie });
  });

  it("rejects cross-origin API requests and oversized bodies", async () => {
    ui = await startUiServer({ openBrowser: false });
    const crossOrigin = await fetch(`${ui.url}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://evil.example", "X-Project-Context-UI": "1" },
      body: JSON.stringify({ token: "anything" }),
    });
    expect(crossOrigin.status).toBe(403);

    const token = new URLSearchParams(new URL(ui.launchUrl).hash.slice(1)).get("token");
    const session = await api(ui.url, "/api/session", { method: "POST", body: { token } });
    const cookie = session.response.headers.get("set-cookie")?.split(";")[0];
    const oversized = await fetch(`${ui.url}/api/memories`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ui.url,
        "X-Project-Context-UI": "1",
        Cookie: cookie ?? "",
      },
      body: JSON.stringify({ content: "x".repeat(70_000) }),
    });
    expect(oversized.status).toBe(413);
  });
});

async function api(origin: string, path: string, options: {
  method?: string;
  body?: unknown;
  cookie?: string;
} = {}): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(`${origin}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      "X-Project-Context-UI": "1",
      ...(options.cookie ? { Cookie: options.cookie } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { response, body: await response.json() };
}
