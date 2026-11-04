import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ProjectContextApp } from "../src/core/app.js";
import { createMcpServer } from "../src/mcp/server.js";
import { processFreshness, selectOutdatedServers, type RunningProcess } from "../src/shared/process-freshness.js";
import { PROJECT_SCHEMA_VERSION } from "../src/storage/schema.js";

describe("outdated processes", () => {
  let tempRoot: string;
  let projectRoot: string;
  let previousEnvironment: Record<string, string | undefined>;
  const originalCodeChanged = processFreshness.codeChanged;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "project-context-freshness-"));
    projectRoot = join(tempRoot, "project");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(join(projectRoot, "README.md"), "# Project\n", "utf8");
    previousEnvironment = {
      PROJECT_CONTEXT_HOME: process.env.PROJECT_CONTEXT_HOME,
      PROJECT_CONTEXT_ALLOWED_ROOTS: process.env.PROJECT_CONTEXT_ALLOWED_ROOTS,
    };
    process.env.PROJECT_CONTEXT_HOME = join(tempRoot, "memory");
    process.env.PROJECT_CONTEXT_ALLOWED_ROOTS = tempRoot;
  });

  afterEach(async () => {
    processFreshness.codeChanged = originalCodeChanged;
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("pauses indexing and watching once the installed build changed under the process", async () => {
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      app.watchStart(project.id, 100, false);
      processFreshness.codeChanged = () => true;
      await expect(app.index(project.id)).rejects.toMatchObject({ code: "MCP_PROCESS_OUTDATED" });
      await writeFile(join(projectRoot, "notes.md"), "# Changed after the rebuild\n", "utf8");
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(app.watchList()).toEqual([]);
    } finally {
      for (const watch of app.watchList()) app.watchStop(watch.projectId);
      app.close();
    }
  });

  it("refuses to index a database upgraded by a newer version", async () => {
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      const db = app.projects.projectDatabase(project.id);
      db.pragma(`user_version = ${PROJECT_SCHEMA_VERSION + 1}`);
      db.close();
      await expect(app.index(project.id)).rejects.toMatchObject({ code: "MCP_PROCESS_OUTDATED" });
    } finally {
      app.close();
    }
  });

  it("still opens a project over MCP from an outdated process, without indexing or watching", async () => {
    processFreshness.codeChanged = () => true;
    const server = createMcpServer();
    const client = new Client({ name: "freshness-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const response = await client.callTool({ name: "project_open", arguments: { root: projectRoot } });
      expect(response.isError).not.toBe(true);
      const opened = (response.structuredContent as { result: Record<string, unknown> }).result;
      expect(opened).toMatchObject({ rootPath: expect.any(String), managedIndex: null, watch: null });
      expect(String((opened.warnings as string[])[0])).toContain("restart this MCP");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("selects only long-lived servers of this installation that started before the current build", () => {
    const build = Date.parse("2026-11-04T12:00:00Z");
    const before = build - 60_000;
    const processes: RunningProcess[] = [
      { pid: 11, startedAt: before, commandLine: "\"C:\\node\\node.exe\" D:/project/project-context-mcp/dist/mcp/server.js" },
      { pid: 12, startedAt: before, commandLine: "node D:\\Project\\project-context-mcp\\dist\\cli.js ui --no-open" },
      { pid: 13, startedAt: before, commandLine: "node D:/project/project-context-mcp/dist/cli.js watch prj_1" },
      { pid: 14, startedAt: before, commandLine: "node D:/project/project-context-mcp/dist/cli.js index prj_1" },
      { pid: 15, startedAt: before, commandLine: "node C:/other/project-context-mcp/dist/mcp/server.js" },
      { pid: 16, startedAt: build + 5_000, commandLine: "node D:/project/project-context-mcp/dist/mcp/server.js" },
      { pid: 17, startedAt: before, commandLine: "node D:/project/project-context-mcp/dist/mcp/server.js" },
    ];
    expect(selectOutdatedServers(processes, "D:\\project\\project-context-mcp", build, 17).map((item) => item.pid)).toEqual([11, 12, 13]);
  });
});
