import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createMcpServer } from "../src/mcp/server.js";
import { ProjectContextApp } from "../src/core/app.js";

const execFileAsync = promisify(execFile);

describe("Project Context MCP", () => {
  let tempRoot: string;
  let projectRoot: string;
  let previousEnvironment: Record<string, string | undefined>;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "project-context-mcp-test-"));
    projectRoot = join(tempRoot, "project");
    await mkdir(join(projectRoot, "docs"), { recursive: true });
    await writeFile(join(projectRoot, "README.md"), "# Project\n", "utf8");
    await writeFile(join(projectRoot, "docs", "adr.md"), "# ADR\n", "utf8");
    await execFileAsync("git", ["init"], { cwd: projectRoot });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: projectRoot });
    await execFileAsync("git", ["config", "user.name", "MCP Test"], { cwd: projectRoot });
    await execFileAsync("git", ["add", "."], { cwd: projectRoot });
    await execFileAsync("git", ["commit", "-m", "baseline"], { cwd: projectRoot });
    await writeFile(join(projectRoot, "README.md"), "# Project\n\nDecision: memory must remain local.\n", "utf8");
    await writeFile(join(projectRoot, "docs", "adr.md"), "# ADR\n\nConstraint: exports must be authorized.\n", "utf8");
    previousEnvironment = {
      PROJECT_CONTEXT_HOME: process.env.PROJECT_CONTEXT_HOME,
      PROJECT_CONTEXT_ALLOWED_ROOTS: process.env.PROJECT_CONTEXT_ALLOWED_ROOTS,
      PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS: process.env.PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS,
      PROJECT_CONTEXT_TEST_PASSPHRASE: process.env.PROJECT_CONTEXT_TEST_PASSPHRASE,
    };
    process.env.PROJECT_CONTEXT_HOME = join(tempRoot, "memory");
    process.env.PROJECT_CONTEXT_ALLOWED_ROOTS = tempRoot;
    process.env.PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS = tempRoot;
    process.env.PROJECT_CONTEXT_TEST_PASSPHRASE = "test-only-mcp-passphrase";
  });

  afterEach(async () => {
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("executes all tools and exposes structured outputs, resources, and prompts", async () => {
    const server = createMcpServer();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(35);
      expect(tools.tools.every((tool) => tool.outputSchema !== undefined)).toBe(true);

      await call(client, "storage_status", {});
      let sawManagedIndexProgress = false;
      const openResult = await client.callTool({ name: "project_open", arguments: { root: projectRoot } }, undefined, {
        onprogress: () => {
          sawManagedIndexProgress = true;
        },
      });
      const opened = object(openResult.structuredContent).result;
      const projectId = object(opened).id as string;
      expect(sawManagedIndexProgress).toBe(true);
      expect(object(object(opened).managedIndex).generatedCandidates).toHaveLength(2);
      expect(object(opened).watch).toMatchObject({ projectId, debounceMs: 300, pending: false });
      await mkdir(join(projectRoot, "src"), { recursive: true });
      await writeFile(join(projectRoot, "src", "managed.ts"), "export const managedRefresh = 'fresh managed search';\n", "utf8");
      const managedSearch = array(await call(client, "project_search", { projectId, query: "fresh managed search" }));
      expect(managedSearch).not.toHaveLength(0);
      await call(client, "project_list", {});
      await call(client, "project_update", { projectId, name: "MCP Project" });
      await call(client, "project_watch_start", { projectId, initialIndex: false, debounceMs: 100 });
      expect(array(await call(client, "project_watch_list", {}))).toHaveLength(1);
      await call(client, "project_watch_stop", { projectId });
      const indexed = await call(client, "project_index", { projectId });
      expect(object(indexed).errors).toHaveLength(0);
      await call(client, "project_search", { projectId, query: "memory local" });
      await call(client, "project_context", { projectId, task: "review local memory", budgetTokens: 1_000 });

      const remembered = await call(client, "memory_remember", {
        projectId, type: "decision", title: "Local memory", content: "Memory stays local.", sourceKind: "user",
      });
      const memoryId = object(remembered).id as string;
      await call(client, "memory_list", { projectId, status: "active" });
      await call(client, "memory_update_status", { projectId, memoryId, status: "stale" });
      const userMemory = await call(client, "user_memory_remember", {
        type: "constraint", title: "Typecheck", content: "Run typecheck before tests.",
        sourceKind: "user", scopeLevel: "project", projectId,
      });
      await call(client, "user_memory_list", { status: "active" });
      await call(client, "user_memory_update_status", {
        memoryId: object(userMemory).id, status: "superseded",
      });
      const candidates = array(await call(client, "memory_candidates", { projectId }));
      await call(client, "memory_candidate_accept", { projectId, candidateId: object(candidates[0]).id });
      await call(client, "memory_candidate_reject", { projectId, candidateId: object(candidates[1]).id });

      const started = await call(client, "task_start", { projectId, goal: "Finish MCP contract tests" });
      const taskId = object(started).id as string;
      await call(client, "task_checkpoint", {
        projectId, taskId, summary: "In progress", completed: ["Tools"], next: ["Resources"],
        changedFiles: [], verification: [], blockers: [], risks: [],
      });
      await call(client, "task_list", { projectId, status: "in_progress" });
      await call(client, "project_watch_start", { projectId, initialIndex: false, debounceMs: 100 });
      await writeFile(join(projectRoot, "src", "completion.ts"), "export const finalRefresh = 'task completion refresh';\n", "utf8");
      await call(client, "task_complete", { projectId, taskId });
      const completionVerifier = await ProjectContextApp.create();
      try {
        expect(completionVerifier.search(projectId, "task completion refresh")).not.toHaveLength(0);
      } finally {
        completionVerifier.close();
      }
      const cancelled = await call(client, "task_start", { projectId, goal: "Cancel obsolete MCP work" });
      await call(client, "task_cancel", { projectId, taskId: object(cancelled).id });
      await call(client, "project_watch_stop", { projectId });
      await call(client, "project_health", { projectId });
      await call(client, "project_doctor", { projectId, repair: false });
      const backup = join(tempRoot, "backup", "project.db");
      await call(client, "project_backup", { projectId, destination: backup });
      const restoredRoot = join(tempRoot, "restored");
      await mkdir(restoredRoot, { recursive: true });
      await call(client, "project_restore", { source: backup, root: restoredRoot });
      const encrypted = join(tempRoot, "backup", "project.pcmb");
      await call(client, "project_backup_encrypted", {
        projectId, destination: encrypted, passphraseEnv: "PROJECT_CONTEXT_TEST_PASSPHRASE",
      });
      const encryptedRoot = join(tempRoot, "restored-encrypted");
      await mkdir(encryptedRoot, { recursive: true });
      await call(client, "project_restore_encrypted", {
        source: encrypted, passphraseEnv: "PROJECT_CONTEXT_TEST_PASSPHRASE", root: encryptedRoot,
      });
      await call(client, "project_export", { projectId, outputDirectory: join(tempRoot, "export") });
      const relocated = join(tempRoot, "relocated");
      await mkdir(relocated, { recursive: true });
      await call(client, "project_relocate", { projectId, newRoot: relocated });
      await call(client, "project_archive", { projectId });
      await call(client, "project_list", { includeArchived: true });
      await call(client, "project_delete", { projectId, confirmProjectId: projectId, purge: false });
      await call(client, "project_unarchive", { projectId });

      const templates = await client.listResourceTemplates();
      expect(templates.resourceTemplates).toHaveLength(4);
      const registry = await client.readResource({ uri: "project-context://projects" });
      expect(JSON.stringify(registry.contents)).toContain(projectId);
      const health = await client.readResource({ uri: `project-context://projects/${projectId}/health` });
      expect(JSON.stringify(health.contents)).toContain("schemaVersion");
      const prompts = await client.listPrompts();
      expect(prompts.prompts.map((prompt) => prompt.name)).toEqual(expect.arrayContaining([
        "resume-project-task", "review-memory-candidates",
      ]));
      const prompt = await client.getPrompt({ name: "resume-project-task", arguments: { projectId, task: "continue" } });
      expect(prompt.messages).toHaveLength(1);
      const promptContext = JSON.parse(prompt.messages[0].content.text) as {
        budget: { requestedTokens: number };
      };
      expect(promptContext.budget.requestedTokens).toBe(3_000);

      const invalid = await client.callTool({ name: "project_health", arguments: { projectId: "missing" } });
      expect(invalid.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
    const verifier = await ProjectContextApp.create();
    try {
      expect(verifier.watchList()).toHaveLength(0);
    } finally {
      verifier.close();
    }
  });

  it("negotiates and calls tools over a real stdio transport", async () => {
    const environment = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => (
      item[1] !== undefined
    )));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["node_modules/tsx/dist/cli.mjs", "src/mcp/server.ts"],
      cwd: process.cwd(),
      env: environment,
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools).toHaveLength(35);
      const status = await client.callTool({ name: "storage_status", arguments: {} });
      expect(status.structuredContent).toMatchObject({ result: { configured: true } });
    } finally {
      await client.close();
    }
  });

  it("bounds implicit context results and avoids duplicating large text payloads", async () => {
    const server = createMcpServer();
    const client = new Client({ name: "context-size-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const opened = await call(client, "project_open", { root: projectRoot });
      const projectId = object(opened).id as string;
      await call(client, "memory_remember", {
        projectId,
        type: "decision",
        title: "Large context fixture",
        content: "上下文大小回归测试。".repeat(1_000),
        sourceKind: "user",
      });

      const result = await client.callTool({
        name: "project_context",
        arguments: { projectId, task: "检查上下文大小" },
      });
      expect(result.isError).not.toBe(true);
      const context = object(object(result.structuredContent).result);
      expect(object(context.budget)).toMatchObject({ requestedTokens: 3_000 });

      const largeResult = await client.callTool({
        name: "project_context",
        arguments: { projectId, task: "检查上下文大小", budgetTokens: 8_000 },
      });
      expect(largeResult.isError).not.toBe(true);
      const largeText = largeResult.content?.[0]?.type === "text" ? largeResult.content[0].text : "";
      expect(largeText).toContain("structuredContentAvailable");
      expect(largeText.length).toBeLessThanOrEqual(500);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("propagates MCP request cancellation into a batched search-index rebuild", async () => {
    await Promise.all(Array.from({ length: 80 }, (_, index) => writeFile(
      join(projectRoot, "docs", `${index}.md`),
      `跨会话 MCP 取消测试 ${index}。\n`,
      "utf8",
    )));
    const server = createMcpServer();
    const client = new Client({ name: "cancellation-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const opened = await call(client, "project_open", { root: projectRoot });
      const projectId = object(opened).id as string;
      await call(client, "project_index", { projectId });

      const app = await ProjectContextApp.create();
      const db = app.projects.projectDatabase(projectId);
      db.exec("DELETE FROM search_ngrams; DELETE FROM metadata WHERE key = 'ngram_schema_version';");
      db.close();
      app.close();

      const controller = new AbortController();
      let sawSearchIndexProgress = false;
      const pending = client.callTool({ name: "project_index", arguments: { projectId } }, undefined, {
        signal: controller.signal,
        onprogress: (progress) => {
          if (progress.message?.includes("search index")) {
            sawSearchIndexProgress = true;
            controller.abort();
          }
        },
      });
      await expect(pending).rejects.toThrow(/AbortError/);
      expect(sawSearchIndexProgress).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 50));
      const verifier = await ProjectContextApp.create();
      try {
        expect(object(verifier.health(projectId).lastIndexRun).status).toBe("failed");
      } finally {
        verifier.close();
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  expect(result.structuredContent).toHaveProperty("result");
  return (result.structuredContent as { result: unknown }).result;
}

function object(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  expect(Array.isArray(value)).toBe(true);
  return value as unknown[];
}
