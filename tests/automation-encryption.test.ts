import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { ProjectContextApp } from "../src/core/app.js";

describe("automatic indexing and encrypted backups", () => {
  let tempRoot: string;
  let projectRoot: string;
  let previousEnvironment: Record<string, string | undefined>;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "project-context-automation-"));
    projectRoot = join(tempRoot, "project");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(join(projectRoot, "README.md"), "# Project\n", "utf8");
    previousEnvironment = {
      PROJECT_CONTEXT_HOME: process.env.PROJECT_CONTEXT_HOME,
      PROJECT_CONTEXT_ALLOWED_ROOTS: process.env.PROJECT_CONTEXT_ALLOWED_ROOTS,
      PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS: process.env.PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS,
      PROJECT_CONTEXT_TEST_PASSPHRASE: process.env.PROJECT_CONTEXT_TEST_PASSPHRASE,
    };
    process.env.PROJECT_CONTEXT_HOME = join(tempRoot, "memory");
    process.env.PROJECT_CONTEXT_ALLOWED_ROOTS = tempRoot;
    process.env.PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS = tempRoot;
    process.env.PROJECT_CONTEXT_TEST_PASSPHRASE = "test-only-long-passphrase";
  });

  afterEach(async () => {
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("debounces changes, indexes them, and leaves generated candidates pending", async () => {
    const app = await ProjectContextApp.create();
    let projectId: string | undefined;
    try {
      const project = await app.openProject(projectRoot);
      projectId = project.id;
      app.watchStart(project.id, 100, false);
      await writeFile(
        join(projectRoot, "README.md"),
        "# Project\n\nDecision: automatic indexing must keep candidates review-only.\n",
        "utf8",
      );
      await app.watchFlush(project.id);
      expect(app.search(project.id, "automatic indexing")).not.toHaveLength(0);
      expect(app.candidates(project.id, "pending").length).toBeGreaterThan(0);
      expect(app.memories(project.id, "active")).toHaveLength(0);
      const lastEventAt = app.watchList()[0]?.lastEventAt;
      await writeFile(join(projectRoot, ".project-context", "ignored.tmp"), "ignored", "utf8");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(app.watchList()[0]?.lastEventAt).toBe(lastEventAt);
      app.archiveProject(project.id);
      await expect(app.deleteProject(project.id, { confirmProjectId: project.id, purge: true }))
        .rejects.toMatchObject({ code: "PROJECT_WATCH_ACTIVE" });
    } finally {
      if (projectId && app.watchList().some((watch) => watch.projectId === projectId)) app.watchStop(projectId);
      app.close();
    }
  });

  it("ignores changes excluded by project ignore files and reloads edited rules", async () => {
    await writeFile(join(projectRoot, ".gitignore"), ".idea/\n", "utf8");
    await writeFile(join(projectRoot, ".project-context-ignore"), "generated/\n", "utf8");
    await mkdir(join(projectRoot, ".idea"), { recursive: true });
    await mkdir(join(projectRoot, "generated"), { recursive: true });
    await mkdir(join(projectRoot, "scratch"), { recursive: true });
    const app = await ProjectContextApp.create();
    let projectId: string | undefined;
    try {
      const project = await app.openProject(projectRoot);
      projectId = project.id;
      app.watchStart(project.id, 100, false);
      await writeFile(join(projectRoot, ".idea", "workspace.xml"), "<project />\n", "utf8");
      await writeFile(join(projectRoot, "generated", "output.txt"), "generated\n", "utf8");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(app.watchList()[0]?.lastEventAt).toBeNull();

      await writeFile(join(projectRoot, ".project-context-ignore"), "generated/\nscratch/\n", "utf8");
      await app.watchFlush(project.id);
      const afterRulesChanged = app.watchList()[0]?.lastEventAt;
      expect(afterRulesChanged).not.toBeNull();
      await writeFile(join(projectRoot, "scratch", "notes.txt"), "scratch\n", "utf8");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(app.watchList()[0]?.lastEventAt).toBe(afterRulesChanged);
    } finally {
      if (projectId && app.watchList().some((watch) => watch.projectId === projectId)) app.watchStop(projectId);
      app.close();
    }
  });

  it("round-trips encrypted backups and rejects wrong or tampered authentication", async () => {
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      const memory = app.remember(project.id, {
        type: "decision", title: "Encrypted", content: "Encrypted backup survives restore.", sourceKind: "user",
      });
      const encrypted = join(tempRoot, "backups", "project.pcmb");
      const result = await app.encryptedBackup(project.id, encrypted, "PROJECT_CONTEXT_TEST_PASSPHRASE");
      expect(result).toMatchObject({ cipher: "aes-256-gcm", kdf: "scrypt", version: 1 });
      expect((await readFile(encrypted)).subarray(0, 9).toString("ascii")).toBe("PCMBKUP1\n");

      const restoredRoot = join(tempRoot, "restored");
      await mkdir(restoredRoot, { recursive: true });
      const restored = await app.encryptedRestore({
        source: encrypted,
        passphraseEnv: "PROJECT_CONTEXT_TEST_PASSPHRASE",
        root: restoredRoot,
      });
      const restoredId = (restored.project as { id: string }).id;
      expect(app.memories(restoredId).map((item) => item.id)).toContain(memory.id);

      process.env.PROJECT_CONTEXT_TEST_PASSPHRASE = "wrong-test-passphrase";
      const wrongRoot = join(tempRoot, "wrong");
      await mkdir(wrongRoot, { recursive: true });
      await expect(app.encryptedRestore({
        source: encrypted, passphraseEnv: "PROJECT_CONTEXT_TEST_PASSPHRASE", root: wrongRoot,
      })).rejects.toMatchObject({ code: "ENCRYPTED_BACKUP_DECRYPT_FAILED" });

      process.env.PROJECT_CONTEXT_TEST_PASSPHRASE = "test-only-long-passphrase";
      const tampered = join(tempRoot, "backups", "tampered.pcmb");
      const bytes = await readFile(encrypted);
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
      await writeFile(tampered, bytes);
      await expect(app.encryptedRestore({
        source: tampered, passphraseEnv: "PROJECT_CONTEXT_TEST_PASSPHRASE", root: wrongRoot,
      })).rejects.toMatchObject({ code: "ENCRYPTED_BACKUP_DECRYPT_FAILED" });
      expect((await readdir(join(tempRoot, "backups"))).every((name) => !name.endsWith(".restore.db"))).toBe(true);
    } finally {
      app.close();
    }
  });
});
