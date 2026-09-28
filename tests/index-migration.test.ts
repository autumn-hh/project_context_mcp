import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectContextApp } from "../src/core/app.js";
import * as maintenance from "../src/maintenance/storage-maintenance.js";

describe("index migration results and safety", () => {
  let root: string;
  let projectRoot: string;
  let app: ProjectContextApp;
  let projectId: string;
  let previous: Record<string, string | undefined>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "project-context-migration-"));
    projectRoot = join(root, "project");
    await mkdir(join(projectRoot, "src"), { recursive: true });
    await mkdir(join(projectRoot, "references"), { recursive: true });
    await writeFile(join(projectRoot, "src", "service.ts"), 'export function calculateInvoice() { return "invoice"; }');
    await writeFile(join(projectRoot, "references", "helper.js"), 'export function referencesHelper() { return "references-only-token"; }');
    previous = Object.fromEntries(["PROJECT_CONTEXT_HOME", "PROJECT_CONTEXT_ALLOWED_ROOTS", "PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS"].map((key) => [key, process.env[key]]));
    process.env.PROJECT_CONTEXT_HOME = join(root, "storage");
    process.env.PROJECT_CONTEXT_ALLOWED_ROOTS = root;
    process.env.PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS = root;
    app = await ProjectContextApp.create();
    projectId = (await app.openProject(projectRoot)).id;
    await app.index(projectId);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    app?.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { force: true, recursive: true });
  });

  it("reports whole-migration totals, retains its backup and preserves memories and source files", async () => {
    const memory = app.remember(projectId, { type: "decision", title: "Preserve business code", content: "Do not delete project source files.", sourceKind: "user" });
    const originalIgnore = "# Existing user rules\nkeep-me-out/**\n";
    await writeFile(join(projectRoot, ".project-context-ignore"), originalIgnore);
    const result = await app.optimizeProjectIndex(projectId, ["references"]) as any;
    expect(result.status).toBe("completed");
    expect(result.warnings).toEqual([]);
    expect(result.reclaimedBytes).toBe(Math.max(0, result.before.totalBytes - result.after.totalBytes));
    expect(result.byteChange).toBe(result.after.totalBytes - result.before.totalBytes);
    expect(result.retainedBackupBytes).toBe((await stat(result.backupDestination)).size);
    expect(result.backupDestination).toBe(result.backup.destination);
    expect(result.ignoreRulesSaved).toBe(true);
    expect(result.index.removed).toBeGreaterThan(0);
    expect(await readFile(join(projectRoot, ".project-context-ignore"), "utf8")).toContain(originalIgnore);
    expect(await readFile(join(projectRoot, ".project-context-ignore"), "utf8")).toContain("/references/**");
    expect(await readFile(join(projectRoot, "references", "helper.js"), "utf8")).toContain("references-only-token");
    expect(app.memory(projectId, memory.id).status).toBe("active");
    expect(app.search(projectId, "calculateInvoice").length).toBeGreaterThan(0);
    const db = app.projects.projectDatabase(projectId);
    try { expect(db.prepare("SELECT COUNT(*) FROM sources WHERE path LIKE 'references/%'").pluck().get()).toBe(0); }
    finally { db.close(); }
  });

  it("previews nested directories without treating root files or glob paths as selectable, and handles parent-child exclusions", async () => {
    await writeFile(join(projectRoot, "README.md"), "Migration root document");
    await mkdir(join(projectRoot, "references", "deep"), { recursive: true });
    await writeFile(join(projectRoot, "references", "deep", "example.ts"), "export const nestedReference = 1;");
    await mkdir(join(projectRoot, "unsafe[1]"), { recursive: true });
    await writeFile(join(projectRoot, "unsafe[1]", "example.ts"), "export const unsafeName = 1;");
    await app.index(projectId);
    const preview = app.indexMigrationPreview(projectId);
    const paths = preview.directories.map((item) => item.path);
    expect(paths).toContain("references");
    expect(paths).toContain("references/deep");
    expect(paths).not.toContain("README.md");
    expect(paths).not.toContain("unsafe[1]");
    expect(preview.totalIndexedFiles).toBe(5);
    await expect(app.optimizeProjectIndex(projectId, ["unsafe[1]"])).rejects.toMatchObject({ code: "INVALID_MIGRATION_EXCLUSION" });
    const result = await app.optimizeProjectIndex(projectId, ["references", "references/deep", "references"]) as any;
    expect(result.status).toBe("completed");
    expect(result.excludeDirectories).toEqual(["references", "references/deep"]);
    expect(result.index.removed).toBe(2);
    expect(await readFile(join(projectRoot, "references", "deep", "example.ts"), "utf8")).toContain("nestedReference");
  });

  it("recommends only recognized worktree containers, not ancestors, descendants or business directories", async () => {
    for (const path of [".kilo/worktrees/copy/src", ".claude/worktrees/copy", ".worktrees/copy", "src/worktrees", "examples", "langgraph_learning", "assets"]) {
      await mkdir(join(projectRoot, path), { recursive: true });
      await writeFile(join(projectRoot, path, "entry.ts"), "export const exampleValue = 1;");
    }
    await app.index(projectId);
    const preview = app.indexMigrationPreview(projectId);
    expect(preview.directories.filter(row => row.recommended).map(row => row.path).sort()).toEqual([
      ".claude/worktrees", ".kilo/worktrees", ".worktrees",
    ]);
    expect((await app.readProjectIgnore(projectId)).content).toBe("");
  });

  it.each([
    { vacuumCompleted: false, checkpointBusy: false, warnings: [] },
    { vacuumCompleted: true, checkpointBusy: true, warnings: [] },
    { vacuumCompleted: true, checkpointBusy: false, warnings: ["Cleanup history warning"] },
  ])("reports partial completion for incomplete compaction or cleanup warnings: %j", async (outcome) => {
    const cleanup = maintenance.cleanupDatabase;
    vi.spyOn(maintenance, "cleanupDatabase").mockImplementation((...args) => ({ ...cleanup(...args), ...outcome }));
    const result = await app.optimizeProjectIndex(projectId) as any;
    expect(result.status).toBe("partial");
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.backupDestination).toBeTruthy();
    expect(result.cleanup).toMatchObject(outcome);
  });

  it("does not claim success when the index reports file errors", async () => {
    const realResult = await app.index(projectId);
    vi.spyOn(app as any, "indexInternal").mockResolvedValue({ ...realResult, errors: [{ path: "src/service.ts", message: "unreadable fixture" }] });
    const result = await app.optimizeProjectIndex(projectId) as any;
    expect(result.status).toBe("partial");
    expect(result.warnings.join(" ")).toContain("1 file error");
    expect(result.index.errors).toHaveLength(1);
  });

  it("rejects unknown directories before creating a backup or modifying ignore rules", async () => {
    const backup = vi.spyOn(app, "backup");
    await expect(app.optimizeProjectIndex(projectId, ["../outside"])).rejects.toMatchObject({ code: "INVALID_MIGRATION_EXCLUSION" });
    expect(backup).not.toHaveBeenCalled();
    expect((await app.readProjectIgnore(projectId)).content).toBe("");
    expect((await app.optimizeProjectIndex(projectId)).status).toBe("completed");
  });

  it("rejects overlapping migration, index and cleanup while backup is running, then releases the guard", async () => {
    const originalBackup = app.backup.bind(app);
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(app, "backup").mockImplementation(async (...args) => { entered(); await gate; return originalBackup(...args); });
    const migration = app.optimizeProjectIndex(projectId);
    await ready;
    try {
      await expect(app.optimizeProjectIndex(projectId)).rejects.toMatchObject({ code: "INDEX_ALREADY_RUNNING" });
      await expect(app.index(projectId)).rejects.toMatchObject({ code: "INDEX_MIGRATION_RUNNING" });
      expect(() => app.cleanupProject(projectId, { dryRun: false, confirmProjectId: projectId })).toThrow();
      await expect(app.writeProjectIgnore(projectId, "src/**")).rejects.toMatchObject({ code: "INDEX_MIGRATION_RUNNING" });
    } finally { release(); }
    expect((await migration).status).toBe("completed");
    await expect(app.index(projectId)).resolves.toMatchObject({ errors: [] });
  });

  it("retains the backup location and saved-rule state when indexing fails, and permits retry", async () => {
    const spy = vi.spyOn(app as any, "indexInternal").mockRejectedValueOnce(new Error("index failed fixture"));
    let failure: any;
    try { await app.optimizeProjectIndex(projectId, ["references"]); }
    catch (error) { failure = error; }
    expect(failure.code).toBe("INDEX_MIGRATION_FAILED");
    expect(failure.details.ignoreRulesSaved).toBe(true);
    expect((await stat(failure.details.backupDestination)).size).toBeGreaterThan(0);
    spy.mockRestore();
    expect((await app.optimizeProjectIndex(projectId)).status).toBe("completed");
  });
});
