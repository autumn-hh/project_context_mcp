import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { ProjectContextApp } from "../src/core/app.js";

describe("selected project identity during lightweight initialization", () => {
  let root: string;
  let databasePath: string;
  let projectId: string;
  let app: ProjectContextApp | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "project-identity-"));
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    vi.stubEnv("PROJECT_CONTEXT_HOME", join(root, "memory"));
    vi.stubEnv("PROJECT_CONTEXT_ALLOWED_ROOTS", root);
    vi.stubEnv("PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS", root);
    app = await ProjectContextApp.create();
    projectId = (await app.openProject(projectRoot)).id;
    app.startTask(projectId, "Read selected task");
    databasePath = join(projectRoot, ".project-context", "project.db");
    app.close(); app = undefined;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    app?.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("rejects a mismatched database before migration and closes the failed connection", async () => {
    const setup = new Database(databasePath);
    try {
      setup.prepare("UPDATE metadata SET value = ? WHERE key = 'project_id'").run("another-project");
      setup.pragma("user_version = 7");
    } finally { setup.close(); }
    app = await ProjectContextApp.create({ initializeProjects: false });
    const close = vi.spyOn(Database.prototype, "close");
    expect(() => app!.projects.projectDatabase(projectId)).toThrowError(
      expect.objectContaining({ code: "PROJECT_DATABASE_IDENTITY_MISMATCH" }),
    );
    expect(close).toHaveBeenCalledTimes(1);
    const inspect = new Database(databasePath, { readonly: true });
    try {
      expect(inspect.pragma("user_version", { simple: true })).toBe(7);
      expect(inspect.prepare("SELECT value FROM metadata WHERE key = 'project_id'").pluck().get()).toBe("another-project");
    } finally { inspect.close(); }
    const summaries = app.queryTaskSummaries({ projectId });
    expect(summaries.items).toEqual([]);
    expect(summaries.warnings[0]?.code).toBe("PROJECT_DATABASE_IDENTITY_MISMATCH");
  });

  it.each([false, true])("reads an identity-less database without integrity scans (legacy layout: %s)", async (legacy) => {
    const setup = new Database(databasePath);
    try { setup.prepare("DELETE FROM metadata WHERE key = 'project_id'").run(); }
    finally { setup.close(); }
    if (legacy) {
      const legacyDirectory = join(root, "memory", "projects", projectId);
      await mkdir(legacyDirectory, { recursive: true });
      const legacyPath = join(legacyDirectory, "project.db");
      await rename(databasePath, legacyPath);
      databasePath = legacyPath;
      const registry = new Database(join(root, "memory", "registry.db"));
      try { registry.prepare("UPDATE projects SET storage_layout = NULL WHERE id = ?").run(projectId); }
      finally { registry.close(); }
    }
    const pragma = vi.spyOn(Database.prototype, "pragma");
    app = await ProjectContextApp.create({ initializeProjects: false });
    const page = app.queryTaskSummaries({ projectId });
    expect(page).toMatchObject({ total: 1, partial: false });
    expect(page.items[0]?.goal).toBe("Read selected task");
    expect(pragma.mock.calls.some(([sql]) => /quick_check|integrity_check|foreign_key_check/i.test(sql))).toBe(false);
    const inspect = new Database(databasePath, { readonly: true });
    try { expect(inspect.prepare("SELECT value FROM metadata WHERE key = 'project_id'").get()).toBeUndefined(); }
    finally { inspect.close(); }
  });
});
