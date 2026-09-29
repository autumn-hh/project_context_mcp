import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ProjectContextApp } from "../src/core/app.js";
import { MigrationJobs } from "../src/ui/migration-jobs.js";
import { startUiServer, type UiServerHandle } from "../src/ui/server.js";

describe("durable background migration jobs", () => {
  let root: string;
  let projectRoot: string;
  let projectId: string;
  let ui: UiServerHandle | undefined;
  let environment: Record<string, string | undefined>;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "migration-jobs-"));
    projectRoot = join(root, "project");
    await mkdir(projectRoot);
    await writeFile(join(projectRoot, "hello.ts"), "export const hello = 'world';\n");
    environment = Object.fromEntries(["PROJECT_CONTEXT_HOME", "PROJECT_CONTEXT_ALLOWED_ROOTS", "PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS"].map(key => [key, process.env[key]]));
    process.env.PROJECT_CONTEXT_HOME = join(root, "memory");
    process.env.PROJECT_CONTEXT_ALLOWED_ROOTS = root;
    process.env.PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS = root;
    const app = await ProjectContextApp.create();
    try { projectId = (await app.openProject(projectRoot)).id; await app.index(projectId); }
    finally { app.close(); }
  });
  afterEach(async () => {
    await ui?.close(); ui = undefined;
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  it("acknowledges and polls a real worker without duplicate execution", async () => {
    ui = await startUiServer({ openBrowser: false });
    const token = new URL(ui.launchUrl).hash.slice(7);
    const login = await fetch(`${ui.url}/api/session`, { method: "POST", headers: { Origin: ui.url, "X-Project-Context-UI": "1", "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const headers = { Origin: ui.url, "X-Project-Context-UI": "1", "Content-Type": "application/json", Cookie: cookie };
    const base = `${ui.url}/api/projects/${projectId}/migration-jobs`;
    const requestId = randomUUID();
    const input = { requestId, kind: "compact", confirmProjectId: projectId };
    const response = await fetch(base, { method: "POST", headers, body: JSON.stringify(input) });
    expect(response.status).toBe(202);
    expect((await response.json()).status).toBe("running");
    expect((await fetch(base, { method: "POST", headers, body: JSON.stringify(input) })).status).toBe(202);
    let job;
    for (let attempt = 0; attempt < 100; attempt++) {
      job = await (await fetch(`${base}/${requestId}`, { headers })).json();
      if (job.status !== "running") break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(job.status, JSON.stringify(job)).toBe("completed");
    expect(job.result.status).toBe("completed");
    const persisted = JSON.parse(await readFile(join(projectRoot, ".project-context", "migration-jobs", `${requestId}.json`), "utf8"));
    expect(persisted.status).toBe("completed");
    expect((await (await fetch(base, { headers })).json()).requestId).toBe(requestId);
    const unauthenticated = await fetch(`${base}/${requestId}`, { headers: { "X-Project-Context-UI": "1" } });
    expect(unauthenticated.status).toBe(401);
  }, 15000);

  it("blocks competing requests across managers and legacy mutations", async () => {
    const jobs = new MigrationJobs();
    const requestId = randomUUID();
    jobs.prepare(projectRoot, { requestId, projectId, kind: "compact", excludeDirectories: [] });
    const other = new MigrationJobs();
    expect(() => other.assertIdle(projectRoot)).toThrow("后台运行");
    expect(() => other.prepare(projectRoot, { requestId: randomUUID(), projectId, kind: "upgrade", excludeDirectories: [] })).toThrow();
    expect(other.prepare(projectRoot, { requestId, projectId, kind: "compact", excludeDirectories: [] }).job.requestId).toBe(requestId);
    ui = await startUiServer({ openBrowser: false });
    const headers = { Origin: ui.url, "X-Project-Context-UI": "1", "Content-Type": "application/json" };
    const login = await fetch(`${ui.url}/api/session`, { method: "POST", headers, body: JSON.stringify({ token: new URL(ui.launchUrl).hash.slice(7) }) });
    const authenticated = { ...headers, Cookie: login.headers.get("set-cookie")!.split(";")[0]! };
    const result = await fetch(`${ui.url}/api/projects/${projectId}/index`, { method: "POST", headers: authenticated, body: "{}" });
    expect((await result.json()).code).toBe("INDEX_ALREADY_RUNNING");
  });

  it("reports dead owners as interrupted and never reruns the same request", async () => {
    const jobs = new MigrationJobs();
    const requestId = randomUUID();
    const prepared = jobs.prepare(projectRoot, { requestId, projectId, kind: "upgrade", excludeDirectories: [] });
    await writeFile(join(projectRoot, ".project-context", "migration-jobs", `${requestId}.json`), JSON.stringify({ ...prepared.job, ownerPid: 2147483647 }));
    const restarted = new MigrationJobs();
    expect(restarted.get(projectRoot, requestId)?.status).toBe("interrupted");
    const retry = restarted.prepare(projectRoot, { requestId, projectId, kind: "upgrade", excludeDirectories: [] });
    retry.start();
    expect(retry.job.status).toBe("interrupted");
    expect(retry.job.error?.details?.outcomeUnknown).toBe(true);
  });
});
