import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { access, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { ProjectContextApp } from "../src/core/app.js";

describe("personal storage lifecycle", () => {
  let tempRoot: string;
  let storageRoot: string;
  let projectRoot: string;
  let previousEnvironment: Record<string, string | undefined>;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "project-context-personal-"));
    storageRoot = join(tempRoot, "memory");
    projectRoot = join(tempRoot, "project");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(join(projectRoot, "README.md"), [
      "# Project",
      "",
      "Decision: keep verified project memory local.",
      "The decision applies to every client.",
      "",
      "## Notes",
      "Routine notes.",
      "",
    ].join("\n"), "utf8");
    previousEnvironment = {
      PROJECT_CONTEXT_HOME: process.env.PROJECT_CONTEXT_HOME,
      PROJECT_CONTEXT_ALLOWED_ROOTS: process.env.PROJECT_CONTEXT_ALLOWED_ROOTS,
      PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS: process.env.PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS,
    };
    process.env.PROJECT_CONTEXT_HOME = storageRoot;
    process.env.PROJECT_CONTEXT_ALLOWED_ROOTS = tempRoot;
    process.env.PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS = tempRoot;
  });

  afterEach(async () => {
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("stores new project databases inside each project root", async () => {
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      await expect(access(join(projectRoot, ".project-context", "project.db"))).resolves.toBeUndefined();
      await expect(access(join(storageRoot, "projects", project.id, "project.db"))).rejects.toMatchObject({ code: "ENOENT" });
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(join(projectRoot, ".project-context", "project.db"), { readonly: true });
      expect(db.prepare("SELECT value FROM metadata WHERE key = 'project_id'").pluck().get()).toBe(project.id);
      db.close();
    } finally {
      app.close();
    }
  });

  it("automatically recovers a moved project while preserving a custom name", async () => {
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      app.updateProject(project.id, "Custom Project Name");
      const movedRoot = join(tempRoot, "moved-project");
      await rename(projectRoot, movedRoot);

      await expect(app.reconcileMovedProjects()).resolves.toEqual([
        expect.objectContaining({ id: project.id, rootPath: movedRoot, name: "Custom Project Name" }),
      ]);
      expect(app.projects.get(project.id)).toMatchObject({ rootPath: movedRoot, name: "Custom Project Name" });
    } finally {
      app.close();
    }
  });

  it("backfills stable identities for databases created before automatic recovery", async () => {
    const firstApp = await ProjectContextApp.create();
    const project = await firstApp.openProject(projectRoot);
    firstApp.close();

    const Database = (await import("better-sqlite3")).default;
    const databasePath = join(projectRoot, ".project-context", "project.db");
    const legacyDb = new Database(databasePath);
    legacyDb.prepare("DELETE FROM metadata WHERE key = 'project_id'").run();
    legacyDb.close();

    const reopenedApp = await ProjectContextApp.create();
    try {
      const reopenedDb = new Database(databasePath, { readonly: true });
      expect(reopenedDb.prepare("SELECT value FROM metadata WHERE key = 'project_id'").pluck().get()).toBe(project.id);
      reopenedDb.close();
    } finally {
      reopenedApp.close();
    }
  });

  it("defers full database integrity checks until explicit diagnosis", async () => {
    const firstApp = await ProjectContextApp.create();
    const project = await firstApp.openProject(projectRoot);
    firstApp.close();

    const Database = (await import("better-sqlite3")).default;
    const databasePath = join(projectRoot, ".project-context", "project.db");
    const damagedDb = new Database(databasePath);
    damagedDb.pragma("foreign_keys = OFF");
    damagedDb.prepare(`
      INSERT INTO chunks (id, source_id, source_path, content, start_line, end_line)
      VALUES ('orphan_chunk', 'missing_source', 'missing.ts', 'orphan', 1, 1)
    `).run();
    damagedDb.close();

    const reopenedApp = await ProjectContextApp.create();
    try {
      expect(reopenedApp.projects.get(project.id)).toMatchObject({ id: project.id, rootPath: projectRoot });
      await expect(reopenedApp.doctor(project.id)).resolves.toMatchObject({
        ok: false,
        issues: expect.arrayContaining([expect.stringContaining("foreign_key_check: 1 violation")]),
      });
    } finally {
      reopenedApp.close();
    }
  });

  it("does not guess when multiple databases claim the same project identity", async () => {
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      const firstCandidate = join(tempRoot, "candidate-one");
      const secondCandidate = join(tempRoot, "candidate-two");
      await rename(projectRoot, firstCandidate);
      await mkdir(join(secondCandidate, ".project-context"), { recursive: true });
      await copyFile(
        join(firstCandidate, ".project-context", "project.db"),
        join(secondCandidate, ".project-context", "project.db"),
      );

      await expect(app.reconcileMovedProjects()).resolves.toEqual([]);
      expect(app.projects.get(project.id).rootPath).toBe(projectRoot);
    } finally {
      app.close();
    }
  });

  it("ignores a moved database whose stable identity does not match", async () => {
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      const movedRoot = join(tempRoot, "wrong-identity");
      await rename(projectRoot, movedRoot);
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(join(movedRoot, ".project-context", "project.db"));
      db.prepare("UPDATE metadata SET value = ? WHERE key = 'project_id'").run("prj_not_the_registered_project");
      db.close();

      await expect(app.reconcileMovedProjects()).resolves.toEqual([]);
      expect(app.projects.get(project.id).rootPath).toBe(projectRoot);
    } finally {
      app.close();
    }
  });

  it("migrates legacy central project databases with a recovery backup", async () => {
    const firstApp = await ProjectContextApp.create();
    const project = await firstApp.openProject(projectRoot);
    const memory = firstApp.remember(project.id, {
      type: "decision",
      title: "Migration baseline",
      content: "Project-local storage preserves existing durable data.",
      sourceKind: "user",
    });
    firstApp.close();

    const localDatabase = join(projectRoot, ".project-context", "project.db");
    const legacyDatabase = join(storageRoot, "projects", project.id, "project.db");
    await mkdir(join(storageRoot, "projects", project.id), { recursive: true });
    await rename(localDatabase, legacyDatabase);
    const Database = (await import("better-sqlite3")).default;
    const registry = new Database(join(storageRoot, "registry.db"));
    registry.prepare("UPDATE projects SET storage_layout = NULL WHERE id = ?").run(project.id);
    registry.close();

    const migratedApp = await ProjectContextApp.create();
    try {
      expect(migratedApp.memories(project.id).map((item) => item.id)).toContain(memory.id);
      await expect(access(localDatabase)).resolves.toBeUndefined();
      await expect(access(legacyDatabase)).rejects.toMatchObject({ code: "ENOENT" });
      const recoveryFiles = await readdir(join(storageRoot, "recovery"));
      expect(recoveryFiles.some((name) => name.startsWith(`${project.id}-pre-project-layout-`))).toBe(true);
    } finally {
      migratedApp.close();
    }
  });

  it("merges applicable user memories without leaking project scopes", async () => {
    const secondRoot = join(tempRoot, "second-project");
    await mkdir(secondRoot, { recursive: true });
    await writeFile(join(secondRoot, "README.md"), "# Second\n", "utf8");
    const app = await ProjectContextApp.create();
    try {
      const first = await app.openProject(projectRoot);
      const second = await app.openProject(secondRoot);
      const global = app.rememberUser({
        type: "constraint",
        title: "Type checking",
        content: "Run typecheck before tests.",
        sourceKind: "user",
      });
      const scoped = app.rememberUser({
        type: "preference",
        title: "Project test runner",
        content: "Use Vitest for this project.",
        sourceKind: "user",
        scopeLevel: "project",
        projectId: first.id,
      });
      const module = app.rememberUser({
        type: "constraint",
        title: "Authentication review",
        content: "Review authentication changes carefully.",
        sourceKind: "user",
        scopeLevel: "module",
        projectId: first.id,
        scopeRef: "authentication",
      });

      const firstContext = app.context(first.id, "change authentication", 4_000);
      expect(firstContext.userMemories.map((memory) => memory.id)).toEqual(expect.arrayContaining([
        global.id, scoped.id, module.id,
      ]));
      const secondContext = app.context(second.id, "change authentication", 4_000);
      expect(secondContext.userMemories.map((memory) => memory.id)).toContain(global.id);
      expect(secondContext.userMemories.map((memory) => memory.id)).not.toContain(scoped.id);
      expect(secondContext.userMemories.map((memory) => memory.id)).not.toContain(module.id);
    } finally {
      app.close();
    }
  });

  it("archives, renames, relocates, and safely deletes projects", async () => {
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      const originalDatabase = join(projectRoot, ".project-context", "project.db");
      expect(app.updateProject(project.id, "Personal Project").name).toBe("Personal Project");
      expect(app.archiveProject(project.id).archivedAt).not.toBeNull();
      expect(app.projects.list().map((item) => item.id)).not.toContain(project.id);
      expect(app.projects.list(true).map((item) => item.id)).toContain(project.id);

      const relocatedRoot = join(tempRoot, "relocated");
      await mkdir(relocatedRoot, { recursive: true });
      expect((await app.relocateProject(project.id, relocatedRoot)).rootPath).toBe(relocatedRoot);
      await expect(access(join(relocatedRoot, ".project-context", "project.db"))).resolves.toBeUndefined();
      await expect(access(originalDatabase)).rejects.toMatchObject({ code: "ENOENT" });
      const preview = await app.deleteProject(project.id, { confirmProjectId: project.id });
      expect(preview).toMatchObject({ deleted: false, purgeRequired: true });
      const backup = join(tempRoot, "deleted-backup", "project.db");
      const deleted = await app.deleteProject(project.id, {
        confirmProjectId: project.id,
        purge: true,
        backupDestination: backup,
      });
      expect(deleted).toMatchObject({ deleted: true, backupDestination: backup });
      await expect(access(backup)).resolves.toBeUndefined();
      expect(() => app.projects.get(project.id)).toThrow(/Unknown project/);
    } finally {
      app.close();
    }
  });

  it("restores backups into new projects and rolls back archived projects", async () => {
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      await app.index(project.id);
      const durable = app.remember(project.id, {
        type: "decision",
        title: "Durable baseline",
        content: "The backup contains this decision.",
        sourceKind: "user",
      });
      const backup = join(tempRoot, "backups", "baseline.db");
      await app.backup(project.id, backup);
      const later = app.remember(project.id, {
        type: "fact",
        title: "Later state",
        content: "This state should disappear after rollback.",
        sourceKind: "user",
      });

      const restoredRoot = join(tempRoot, "restored-project");
      await mkdir(restoredRoot, { recursive: true });
      const restored = await app.restoreProject({ source: backup, root: restoredRoot, name: "Restored" });
      const restoredProject = (restored.project as { id: string; name: string });
      expect(restoredProject.name).toBe("Restored");
      expect(app.memories(restoredProject.id).map((memory) => memory.id)).toContain(durable.id);
      expect(app.memories(restoredProject.id).map((memory) => memory.id)).not.toContain(later.id);

      app.archiveProject(project.id);
      const rollback = await app.restoreProject({
        source: backup,
        projectId: project.id,
        confirmProjectId: project.id,
      });
      expect(rollback).toMatchObject({ restored: true, replacedExisting: true });
      expect(await stat(String(rollback.safetyBackup))).toMatchObject({ size: expect.any(Number) });
      expect(app.memories(project.id).map((memory) => memory.id)).toContain(durable.id);
      expect(app.memories(project.id).map((memory) => memory.id)).not.toContain(later.id);
      expect(app.projects.get(project.id).archivedAt).toBeNull();
    } finally {
      app.close();
    }
  });

  it("keeps file memories active when their paragraph survives and stales them when it changes", async () => {
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      await app.index(project.id);
      const memory = app.remember(project.id, {
        type: "decision",
        title: "Local memory",
        content: "Verified project memory remains local.",
        sourceKind: "file",
        sourceRef: "README.md:3-4",
      });

      const original = await readFile(join(projectRoot, "README.md"), "utf8");
      await writeFile(join(projectRoot, "README.md"), `New unrelated introduction.\n\n${original}`, "utf8");
      const moved = await app.index(project.id);
      expect(moved.staleMemories).not.toContain(memory.id);
      expect(app.memories(project.id).map((item) => item.id)).toContain(memory.id);

      await writeFile(join(projectRoot, "README.md"), (await readFile(join(projectRoot, "README.md"), "utf8"))
        .replace("keep verified project memory local", "store verified project memory remotely"), "utf8");
      const changed = await app.index(project.id);
      expect(changed.staleMemories).toContain(memory.id);
      expect(app.memories(project.id, "stale").map((item) => item.id)).toContain(memory.id);
      expect(app.search(project.id, "Verified project memory remains local").some((hit) => hit.id === memory.id)).toBe(false);
    } finally {
      app.close();
    }
  });

  it("rejects unsafe or invalid restore requests", async () => {
    const outside = await mkdtemp(join(tmpdir(), "project-context-outside-"));
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      const backup = join(tempRoot, "backups", "valid.db");
      await app.backup(project.id, backup);
      const newRoot = join(tempRoot, "restore-target");
      await mkdir(newRoot, { recursive: true });

      const outsideBackup = join(outside, "outside.db");
      await copyFile(backup, outsideBackup);
      await expect(app.restoreProject({ source: outsideBackup, root: newRoot }))
        .rejects.toMatchObject({ code: "BACKUP_SOURCE_NOT_AUTHORIZED" });

      const invalid = join(tempRoot, "backups", "invalid.db");
      await writeFile(invalid, "not sqlite", "utf8");
      await expect(app.restoreProject({ source: invalid, root: newRoot }))
        .rejects.toMatchObject({ code: "INVALID_BACKUP" });

      const future = join(tempRoot, "backups", "future.db");
      await copyFile(backup, future);
      const futureDb = app.projects.projectDatabase(project.id);
      futureDb.close();
      const Database = (await import("better-sqlite3")).default;
      const raw = new Database(future);
      raw.pragma("user_version = 999");
      raw.close();
      await expect(app.restoreProject({ source: future, root: newRoot }))
        .rejects.toMatchObject({ code: "UNSUPPORTED_BACKUP_SCHEMA" });

      await expect(app.restoreProject({ source: backup, projectId: project.id, confirmProjectId: project.id }))
        .rejects.toMatchObject({ code: "PROJECT_NOT_ARCHIVED" });
      app.archiveProject(project.id);
      await expect(app.restoreProject({ source: backup, projectId: project.id, confirmProjectId: "wrong" }))
        .rejects.toMatchObject({ code: "PROJECT_RESTORE_CONFIRMATION_MISMATCH" });
    } finally {
      app.close();
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("blocks deletion without archival, exact confirmation, or cleared durable state", async () => {
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      await expect(app.deleteProject(project.id, { confirmProjectId: project.id, purge: true }))
        .rejects.toMatchObject({ code: "PROJECT_NOT_ARCHIVED" });
      app.archiveProject(project.id);
      await expect(app.deleteProject(project.id, { confirmProjectId: "wrong", purge: true }))
        .rejects.toMatchObject({ code: "PROJECT_DELETE_CONFIRMATION_MISMATCH" });

      const memory = app.remember(project.id, {
        type: "fact", title: "Keep", content: "Keep this memory.", sourceKind: "user",
      });
      await expect(app.deleteProject(project.id, { confirmProjectId: project.id, purge: true }))
        .rejects.toMatchObject({ code: "PROJECT_DELETE_BLOCKED" });
      app.setMemoryStatus(project.id, memory.id, "deleted");

      const task = app.startTask(project.id, "finish durable cleanup");
      await expect(app.deleteProject(project.id, { confirmProjectId: project.id, purge: true }))
        .rejects.toMatchObject({ code: "PROJECT_DELETE_BLOCKED" });
      app.completeTask(project.id, task.id);

      const db = app.projects.projectDatabase(project.id);
      try {
        db.prepare(`
          INSERT INTO memory_candidates (
            id, type, title, content, reason, confidence, scope_json, source_kind,
            source_ref, evidence_json, fingerprint, status, created_at, updated_at
          ) VALUES ('cand_pending', 'fact', 'Pending', 'Pending review', NULL, 1, '[]',
            'tool', NULL, '{}', 'pending-delete-test', 'pending', 'now', 'now')
        `).run();
      } finally {
        db.close();
      }
      await expect(app.deleteProject(project.id, { confirmProjectId: project.id, purge: true }))
        .rejects.toMatchObject({ code: "PROJECT_DELETE_BLOCKED" });
    } finally {
      app.close();
    }
  });
});
