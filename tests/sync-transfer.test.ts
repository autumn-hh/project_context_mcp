import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectContextApp } from "../src/core/app.js";
import { validateRemoteTarget } from "../src/storage/remote/s3.js";
import { remoteFixture } from "./helpers/remote-fixture.js";
import { openDatabase } from "../src/storage/database.js";
import { applyRuleProjection, drainRuleOutbox } from "../src/storage/sync/rule-bridge.js";
import { receiveEvents, outgoingEvents } from "../src/storage/sync/event-store.js";

describe("two-device encrypted synchronization", () => {
  let root: string; let a: ProjectContextApp; let b: ProjectContextApp; let pa: string; let pb: string;
  let env: Record<string, string | undefined>; let remote: Awaited<ReturnType<typeof remoteFixture>>;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sync-transfer-test-"));
    const values = { PROJECT_CONTEXT_HOME: join(root, "a"), PROJECT_CONTEXT_ALLOWED_ROOTS: root, PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS: root,
      SYNC_FIXTURE_ACCESS: "fixture-access", SYNC_FIXTURE_SECRET: "fixture-secret", SYNC_FIXTURE_PASSWORD: "fixture-passphrase" };
    env = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
    remote = await remoteFixture(values.SYNC_FIXTURE_ACCESS, values.SYNC_FIXTURE_SECRET);
    a = await ProjectContextApp.create(); process.env.PROJECT_CONTEXT_HOME = join(root, "b"); b = await ProjectContextApp.create();
    await mkdir(join(root, "project-a")); await mkdir(join(root, "project-b"));
    pa = (await a.openProject(join(root, "project-a"))).id; pb = (await b.openProject(join(root, "project-b"))).id;
    const target = validateRemoteTarget({ endpoint: remote.endpoint, region: "us-east-1", bucket: "sync-fixture",
      accessKeyEnv: "SYNC_FIXTURE_ACCESS", secretKeyEnv: "SYNC_FIXTURE_SECRET", passphraseEnv: "SYNC_FIXTURE_PASSWORD", allowLoopbackHttp: true });
    await a.configureRemote("sync", target); await b.configureRemote("sync", target);
    await a.configureSync(pa, { syncId: "space", remoteName: "sync" });
    await b.configureSync(pb, { syncId: "space", remoteName: "sync" });
  });
  afterEach(async () => {
    a.close(); b.close(); await remote.close();
    for (const [key,value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  });
  it("pushes encrypted events, pulls once, converges conflicts and resumes after reopening", async () => {
    const memory = a.remember(pa, { type: "decision", title: "共同决策", content: "SYNC_SECRET_SENTINEL", sourceKind: "user" });
    expect((await a.syncPush(pa)).events).toBe(2);
    expect([...remote.objects.values()].some(object => object.bytes.includes(Buffer.from("SYNC_SECRET_SENTINEL")))).toBe(false);
    expect((await b.syncPull(pb)).events).toBe(2); expect(b.memories(pb)[0]!.id).toBe(memory.id);
    expect((await b.syncPull(pb)).batches).toBe(0);
    a.setMemoryStatus(pa, memory.id, "stale"); b.setMemoryStatus(pb, memory.id, "deleted");
    await a.syncPush(pa); await b.syncPush(pb); await a.syncPull(pa); await b.syncPull(pb);
    expect(a.syncStatus(pa)).toMatchObject({ conflicts: 1, pending: 0 });
    expect(b.syncStatus(pb)).toMatchObject({ conflicts: 1, pending: 0 });
    const conflict = a.syncConflicts(pa)[0]!;
    await a.resolveSyncConflict(pa, conflict.table, conflict.entity, conflict.versions.find(event => (event.payload as any).status === "deleted")!.id);
    await a.syncPush(pa); await b.syncPull(pb); expect(b.syncStatus(pb)).toMatchObject({ conflicts: 0 });
    b.close(); b = await ProjectContextApp.create(); expect((await b.syncPull(pb)).batches).toBe(0);
    expect(b.memories(pb, "deleted").map(row => row.id)).toContain(memory.id);
  });
  it("keeps local writes usable when remote credentials are unavailable", async () => {
    delete process.env.SYNC_FIXTURE_SECRET;
    a.remember(pa, { type: "fact", title: "离线", content: "继续工作", sourceKind: "user" });
    await expect(a.syncPush(pa)).rejects.toMatchObject({ code: "REMOTE_CREDENTIAL_UNAVAILABLE" });
    expect(a.syncStatus(pa)).toMatchObject({ pending: 2 }); expect(a.memories(pa)).toHaveLength(1);
    process.env.SYNC_FIXTURE_SECRET = "fixture-secret"; await a.syncPush(pa); await b.syncPull(pb);
    expect(b.memories(pb)[0]!.title).toBe("离线");
  });

  it("syncs project rule revisions and excludes personal rules without crossing local project identities", async () => {
    const rule = a.userMemoryService.remember({ type: "constraint", title: "项目规则", content: "仅此项目", sourceKind: "user", scopeLevel: "project", projectId: pa });
    a.userMemoryService.remember({ type: "preference", title: "个人规则", content: "不自动同步", sourceKind: "user" });
    await a.syncPush(pa); await b.syncPull(pb);
    expect(b.userMemoryService.get(rule.id)).toMatchObject({ projectId: pb, title: "项目规则" });
    expect(b.userMemoryService.listAll()).toHaveLength(1);
    a.userMemoryService.updateStatus(rule.id, "stale"); b.userMemoryService.updateStatus(rule.id, "deleted");
    await a.syncPush(pa); await b.syncPush(pb); await a.syncPull(pa); await b.syncPull(pb);
    expect(a.userMemoryService.get(rule.id).status).toBe("deleted");
    expect(b.userMemoryService.get(rule.id).status).toBe("deleted");
    expect(a.syncConflicts(pa).some(conflict => conflict.table === "user_memories")).toBe(true);
  });

  it("captures registry edit parents before remote application, preserving concurrent edits across the bridge", async () => {
    const rule = a.userMemoryService.remember({ type: "constraint", title: "规则", content: "initial", sourceKind: "user", scopeLevel: "project", projectId: pa });
    await a.syncPush(pa); await b.syncPull(pb);
    const registryA = openDatabase(join(root, "a", "registry.db")); const registryB = openDatabase(join(root, "b", "registry.db"));
    const dbA = a.projects.projectDatabase(pa); const dbB = b.projects.projectDatabase(pb);
    try {
      a.userMemoryService.updateStatus(rule.id, "stale"); drainRuleOutbox(registryA, dbA, pa, "space");
      b.userMemoryService.updateStatus(rule.id, "deleted");
      // Receive remote events before the queued registry edit is drained.
      await receiveEvents(dbB, outgoingEvents(dbA));
      applyRuleProjection(registryB, dbB, pb, "space");
      expect(b.syncConflicts(pb).filter(item => item.table === "user_memories")).toHaveLength(1);
      expect(b.userMemoryService.get(rule.id).status).toBe("deleted");
    } finally { registryA.close(); registryB.close(); dbA.close(); dbB.close(); }
  });
});
