import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectContextApp } from "../src/core/app.js";
import { startUiServer, type UiServerHandle } from "../src/ui/server.js";

describe("index migration API", () => {
  let tempRoot: string;
  let projectRoot: string;
  let projectId: string;
  let ui: UiServerHandle;
  let cookie: string;
  let previousEnvironment: Record<string, string | undefined>;
  const service = "export function gradingCalculator() { return '实验评分'; }\n";

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "project-context-migration-ui-"));
    projectRoot = join(tempRoot, "project");
    await mkdir(join(projectRoot, "src"), { recursive: true });
    await mkdir(join(projectRoot, "references"), { recursive: true });
    await writeFile(join(projectRoot, "src", "service.ts"), service);
    await writeFile(join(projectRoot, "references", "copy.ts"), service);
    previousEnvironment = {
      PROJECT_CONTEXT_HOME: process.env.PROJECT_CONTEXT_HOME,
      PROJECT_CONTEXT_ALLOWED_ROOTS: process.env.PROJECT_CONTEXT_ALLOWED_ROOTS,
      PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS: process.env.PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS,
    };
    process.env.PROJECT_CONTEXT_HOME = join(tempRoot, "memory");
    process.env.PROJECT_CONTEXT_ALLOWED_ROOTS = tempRoot;
    process.env.PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS = tempRoot;
    const app = await ProjectContextApp.create();
    try {
      projectId = (await app.openProject(projectRoot)).id;
      await app.index(projectId);
    } finally { app.close(); }
    ui = await startUiServer({ openBrowser: false });
    const token = new URLSearchParams(new URL(ui.launchUrl).hash.slice(1)).get("token");
    const session = await request("/api/session", { method: "POST", body: { token }, authenticated: false });
    cookie = session.response.headers.get("set-cookie")!.split(";")[0]!;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await ui?.close();
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  function route(): string { return `/api/projects/${projectId}/optimize-index`; }

  async function request(path: string, options: { method?: string; body?: unknown; authenticated?: boolean } = {}) {
    const response = await fetch(`${ui.url}${path}`, {
      method: options.method ?? "GET",
      headers: {
        "Content-Type": "application/json", Origin: ui.url, "X-Project-Context-UI": "1",
        ...(options.authenticated === false ? {} : { Cookie: cookie }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return { response, body: await response.json() };
  }

  it("requires authentication and returns a read-only directory preview", async () => {
    // A main-thread implementation would hit this spy. Worker computation must
    // still return real persisted data and preserve the existing auth/errors.
    const mainThreadPreview = vi.spyOn(ProjectContextApp.prototype, "indexMigrationPreview")
      .mockImplementation(() => { throw new Error("Preview must not execute on the HTTP thread"); });
    for (const method of ["GET", "POST"]) {
      const denied = await request(route(), { method, authenticated: false, ...(method === "POST" ? { body: {} } : {}) });
      expect(denied.response.status).toBe(401);
    }
    const preview = await request(route());
    expect(preview.response.status).toBe(200);
    expect(preview.body).toMatchObject({
      totalIndexedFiles: 2, sourceBytes: expect.any(Number), note: expect.any(String),
      directories: expect.arrayContaining([
        expect.objectContaining({ path: "references", files: 1, chunks: 1 }),
        expect.objectContaining({ path: "src", files: 1 }),
      ]),
    });
    await expect(readFile(join(projectRoot, ".project-context-ignore"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await request("/api/projects/missing/optimize-index")).response.status).toBe(404);
    expect(mainThreadPreview).not.toHaveBeenCalled();
  });

  it("validates project confirmation and directory exclusions before mutation", async () => {
    const invalidBodies = [
      {}, { confirmProjectId: "other" },
      { confirmProjectId: projectId, extra: true },
      { confirmProjectId: projectId, excludeDirectories: "references" },
      { confirmProjectId: projectId, excludeDirectories: ["../outside"] },
      { confirmProjectId: projectId, excludeDirectories: ["missing"] },
      { confirmProjectId: projectId, excludeDirectories: ["src/**"] },
    ];
    for (const body of invalidBodies) expect((await request(route(), { method: "POST", body })).response.status).toBe(400);
    await expect(readFile(join(projectRoot, ".project-context-ignore"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await request(route())).body).toMatchObject({ totalIndexedFiles: 2 });
  });

  it("allows no exclusions and saves explicit exclusions without removing source files", async () => {
    const plain = await request(route(), { method: "POST", body: { confirmProjectId: projectId } });
    expect(plain.response.status).toBe(200);
    expect(plain.body).toMatchObject({ status: "completed", excludeDirectories: [], ignoreRulesSaved: false, index: { errors: [] } });
    const selected = await request(route(), {
      method: "POST", body: { confirmProjectId: projectId, excludeDirectories: ["references"] },
    });
    expect(selected.response.status).toBe(200);
    expect(selected.body).toMatchObject({
      status: "completed", excludeDirectories: ["references"], ignoreRulesSaved: true,
      index: { errors: [] }, cleanup: { vacuumCompleted: true },
      before: { totalBytes: expect.any(Number) }, after: { totalBytes: expect.any(Number) },
      retainedBackupBytes: expect.any(Number), backupDestination: expect.any(String),
    });
    expect(selected.body.reclaimedBytes).toBe(Math.max(0, selected.body.before.totalBytes - selected.body.after.totalBytes));
    expect(await readFile(join(projectRoot, ".project-context-ignore"), "utf8")).toContain("/references/**");
    expect(await readFile(join(projectRoot, "references", "copy.ts"), "utf8")).toBe(service);
    expect(selected.body).toMatchObject({ backupStatus: "deleted", retainedBackupBytes: 0 });
    await expect(stat(selected.body.backupDestination)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await request(route())).body.directories).not.toEqual(expect.arrayContaining([expect.objectContaining({ path: "references" })]));
  });

  it("returns backup and recovery details when migration fails after backup", async () => {
    vi.spyOn(ProjectContextApp.prototype, "readProjectIgnore").mockRejectedValueOnce(new Error("simulated ignore read failure"));
    const failed = await request(route(), { method: "POST", body: { confirmProjectId: projectId, excludeDirectories: ["references"] } });
    expect(failed.response.status).toBeGreaterThanOrEqual(400);
    expect(failed.body).toMatchObject({
      code: "INDEX_MIGRATION_FAILED",
      details: { backupDestination: expect.any(String), ignoreRulesSaved: false, recovery: expect.any(String) },
    });
    expect((await stat(failed.body.details.backupDestination)).size).toBeGreaterThan(0);
    expect(await readFile(join(projectRoot, "references", "copy.ts"), "utf8")).toBe(service);
    const retry = await request(route(), { method: "POST", body: { confirmProjectId: projectId } });
    expect(retry.response.status).toBe(200);
    expect(retry.body.status).toBe("completed");
  });

  it("checks space and retries compaction without backup or indexing", async () => {
    const spacePath = `/api/projects/${projectId}/migration-space`;
    const compactPath = `/api/projects/${projectId}/compact-index`;
    expect((await request(spacePath, { authenticated: false })).response.status).toBe(401);
    expect((await request(compactPath, { method: "POST", body: {}, authenticated: false })).response.status).toBe(401);
    expect((await request(spacePath + "?mode=invalid")).response.status).toBe(400);
    expect((await request(compactPath, { method: "POST", body: { confirmProjectId: "other" } })).response.status).toBe(400);
    const check = await request(spacePath + "?mode=compact");
    expect(check.body).toMatchObject({ sufficient: true, checks: expect.any(Array) });
    const backup = vi.spyOn(ProjectContextApp.prototype, "backup");
    const index = vi.spyOn(ProjectContextApp.prototype, "index");
    const result = await request(compactPath, { method: "POST", body: { confirmProjectId: projectId } });
    expect(result.response.status).toBe(200);
    expect(result.body).toMatchObject({ status: "completed", before: { totalBytes: expect.any(Number) }, after: { totalBytes: expect.any(Number) } });
    expect(backup).not.toHaveBeenCalled(); expect(index).not.toHaveBeenCalled();
    const blocked = { sufficient: false, checks: [{ path: tempRoot, roles: ["database"], availableBytes: 0, requiredBytes: 100, shortfallBytes: 100 }], warnings: [] };
    vi.spyOn(ProjectContextApp.prototype, "migrationSpaceCheck").mockResolvedValue(blocked as any);
    const failed = await request(route(), { method: "POST", body: { confirmProjectId: projectId } });
    expect(failed.response.status).toBeGreaterThanOrEqual(400);
    expect(failed.body.details).toMatchObject({ phase: "preflight", backupCompleted: false, spaceCheck: { sufficient: false } });
    expect(backup).not.toHaveBeenCalled();
  });

  it("returns directories beyond the former 60-entry limit", async () => {
    for (let i = 0; i < 105; i++) {
      const path = join(projectRoot, `folder-${String(i).padStart(3, "0")}`);
      await mkdir(path); await writeFile(join(path, "file.txt"), `indexed folder ${i}`);
    }
    const app = await ProjectContextApp.create();
    try { await app.index(projectId); } finally { app.close(); }
    const preview = await request(route());
    expect(preview.body.directories.length).toBe(107);
    expect(preview.body.directories).toEqual(expect.arrayContaining([expect.objectContaining({ path: "folder-104" })]));
  });
});
