import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ProjectContextApp } from "../src/core/app.js";

const execFileAsync = promisify(execFile);

describe("Project Context core", () => {
  let tempRoot: string;
  let storageRoot: string;
  let projectRoot: string;
  let previousHome: string | undefined;
  let previousAllowedRoots: string | undefined;
  let previousOutputRoots: string | undefined;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "project-context-test-"));
    storageRoot = join(tempRoot, "memory");
    projectRoot = join(tempRoot, "project");
    await mkdir(join(projectRoot, "src"), { recursive: true });
    await writeFile(join(projectRoot, "README.md"), "# Example\n\nRefresh token architecture decision.\n", "utf8");
    await writeFile(
      join(projectRoot, "src", "auth.ts"),
      "import { rotate } from './token';\nexport function refreshToken() { return rotate(); }\n",
      "utf8",
    );
    await writeFile(join(projectRoot, ".env"), "SECRET_TOKEN=must-not-be-indexed\n", "utf8");
    await writeFile(
      join(projectRoot, "credentials.txt"),
      "api_key=abcdefghijklmnopqrstuvwxyz123456\n",
      "utf8",
    );
    previousHome = process.env.PROJECT_CONTEXT_HOME;
    previousAllowedRoots = process.env.PROJECT_CONTEXT_ALLOWED_ROOTS;
    previousOutputRoots = process.env.PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS;
    process.env.PROJECT_CONTEXT_HOME = storageRoot;
    process.env.PROJECT_CONTEXT_ALLOWED_ROOTS = tempRoot;
    process.env.PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS = tempRoot;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.PROJECT_CONTEXT_HOME;
    else process.env.PROJECT_CONTEXT_HOME = previousHome;
    if (previousAllowedRoots === undefined) delete process.env.PROJECT_CONTEXT_ALLOWED_ROOTS;
    else process.env.PROJECT_CONTEXT_ALLOWED_ROOTS = previousAllowedRoots;
    if (previousOutputRoots === undefined) delete process.env.PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS;
    else process.env.PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS = previousOutputRoots;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("indexes incrementally, excludes secrets, and searches content", async () => {
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      const first = await app.index(project.id);
      expect(first.indexed).toBe(2);
      expect(first.symbols).toBeGreaterThan(0);
      expect(first.relations).toBeGreaterThan(0);
      expect(first.errors).toEqual([]);

      const second = await app.index(project.id);
      expect(second.indexed).toBe(0);
      expect(second.skipped).toBe(3);
      expect(app.search(project.id, "refresh token").some((hit) => hit.title === "README.md")).toBe(true);
      expect(app.search(project.id, "refreshToken").some((hit) => hit.kind === "symbol")).toBe(true);
      expect(app.search(project.id, "must-not-be-indexed")).toEqual([]);
      expect(app.search(project.id, "abcdefghijklmnopqrstuvwxyz123456")).toEqual([]);
      expect(app.health(project.id)).toMatchObject({ sources: 2 });
      const context = app.context(project.id, "refreshToken", 2_000);
      expect(context.codeRelations.some((item) => item.type === "CALLS" && item.to === "rotate")).toBe(true);
    } finally {
      app.close();
    }
  });

  it("excludes cross-language compiler artifacts while retaining source files", async () => {
    await mkdir(join(projectRoot, "target", "debug"), { recursive: true });
    await mkdir(join(projectRoot, ".playwright-cli"), { recursive: true });
    await writeFile(join(projectRoot, "src", "worker.c"), "int worker(void) { return 7; }\n", "utf8");
    await writeFile(join(projectRoot, "src", "worker-deps.d"), "src/worker.o: src/worker.c include/worker.h\n", "utf8");
    await writeFile(join(projectRoot, "src", "worker.d"), "module worker;\nint dLanguageWorker() { return 8; }\n", "utf8");
    await writeFile(join(projectRoot, "src", "worker.o"), "generated object payload\n", "utf8");
    await writeFile(join(projectRoot, "src", "libworker.a"), "generated static archive payload\n", "utf8");
    await writeFile(join(projectRoot, "src", "worker.lib"), "generated windows library payload\n", "utf8");
    await writeFile(join(projectRoot, "src", "worker.pch"), "generated precompiled header payload\n", "utf8");
    await writeFile(join(projectRoot, "src", "cache.pyc"), "generated python cache text\n", "utf8");
    await writeFile(join(projectRoot, "src", "Worker.class"), "generated java bytecode text\n", "utf8");
    await writeFile(join(projectRoot, "target", "debug", "build.log"), "generated rust output\n", "utf8");
    await writeFile(join(projectRoot, ".playwright-cli", "session.yml"), "generated browser session\n", "utf8");

    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      await app.index(project.id);
      expect(app.search(project.id, "worker(void)").some((hit) => hit.source === "src/worker.c")).toBe(true);
      expect(app.search(project.id, "dLanguageWorker").some((hit) => hit.source === "src/worker.d")).toBe(true);
      expect(app.search(project.id, "include/worker.h")).toEqual([]);
      expect(app.search(project.id, "generated object payload")).toEqual([]);
      expect(app.search(project.id, "generated static archive payload")).toEqual([]);
      expect(app.search(project.id, "generated windows library payload")).toEqual([]);
      expect(app.search(project.id, "generated precompiled header payload")).toEqual([]);
      expect(app.search(project.id, "generated python cache")).toEqual([]);
      expect(app.search(project.id, "generated java bytecode")).toEqual([]);
      expect(app.search(project.id, "generated rust output")).toEqual([]);
      expect(app.search(project.id, "generated browser session")).toEqual([]);
      expect(app.health(project.id)).toMatchObject({ sources: 4 });
    } finally {
      app.close();
    }
  });

  it("persists memory lifecycle, task checkpoints, and assembled context", async () => {
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      await app.index(project.id);
      const oldDecision = app.remember(project.id, {
        type: "decision",
        title: "Token policy",
        content: "Refresh tokens do not rotate.",
        sourceKind: "user",
      });
      const newDecision = app.remember(project.id, {
        type: "decision",
        title: "Rotating token policy",
        content: "Refresh tokens rotate after every use.",
        sourceKind: "user",
        supersedesId: oldDecision.id,
      });
      app.remember(project.id, {
        type: "constraint",
        title: "Client compatibility",
        content: "Existing mobile clients must remain compatible.",
        sourceKind: "user",
      });
      const task = app.startTask(project.id, "Implement refresh token reuse detection");
      app.checkpoint(project.id, task.id, {
        summary: "Rotation implemented",
        completed: ["Added token family"],
        next: ["Add reuse test"],
        changedFiles: ["src/auth.ts"],
        verification: [{ command: "npm test", status: "passed" }],
        blockers: [],
        risks: ["Legacy client compatibility"],
      });

      expect(app.memories(project.id, "superseded")[0]?.id).toBe(oldDecision.id);
      expect(app.memories(project.id, "active").some((memory) => memory.id === newDecision.id)).toBe(true);
      const context = app.context(project.id, "refresh token reuse", 2_000);
      expect(context.decisions[0]?.id).toBe(newDecision.id);
      expect(context.constraints).toHaveLength(1);
      expect(context.activeTasks[0]?.checkpoint.next).toContain("Add reuse test");
      expect(context.relevant.length).toBeGreaterThan(0);
    } finally {
      app.close();
    }
  });

  it("rejects likely credentials from long-term memory", async () => {
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      expect(() => app.remember(project.id, {
        type: "fact",
        title: "Credential",
        content: "api_key=abcdefghijklmnopqrstuvwxyz123456",
        sourceKind: "user",
      })).toThrow(/credential or private key/i);
      expect(app.memories(project.id)).toEqual([]);
    } finally {
      app.close();
    }
  });

  it("marks file-sourced memory stale when its indexed source changes", async () => {
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      await app.index(project.id);
      const memory = app.remember(project.id, {
        type: "fact",
        title: "README heading",
        content: "The README starts with Example.",
        sourceKind: "file",
        sourceRef: "README.md:1",
      });
      await writeFile(join(projectRoot, "README.md"), "# Changed\n\nNew content.\n", "utf8");
      const result = await app.index(project.id);
      expect(result.staleMemories).toContain(memory.id);
      expect(app.memories(project.id, "stale")[0]?.id).toBe(memory.id);
    } finally {
      app.close();
    }
  });

  it("generates reviewable Git candidates and accepts one explicitly", async () => {
    await execFileAsync("git", ["init"], { cwd: projectRoot });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: projectRoot });
    await execFileAsync("git", ["config", "user.name", "Project Context Test"], { cwd: projectRoot });
    await execFileAsync("git", ["add", "README.md", "src/auth.ts"], { cwd: projectRoot });
    await execFileAsync("git", ["commit", "-m", "baseline"], { cwd: projectRoot });

    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      await app.index(project.id);
      await writeFile(
        join(projectRoot, "README.md"),
        "# Example\n\nDecision: project memory must remain local by default.\n",
        "utf8",
      );
      const result = await app.index(project.id);
      expect(result.git.available).toBe(true);
      expect(result.vcs).toMatchObject({ available: true, kind: "git", revision: expect.any(String) });
      expect(result.generatedCandidates.length).toBeGreaterThan(0);
      const pending = app.candidates(project.id);
      expect(pending).toHaveLength(result.generatedCandidates.length);
      const accepted = app.acceptCandidate(project.id, pending[0]!.id);
      expect(accepted.sourceKind).toBe("git");
      expect(app.candidates(project.id, "accepted")).toHaveLength(1);
    } finally {
      app.close();
    }
  });

  it("generates reviewable file candidates without Git and deduplicates unchanged indexes", async () => {
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      const first = await app.index(project.id);
      const fileCandidate = first.generatedCandidates.find((candidate) => candidate.sourceRef === "README.md");
      expect(first.git.available).toBe(false);
      expect(first.vcs).toMatchObject({ available: false, kind: null });
      expect(fileCandidate).toMatchObject({
        sourceKind: "file",
        status: "pending",
        content: "Refresh token architecture decision.",
        evidence: { path: "README.md", changeKind: "added", previousHash: null },
      });

      const second = await app.index(project.id);
      expect(second.generatedCandidates).toEqual([]);
      expect(app.candidates(project.id).filter((candidate) => candidate.sourceRef === "README.md")).toHaveLength(1);

      const firstCandidateId = fileCandidate!.id;
      await writeFile(
        join(projectRoot, "README.md"),
        "# Example\n\nDecision: project memory must remain local and encrypted.\n",
        "utf8",
      );
      const changed = await app.index(project.id);
      expect(changed.generatedCandidates).toHaveLength(1);
      expect(changed.generatedCandidates[0]).toMatchObject({
        sourceKind: "file",
        evidence: { path: "README.md", changeKind: "updated" },
      });
      expect(app.candidates(project.id)).toHaveLength(1);
      expect(app.candidates(project.id, "superseded")[0]?.id).toBe(firstCandidateId);
    } finally {
      app.close();
    }
  });

  it("generates at most one task candidate on completion without auto-accepting it", async () => {
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      const task = app.startTask(project.id, "Adopt a durable token policy");
      app.checkpoint(project.id, task.id, {
        summary: "The refresh-token policy now rotates tokens after every use.",
        completed: ["Decision: keep project memory local by default.", "Added implementation details."],
        next: [],
        changedFiles: ["src/auth.ts", "README.md"],
        verification: [{ command: "npm test", status: "passed" }],
        blockers: [],
        risks: ["Legacy clients may not support token rotation."],
      });

      app.completeTask(project.id, task.id);
      const taskCandidates = app.candidates(project.id).filter((candidate) => candidate.sourceRef === `task:${task.id}`);
      expect(taskCandidates).toHaveLength(1);
      expect(taskCandidates[0]).toMatchObject({
        type: "task-summary",
        content: "The refresh-token policy now rotates tokens after every use.",
        evidence: { checkpointField: "summary" },
      });
      expect(taskCandidates.every((candidate) => candidate.title.includes("Adopt a durable token policy"))).toBe(true);
      expect(taskCandidates.every((candidate) => candidate.sourceKind === "tool")).toBe(true);
      expect(taskCandidates.every((candidate) => candidate.scope.includes("src/auth.ts"))).toBe(true);
      expect(app.memories(project.id)).toEqual([]);

      app.completeTask(project.id, task.id);
      expect(app.candidates(project.id).filter((candidate) => candidate.sourceRef === `task:${task.id}`)).toHaveLength(1);

      const firstRejection = app.rejectCandidate(project.id, taskCandidates[0]!.id);
      const repeatedRejection = app.rejectCandidate(project.id, taskCandidates[0]!.id);
      expect(repeatedRejection).toEqual(firstRejection);
    } finally {
      app.close();
    }
  });

  it("falls back from task summary to one risk or one durable completed item", async () => {
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      const riskTask = app.startTask(project.id, "Record a task risk");
      app.completeTask(project.id, riskTask.id, {
        completed: ["Decision: keep project memory local by default."], next: [], changedFiles: [], verification: [],
        blockers: [], risks: ["Legacy clients may not support token rotation.", "A second risk must not become a candidate."],
      });
      const riskCandidates = app.candidates(project.id).filter((candidate) => candidate.sourceRef === `task:${riskTask.id}`);
      expect(riskCandidates).toHaveLength(1);
      expect(riskCandidates[0]).toMatchObject({
        type: "issue", content: "Legacy clients may not support token rotation.",
        evidence: { checkpointField: "risks" },
      });

      const completedTask = app.startTask(project.id, "Record a durable completed item");
      app.completeTask(project.id, completedTask.id, {
        completed: ["Added routine implementation details.", "Decision: keep project memory local by default."],
        next: [], changedFiles: [], verification: [], blockers: [], risks: [],
      });
      const completedCandidates = app.candidates(project.id)
        .filter((candidate) => candidate.sourceRef === `task:${completedTask.id}`);
      expect(completedCandidates).toHaveLength(1);
      expect(completedCandidates[0]).toMatchObject({
        type: "decision", content: "Decision: keep project memory local by default.",
        evidence: { checkpointField: "completed" },
      });
    } finally {
      app.close();
    }
  });

  it("does not generate task candidates containing likely credentials", async () => {
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      const task = app.startTask(project.id, "Investigate credential handling");
      app.completeTask(project.id, task.id, {
        summary: "api_key=abcdefghijklmnopqrstuvwxyz123456",
        completed: [],
        next: [],
        changedFiles: [],
        verification: [],
        blockers: [],
        risks: [],
      });
      expect(app.candidates(project.id)).toEqual([]);
    } finally {
      app.close();
    }
  });

  it("backs up, exports, and diagnoses a project database", async () => {
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      await app.index(project.id);
      const backupPath = join(tempRoot, "backups", "project.db");
      const exportPath = join(tempRoot, "export");
      await app.backup(project.id, backupPath);
      await app.export(project.id, exportPath);
      expect((await stat(backupPath)).size).toBeGreaterThan(0);
      const manifest = JSON.parse(await readFile(join(exportPath, "manifest.json"), "utf8")) as {
        schemaVersion: number;
      };
      expect(manifest.schemaVersion).toBe(6);
      const doctor = await app.doctor(project.id);
      expect(doctor.integrity).toBe("ok");
      expect(doctor.counts.symbols).toBeGreaterThan(0);

      const db = app.projects.projectDatabase(project.id);
      try {
        db.exec(`
          DELETE FROM chunks_fts;
          DELETE FROM symbols_fts;
          DELETE FROM search_ngrams;
          DELETE FROM metadata WHERE key = 'ngram_schema_version';
        `);
      } finally {
        db.close();
      }
      expect((await app.doctor(project.id)).ok).toBe(false);
      const repaired = await app.doctor(project.id, true);
      expect(repaired.ok).toBe(true);
      expect(repaired.counts.chunkFts).toBe(repaired.counts.chunks);
      expect(repaired.counts.symbolFts).toBe(repaired.counts.symbols);
      expect(repaired.counts.searchNgrams).toBeGreaterThan(0);
    } finally {
      app.close();
    }
  });

  it("reopens the same project across app instances", async () => {
    const firstApp = await ProjectContextApp.create();
    const firstProject = await firstApp.openProject(projectRoot);
    firstApp.close();

    const secondApp = await ProjectContextApp.create();
    try {
      const secondProject = await secondApp.openProject(projectRoot);
      expect(secondProject.id).toBe(firstProject.id);
    } finally {
      secondApp.close();
    }
  });

  it("prunes ignored directories before visiting their files", async () => {
    await writeFile(join(projectRoot, ".gitignore"), "generated/\n", "utf8");
    await mkdir(join(projectRoot, "generated", "nested"), { recursive: true });
    await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(
      join(projectRoot, "generated", "nested", `${index}.ts`),
      `export const generated${index} = true;\n`,
      "utf8",
    )));
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      const result = await app.index(project.id);
      expect(result.prunedDirectories).toBeGreaterThan(0);
      expect(result.visited).toBeLessThan(10);
      expect(app.search(project.id, "generated99").some((hit) => hit.source?.startsWith("generated/"))).toBe(false);
    } finally {
      app.close();
    }
  });

  it("batch-removes sources that become ignored", async () => {
    await mkdir(join(projectRoot, "generated"), { recursive: true });
    await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(
      join(projectRoot, "generated", `${index}.ts`),
      `export const generatedBatch${index} = true;\n`,
      "utf8",
    )));
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      const initial = await app.index(project.id);
      expect(initial.indexed).toBe(102);

      await writeFile(join(projectRoot, ".project-context-ignore"), "generated/\n", "utf8");
      const cleaned = await app.index(project.id);
      expect(cleaned.removed).toBe(100);
      expect(app.search(project.id, "generatedBatch99")).toEqual([]);
      await expect(app.doctor(project.id)).resolves.toMatchObject({ ok: true });
    } finally {
      app.close();
    }
  });

  it("prunes Codex runtime data without hiding same-named application directories", async () => {
    await mkdir(join(projectRoot, "sessions"), { recursive: true });
    await writeFile(join(projectRoot, "sessions", "domain.ts"), "export const classroomSession = true;\n", "utf8");
    const codexRoot = join(tempRoot, ".codex");
    await mkdir(join(codexRoot, "sessions"), { recursive: true });
    await mkdir(join(codexRoot, ".tmp", "plugins"), { recursive: true });
    await mkdir(join(codexRoot, "skills"), { recursive: true });
    await writeFile(join(codexRoot, "sessions", "private.jsonl"), "private conversation\n", "utf8");
    await writeFile(join(codexRoot, ".tmp", "plugins", "cached.ts"), "export const cached = true;\n", "utf8");
    await writeFile(join(codexRoot, "history.jsonl"), "history entry\n", "utf8");
    await writeFile(join(codexRoot, "AGENTS.md"), "# Agent instructions\n", "utf8");
    await writeFile(join(codexRoot, "skills", "custom.md"), "# Custom skill\n", "utf8");

    const app = await ProjectContextApp.create();
    try {
      const regularProject = await app.openProject(projectRoot);
      await app.index(regularProject.id);
      expect(app.search(regularProject.id, "classroomSession")).not.toEqual([]);

      const codexProject = await app.openProject(codexRoot);
      const result = await app.index(codexProject.id);
      expect(result.indexed).toBe(2);
      expect(result.prunedDirectories).toBeGreaterThanOrEqual(2);
      expect(app.search(codexProject.id, "private conversation")).toEqual([]);
      expect(app.search(codexProject.id, "cached")).toEqual([]);
      expect(app.search(codexProject.id, "Custom skill")).not.toEqual([]);
    } finally {
      app.close();
    }
  });

  it("supports CJK substring retrieval through the hybrid n-gram index", async () => {
    await writeFile(join(projectRoot, "中文设计.md"), "这是跨会话项目上下文记忆的架构决定。\n", "utf8");
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      await app.index(project.id);
      expect(app.search(project.id, "跨会话").some((hit) => hit.title === "中文设计.md")).toBe(true);
    } finally {
      app.close();
    }
  });

  it("defers legacy n-gram rebuilding until an explicit index run", async () => {
    await writeFile(join(projectRoot, "中文设计.md"), "这是跨会话项目上下文记忆的架构决定。\n", "utf8");
    const firstApp = await ProjectContextApp.create();
    const project = await firstApp.openProject(projectRoot);
    await firstApp.index(project.id);
    const legacyDb = firstApp.projects.projectDatabase(project.id);
    legacyDb.exec("DELETE FROM search_ngrams; DELETE FROM metadata WHERE key = 'ngram_schema_version';");
    legacyDb.close();
    firstApp.close();

    const secondApp = await ProjectContextApp.create();
    try {
      const openedDb = secondApp.projects.projectDatabase(project.id);
      expect(openedDb.prepare("SELECT COUNT(*) FROM search_ngrams").pluck().get()).toBe(0);
      expect(openedDb.prepare("SELECT value FROM metadata WHERE key = 'ngram_schema_version'").pluck().get())
        .toBeUndefined();
      openedDb.close();
      await expect(secondApp.doctor(project.id)).resolves.toMatchObject({
        ok: false,
        issues: ["Unicode n-gram search index needs rebuilding; run project_index."],
      });

      const result = await secondApp.index(project.id);
      expect(result.indexed).toBe(0);
      expect(secondApp.search(project.id, "跨会话").some((hit) => hit.title === "中文设计.md")).toBe(true);
      const rebuiltDb = secondApp.projects.projectDatabase(project.id);
      expect(rebuiltDb.prepare("SELECT value FROM metadata WHERE key = 'ngram_schema_version'").pluck().get())
        .toBe("1");
      rebuiltDb.close();
    } finally {
      secondApp.close();
    }
  });

  it("cancels a batched n-gram rebuild and allows a clean retry", async () => {
    await mkdir(join(projectRoot, "docs"), { recursive: true });
    await Promise.all(Array.from({ length: 80 }, (_, index) => writeFile(
      join(projectRoot, "docs", `${index}.md`),
      `跨会话索引取消测试文档 ${index}，包含可搜索的架构说明。\n`,
      "utf8",
    )));
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      await app.index(project.id);
      const db = app.projects.projectDatabase(project.id);
      db.exec("DELETE FROM search_ngrams; DELETE FROM metadata WHERE key = 'ngram_schema_version';");
      db.close();

      const controller = new AbortController();
      await expect(app.index(project.id, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.phase === "finalizing" && progress.path === "search index") controller.abort();
        },
      })).rejects.toMatchObject({ code: "INDEX_CANCELLED" });

      const cancelledDb = app.projects.projectDatabase(project.id);
      expect(cancelledDb.prepare("SELECT value FROM metadata WHERE key = 'ngram_schema_version'").pluck().get())
        .toBeUndefined();
      expect(cancelledDb.prepare("SELECT status FROM index_runs ORDER BY started_at DESC LIMIT 1").pluck().get())
        .toBe("failed");
      cancelledDb.close();

      await app.index(project.id);
      expect(app.search(project.id, "索引取消测试")).not.toEqual([]);
    } finally {
      app.close();
    }
  });

  it("enforces cancellation, project roots, output roots, and strict context budgets", async () => {
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      const controller = new AbortController();
      controller.abort();
      await expect(app.index(project.id, { signal: controller.signal })).rejects.toMatchObject({ code: "INDEX_CANCELLED" });
      await expect(app.openProject(tmpdir())).rejects.toMatchObject({ code: "PROJECT_ROOT_NOT_AUTHORIZED" });
      await expect(app.backup(project.id, join(tmpdir(), "outside-project-context.db")))
        .rejects.toMatchObject({ code: "OUTPUT_PATH_NOT_ALLOWED" });
      app.remember(project.id, {
        type: "constraint",
        title: "Large constraint",
        content: "必须保留兼容性。".repeat(1_000),
        sourceKind: "user",
      });
      const context = app.context(project.id, "兼容性", 500);
      expect(context.budget.usedTokens).toBeLessThanOrEqual(500);
      expect(context.budget.truncated).toBe(true);
    } finally {
      app.close();
    }
  });

  it("rejects concurrent index runs and supersedes evolving document candidates", async () => {
    await execFileAsync("git", ["init"], { cwd: projectRoot });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: projectRoot });
    await execFileAsync("git", ["config", "user.name", "Project Context Test"], { cwd: projectRoot });
    await execFileAsync("git", ["add", "."], { cwd: projectRoot });
    await execFileAsync("git", ["commit", "-m", "baseline"], { cwd: projectRoot });
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      await expect(app.index("missing-project")).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
      await expect(app.index("missing-project")).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
      const firstRun = app.index(project.id);
      await expect(app.index(project.id)).rejects.toMatchObject({ code: "INDEX_ALREADY_RUNNING" });
      await firstRun;
      await writeFile(join(projectRoot, "README.md"), "# Example\n\nDecision: use local storage.\n", "utf8");
      const firstCandidateRun = await app.index(project.id);
      expect(firstCandidateRun.generatedCandidates, JSON.stringify(firstCandidateRun.git, null, 2)).toHaveLength(1);
      const firstCandidate = app.candidates(project.id)[0]!;
      await writeFile(join(projectRoot, "README.md"), "# Example\n\nDecision: use encrypted local storage.\n", "utf8");
      await writeFile(join(projectRoot, "src", "auth.ts"), "export const passwordPolicy = 'changed';\n", "utf8");
      await app.index(project.id);
      const allCandidateStates = {
        pending: app.candidates(project.id),
        superseded: app.candidates(project.id, "superseded"),
        accepted: app.candidates(project.id, "accepted"),
        rejected: app.candidates(project.id, "rejected"),
      };
      expect(allCandidateStates.pending, JSON.stringify(allCandidateStates, null, 2)).toHaveLength(1);
      expect(app.candidates(project.id, "superseded")[0]?.id).toBe(firstCandidate.id);
    } finally {
      app.close();
    }
  });

  it("ranks exact symbol names and filters unrelated scoped constraints", async () => {
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      await app.index(project.id);
      const relevant = app.remember(project.id, {
        type: "constraint",
        title: "Local auth audit",
        content: "Authentication audit records must remain local.",
        scope: ["src/auth.ts"],
        sourceKind: "user",
      });
      const unrelated = app.remember(project.id, {
        type: "constraint",
        title: "Image cache limit",
        content: "Image thumbnails must expire after one hour.",
        scope: ["src/images.ts"],
        sourceKind: "user",
      });

      expect(app.search(project.id, "refreshToken", 5)[0]).toMatchObject({
        kind: "symbol",
        source: "src/auth.ts",
      });
      const context = app.context(project.id, "authentication audit records", 2_000);
      expect(context.constraints.map((memory) => memory.id)).toContain(relevant.id);
      expect(context.constraints.map((memory) => memory.id)).not.toContain(unrelated.id);
    } finally {
      app.close();
    }
  });

  it("retrieves relevant memories before bounded assembly under large active history", async () => {
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      const relevant = app.remember(project.id, {
        type: "decision",
        title: "Database backup retention",
        content: "Database backups retain seven daily snapshots.",
        sourceKind: "user",
      });
      for (let index = 0; index < 140; index += 1) {
        app.remember(project.id, {
          type: "decision",
          title: `Unrelated history ${index}`,
          content: `Frontend typography preference ${index} is unrelated to navigation.`,
          sourceKind: "user",
        });
      }

      const context = app.context(project.id, "database backup retention");
      const serialized = JSON.stringify(context);
      expect(context.budget.requestedTokens).toBe(3_000);
      expect(context.budget.usedTokens).toBeLessThanOrEqual(3_000);
      expect(context.decisions.map((memory) => memory.id)).toContain(relevant.id);
      expect(serialized).toContain("Database backup retention");
      expect(serialized).not.toContain("Unrelated history");
    } finally {
      app.close();
    }
  });
});
