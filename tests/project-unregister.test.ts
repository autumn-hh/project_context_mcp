import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { ProjectContextApp, stopAllProjectWatches } from "../src/core/app.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, statSync: vi.fn(original.statSync) };
});

describe("missing project registration removal", () => {
  let root: string;
  let projectRoot: string;
  let databasePath: string;
  let app: ProjectContextApp;
  let projectId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "project-unregister-"));
    projectRoot = join(root, "project");
    await mkdir(projectRoot);
    await writeFile(join(projectRoot, "README.md"), "Keep source files");
    vi.stubEnv("PROJECT_CONTEXT_HOME", join(root, "memory"));
    vi.stubEnv("PROJECT_CONTEXT_ALLOWED_ROOTS", root);
    vi.stubEnv("PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS", root);
    app = await ProjectContextApp.create();
    projectId = (await app.openProject(projectRoot)).id;
    databasePath = join(projectRoot, ".project-context", "project.db");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    stopAllProjectWatches();
    app?.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("removes only the missing registration, retaining sources, backups and project-scoped rules", async () => {
    const rule = app.rememberUser({ type: "constraint", title: "Retained rule", content: "Keep provenance", scopeLevel: "project", projectId, sourceKind: "user" });
    const backup = join(root, "memory", "backup.db");
    await writeFile(backup, "backup remains");
    await rm(databasePath);
    app.watchStart(projectId, 60_000, false);
    expect(app.unregisterMissingProject(projectId, projectId)).toMatchObject({ projectId, unregistered: true, filesDeleted: false });
    expect(app.projects.list(true)).toEqual([]);
    expect(app.watchList()).toEqual([]);
    expect(await readFile(join(projectRoot, "README.md"), "utf8")).toBe("Keep source files");
    expect(await readFile(backup, "utf8")).toBe("backup remains");
    const registry = new Database(join(root, "memory", "registry.db"), { readonly: true });
    try { expect(registry.prepare("SELECT project_id FROM user_memories WHERE id = ?").pluck().get(rule.id)).toBe(projectId); }
    finally { registry.close(); }
  });

  it("rejects a healthy database and mismatched confirmation without stopping its watcher", () => {
    app.watchStart(projectId, 60_000, false);
    expect(() => app.unregisterMissingProject(projectId, "wrong")).toThrowError(expect.objectContaining({ code: "PROJECT_UNREGISTER_CONFIRMATION_MISMATCH" }));
    expect(() => app.unregisterMissingProject(projectId, projectId)).toThrowError(expect.objectContaining({ code: "PROJECT_DATABASE_PRESENT" }));
    expect(app.watchList()).toHaveLength(1);
    expect(app.projects.list(true)).toHaveLength(1);
  });

  it.each(["-wal", "-shm", "-journal"])("rejects a remaining %s sidecar", async (suffix) => {
    await rm(databasePath);
    await writeFile(databasePath + suffix, "recoverable state");
    expect(() => app.unregisterMissingProject(projectId, projectId)).toThrowError(expect.objectContaining({ code: "PROJECT_DATABASE_PRESENT" }));
    expect(await readFile(databasePath + suffix, "utf8")).toBe("recoverable state");
  });

  it("checks legacy storage too", async () => {
    await rm(databasePath);
    const legacyDirectory = join(root, "memory", "projects", projectId);
    await mkdir(legacyDirectory, { recursive: true });
    await writeFile(join(legacyDirectory, "project.db"), "legacy data");
    expect(() => app.unregisterMissingProject(projectId, projectId)).toThrowError(expect.objectContaining({ code: "PROJECT_DATABASE_PRESENT" }));
  });

  it("refuses permission failures instead of interpreting them as absence", () => {
    vi.mocked(fs.statSync).mockImplementationOnce(() => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
    expect(() => app.unregisterMissingProject(projectId, projectId)).toThrowError(expect.objectContaining({ code: "PROJECT_DATABASE_STATE_UNREADABLE" }));
    expect(app.projects.list(true)).toHaveLength(1);
  });

  it("refuses removal while another live process owns a migration", async () => {
    await rm(databasePath);
    const directory = join(projectRoot, ".project-context", "migration-jobs");
    await mkdir(directory);
    const requestId = "12345678-1234-1234-1234-123456789abc";
    await writeFile(join(directory, "active.json"), JSON.stringify({ requestId }));
    await writeFile(join(directory, requestId + ".json"), JSON.stringify({ status: "running", ownerPid: process.pid }));
    expect(() => app.unregisterMissingProject(projectId, projectId)).toThrowError(expect.objectContaining({ code: "INDEX_MIGRATION_RUNNING" }));
    expect(app.projects.list(true)).toHaveLength(1);
  });
});
