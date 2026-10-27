import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ProjectContextApp } from "../src/core/app.js";
import { startUiServer, type UiServerHandle } from "../src/ui/server.js";
import { createMcpServer } from "../src/mcp/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { remoteFixture } from "./helpers/remote-fixture.js";
import { validateRemoteTarget } from "../src/storage/remote/s3.js";
import { openDatabase } from "../src/storage/database.js";

describe("encrypted remote backup entry points", () => {
  let root: string; let app: ProjectContextApp; let fixture: Awaited<ReturnType<typeof remoteFixture>>;
  let environment: Record<string, string | undefined>; let projectId: string; let ui: UiServerHandle | undefined;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "remote-backup-api-"));
    const values = { PROJECT_CONTEXT_HOME: join(root, "registry"), PROJECT_CONTEXT_ALLOWED_ROOTS: root,
      PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS: root, REMOTE_TEST_ACCESS: "fixture-access", REMOTE_TEST_SECRET: "fixture-only-secret", REMOTE_TEST_PASSWORD: "fixture-only-passphrase" };
    environment = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
    fixture = await remoteFixture(values.REMOTE_TEST_ACCESS, values.REMOTE_TEST_SECRET);
    app = await ProjectContextApp.create(); await mkdir(join(root, "project"));
    projectId = (await app.openProject(join(root, "project"))).id;
    app.remember(projectId, { type: "decision", title: "可恢复", content: "fixture knowledge roundtrip", sourceKind: "user" });
    await app.configureRemote("test", validateRemoteTarget({ endpoint: fixture.endpoint, region: "us-east-1", bucket: "fixture-bucket",
      accessKeyEnv: "REMOTE_TEST_ACCESS", secretKeyEnv: "REMOTE_TEST_SECRET", passphraseEnv: "REMOTE_TEST_PASSWORD", allowLoopbackHttp: true }));
  });
  afterEach(async () => {
    await ui?.close(); ui = undefined; app.close(); await fixture.close();
    for (const [key, value] of Object.entries(environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  });
  function assertRestored(path: string) {
    const db = openDatabase(join(path, "project.db"));
    try { expect(db.prepare("SELECT content FROM memories").pluck().get()).toBe("fixture knowledge roundtrip"); } finally { db.close(); }
  }

  it("CLI keeps local backup syntax and completes remote push/pull", async () => {
    const run = (...args: string[]) => promisify(execFile)(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: process.cwd(), env: process.env });
    const local = join(root, "local.db");
    await run("backup", projectId, local); expect((await readFile(local)).length).toBeGreaterThan(0);
    const { stdout } = await run("backup", "push-remote", projectId, "--remote", "test");
    const result = JSON.parse(stdout); expect(result.historySaved).toBe(true);
    expect([...fixture.objects.values()][0]!.bytes.includes(Buffer.from("fixture knowledge"))).toBe(false);
    await run("backup", "pull-remote", result.key, join(root, "cli-restored"), "--remote", "test");
    assertRestored(join(root, "cli-restored"));
    expect(await app.remoteBackupHistory(projectId)).toEqual([expect.objectContaining({ key: result.key })]);
  });

  it("MCP exposes structured remote backup and restore plus safe error codes", async () => {
    const server = createMcpServer(); const client = new Client({ name: "fixture", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const backup = await client.callTool({ name: "project_backup_remote", arguments: { projectId, remoteName: "test" } });
      expect(backup.isError).not.toBe(true); const result = (backup.structuredContent as { result: { key: string } }).result;
      const restored = await client.callTool({ name: "project_restore_remote", arguments: { remoteName: "test", key: result.key, directory: join(root, "mcp-restored") } });
      expect(restored.isError).not.toBe(true); assertRestored(join(root, "mcp-restored"));
      const failed = await client.callTool({ name: "project_backup_remote", arguments: { projectId, remoteName: "missing" } });
      expect(failed.isError).toBe(true); expect(JSON.stringify(failed.content)).toContain("REMOTE_TARGET_UNAVAILABLE");
      await app.configureSync(projectId, { syncId: "mcp-test", remoteName: "test" });
      for (const name of ["sync_status", "sync_push", "sync_pull", "sync_conflicts"]) {
        const result = await client.callTool({ name, arguments: { projectId } });
        expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
        expect(result.structuredContent).toHaveProperty("result");
      }
    } finally { await client.close(); await server.close(); }
  });

  it("Web requires session/project confirmation and round-trips without revealing credentials", async () => {
    ui = await startUiServer({ openBrowser: false }); let cookie = "";
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(ui!.url + path, { method: body ? "POST" : "GET", headers: { Origin: ui!.url,
        "X-Project-Context-UI": "1", "Content-Type": "application/json", Cookie: cookie }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { response, body: await response.json() };
    };
    expect((await request("/api/remote-targets")).response.status).toBe(401);
    const session = await request("/api/session", { token: new URLSearchParams(new URL(ui.launchUrl).hash.slice(1)).get("token") });
    cookie = session.response.headers.get("set-cookie")!.split(";")[0]!;
    const targets = await request("/api/remote-targets");
    expect(targets.body).toEqual([expect.objectContaining({ name: "test" })]);
    expect(JSON.stringify(targets.body)).not.toContain("fixture-only-secret");
    expect((await request(`/api/projects/${projectId}/remote-backups`, { remoteName: "test", confirmProjectId: "other" })).response.status).toBe(400);
    const backup = await request(`/api/projects/${projectId}/remote-backups`, { remoteName: "test", confirmProjectId: projectId });
    expect(backup.response.status).toBe(200);
    const restored = await request("/api/remote-restore", { remoteName: "test", key: backup.body.key, directory: join(root, "web-restored") });
    expect(restored.response.status).toBe(200); assertRestored(join(root, "web-restored"));
    expect((await request(`/api/projects/${projectId}/sync`)).body).toEqual({ configured: false });
    await app.configureSync(projectId, { syncId: "web-test", remoteName: "test" });
    expect((await request(`/api/projects/${projectId}/sync/push`, {})).response.status).toBe(200);
    expect((await request(`/api/projects/${projectId}/sync/pull`, {})).response.status).toBe(200);
    expect((await request(`/api/projects/${projectId}/sync/conflicts`)).body).toEqual([]);
  });
});
