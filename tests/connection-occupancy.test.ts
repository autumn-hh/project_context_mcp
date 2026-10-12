import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/database.js";
import { connectionDirectory, databaseOccupancy } from "../src/storage/connection-occupancy.js";
import { PACKAGE_VERSION } from "../src/shared/version.js";
import { ProjectContextApp } from "../src/core/app.js";
import { startUiServer } from "../src/ui/server.js";

describe("database connection occupancy", () => {
  let directory: string;
  let databasePath: string;
  let child: ChildProcess | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "project-context-occupancy-"));
    databasePath = join(directory, ".project-context", "project.db");
  });

  afterEach(async () => {
    if (child && child.exitCode === null) {
      const ended = once(child, "exit");
      child.kill();
      await ended;
    }
    child = undefined;
    await rm(connectionDirectory(databasePath), { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  });

  it("counts live registered connections and removes the records on close", async () => {
    const first = openDatabase(databasePath);
    const second = openDatabase(databasePath);
    try {
      const report = await databaseOccupancy(databasePath);
      expect(report.holders.find(holder => holder.pid === process.pid)).toMatchObject({
        version: PACKAGE_VERSION, connectionCount: 2, currentProcess: true, restartRecommended: false,
      });
      first.close();
      const remaining = await databaseOccupancy(databasePath);
      expect(remaining.holders.find(holder => holder.pid === process.pid)?.connectionCount).toBe(1);
    } finally {
      if (first.open) first.close();
      second.close();
    }
    expect(await readdir(connectionDirectory(databasePath))).toEqual([]);
    expect((await databaseOccupancy(databasePath)).holders).toEqual([]);
  }, 20000);

  it("identifies registered old versions without storing command lines or credentials", async () => {
    const db = openDatabase(databasePath);
    try {
      const [name] = await readdir(connectionDirectory(databasePath));
      await writeFile(join(connectionDirectory(databasePath), name!), JSON.stringify({
        pid: process.pid, version: "0.9.7", role: "MCP", openedAt: new Date().toISOString(),
        processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      }));
      const report = await databaseOccupancy(databasePath);
      expect(report.holders.find(holder => holder.pid === process.pid)).toMatchObject({
        version: "0.9.7", roles: ["MCP"], restartRecommended: true,
      });
      expect(JSON.stringify(report)).not.toContain("argv");
      expect(JSON.stringify(report)).not.toContain("environment");
    } finally { db.close(); }
  }, 15000);

  it("serves authenticated occupancy without opening the project database", async () => {
    const previous = Object.fromEntries(["PROJECT_CONTEXT_HOME", "PROJECT_CONTEXT_ALLOWED_ROOTS", "PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS"].map(key => [key, process.env[key]]));
    process.env.PROJECT_CONTEXT_HOME = join(directory, "memory");
    process.env.PROJECT_CONTEXT_ALLOWED_ROOTS = directory;
    process.env.PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS = directory;
    let ui: Awaited<ReturnType<typeof startUiServer>> | undefined;
    let app: ProjectContextApp | undefined;
    try {
      app = await ProjectContextApp.create();
      const project = await app.openProject(directory);
      ui = await startUiServer({ openBrowser: false });
      const endpoint = ui.url + "/api/projects/" + project.id + "/migration-connections";
      expect((await fetch(endpoint)).status).toBe(403);
      const session = await fetch(ui.url + "/api/session", { method: "POST", headers: { origin: ui.url, "content-type": "application/json", "x-project-context-ui": "1" },
        body: JSON.stringify({ token: new URLSearchParams(new URL(ui.launchUrl).hash.slice(1)).get("token") }) });
      const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
      const response = await fetch(endpoint, { headers: { cookie, "x-project-context-ui": "1" } });
      expect(response.status).toBe(200);
      const report = await response.json();
      expect(report.databasePath).toBe(databasePath);
      expect(report.holders).toEqual([]);
      expect(report.currentVersion).toBe(PACKAGE_VERSION);
    } finally {
      await ui?.close();
      app?.close();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }, 15000);

  it.skipIf(process.platform !== "win32")("discovers an unregistered legacy process through Windows file handles", async () => {
    const db = openDatabase(databasePath);
    db.close();
    child = spawn(process.execPath, ["-e", "const db = new (require('better-sqlite3'))(process.env.OCCUPANCY_TEST_DATABASE); db.pragma('journal_mode = WAL'); console.log('ready'); setInterval(() => {}, 1000);"], {
      windowsHide: true, env: { ...process.env, OCCUPANCY_TEST_DATABASE: databasePath }, stdio: ["ignore", "pipe", "pipe"],
    });
    await once(child.stdout!, "data");
    const report = await databaseOccupancy(databasePath);
    expect(report.operatingSystemProbe).toBe("available");
    expect(report.holders.find(holder => holder.pid === child!.pid)).toMatchObject({
      version: null, roles: ["未登记进程"], restartRecommended: true, evidence: ["operating-system"],
    });
  }, 15000);
});
