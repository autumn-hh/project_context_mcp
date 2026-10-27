import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectContextApp } from "../src/core/app.js";
import { openDatabase } from "../src/storage/database.js";

describe("portable snapshots through the application", () => {
  let root: string; let app: ProjectContextApp; let environment: Record<string, string | undefined>;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pack-app-test-"));
    const values = { PROJECT_CONTEXT_HOME: join(root, "registry"), PROJECT_CONTEXT_ALLOWED_ROOTS: root,
      PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS: root, PROJECT_CONTEXT_PACK_TEST_PASSWORD: "fixture-only-passphrase" };
    environment = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    Object.assign(process.env, values); app = await ProjectContextApp.create();
    await mkdir(join(root, "project"));
  });
  afterEach(async () => {
    app.close();
    for (const [key, value] of Object.entries(environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  });

  it("encrypts the whole knowledge container and restores a searchable registered project", async () => {
    const project = await app.openProject(join(root, "project"));
    const memory = app.remember(project.id, { type: "decision", title: "包格式", content: "KNOWLEDGE_CONFIDENTIAL_SENTINEL", sourceKind: "user" });
    const rule = app.userMemoryService.remember({ type: "constraint", title: "规则", content: "显式选择", sourceKind: "user", scopeLevel: "project", projectId: project.id });
    const target = join(root, "knowledge.pcmb");
    await app.exportEncryptedPack(project.id, target, "PROJECT_CONTEXT_PACK_TEST_PASSWORD", { userMemoryIds: [rule.id] });
    const bytes = await readFile(target);
    expect(bytes.includes(Buffer.from("KNOWLEDGE_CONFIDENTIAL_SENTINEL"))).toBe(false);
    expect(bytes.includes(Buffer.from("sourceProject"))).toBe(false);
    const result = await app.restoreEncryptedPack(target, join(root, "staged"), "PROJECT_CONTEXT_PACK_TEST_PASSWORD");
    expect(result.rulesApplied).toBe(false);
    const ruleDb = openDatabase(result.rulesDatabase);
    try { expect(ruleDb.prepare("SELECT id FROM user_memories").pluck().all()).toEqual([rule.id]); } finally { ruleDb.close(); }
    await mkdir(join(root, "restored-project"));
    const restored = await app.restoreProject({ source: result.projectDatabase, root: join(root, "restored-project") });
    const restoredId = (restored.project as { id: string }).id;
    expect(restoredId).not.toBe(project.id);
    expect(app.memories(restoredId).map(row => row.id)).toContain(memory.id);
    expect(app.search(restoredId, "KNOWLEDGE_CONFIDENTIAL_SENTINEL").length).toBeGreaterThan(0);
    expect(await app.importPackRules(restoredId, result.rulesDatabase)).toMatchObject({ applied: false, added: 1 });
    const imported = await app.importPackRules(restoredId, result.rulesDatabase, { apply: true });
    expect(imported).toMatchObject({ applied: true, added: 1 });
    const importedId = imported.mappings[0]!.targetId!;
    expect(app.userMemoryService.get(importedId)).toMatchObject({ projectId: restoredId, status: "active" });
    expect(await app.importPackRules(restoredId, result.rulesDatabase, { apply: true })).toMatchObject({ added: 0, unchanged: 1 });
    app.userMemoryService.updateStatus(importedId, "deleted");
    await expect(app.importPackRules(restoredId, result.rulesDatabase, { apply: true })).rejects.toMatchObject({ code: "PACK_RULE_CONFLICT" });
    expect((await readdir(root)).filter(name => name.startsWith(".encrypted-") || name.endsWith(".restore.db"))).toEqual([]);
  });

  it("rejects wrong keys and authenticated metadata tampering without creating a destination", async () => {
    const project = await app.openProject(join(root, "project"));
    const target = join(root, "knowledge.pcmb");
    await app.exportEncryptedPack(project.id, target, "PROJECT_CONTEXT_PACK_TEST_PASSWORD");
    process.env.PROJECT_CONTEXT_PACK_TEST_PASSWORD = "wrong";
    await expect(app.restoreEncryptedPack(target, join(root, "failed"), "PROJECT_CONTEXT_PACK_TEST_PASSWORD"))
      .rejects.toMatchObject({ code: "ENCRYPTED_BACKUP_DECRYPT_FAILED" });
    process.env.PROJECT_CONTEXT_PACK_TEST_PASSWORD = "fixture-only-passphrase";
    const bytes = await readFile(target); const headerSize = bytes.readUInt32BE(9);
    const header = JSON.parse(bytes.subarray(13, 13 + headerSize).toString());
    header.sourceName = header.sourceName.replace("knowledge", "KNOWLEDGE");
    Buffer.from(JSON.stringify(header)).copy(bytes, 13);
    await writeFile(target, bytes);
    await expect(app.restoreEncryptedPack(target, join(root, "failed"), "PROJECT_CONTEXT_PACK_TEST_PASSWORD"))
      .rejects.toMatchObject({ code: "ENCRYPTED_BACKUP_DECRYPT_FAILED" });
    expect(await readdir(root)).not.toContain("failed");
  });

  it("requires explicit global and workspace scope mapping before rule import", async () => {
    const project = await app.openProject(join(root, "project"));
    const global = app.userMemoryService.remember({ type: "preference", title: "全局", content: "明确启用", sourceKind: "user" });
    const workspace = app.userMemoryService.remember({ type: "constraint", title: "工作区", content: "明确映射", sourceKind: "user", scopeLevel: "workspace", scopeRef: root });
    const path = join(root, "rules.pcmp");
    await app.exportPack(project.id, path, { userMemoryIds: [global.id, workspace.id] });
    const staged = await app.restorePack(path, join(root, "staged-rules"));
    await expect(app.importPackRules(project.id, staged.rulesDatabase, { apply: true })).rejects.toBeDefined();
    expect(app.userMemoryService.listAll()).toHaveLength(2);
    const destination = join(root, "new-workspace");
    const imported = await app.importPackRules(project.id, staged.rulesDatabase, { apply: true, allowGlobal: true, workspaceRoot: destination });
    expect(imported.added).toBe(2);
    const mapping = imported.mappings.find(row => row.sourceId === workspace.id)!;
    expect(app.userMemoryService.get(mapping.targetId!)).toMatchObject({ scopeLevel: "workspace", scopeRef: destination, projectId: null });
  });
});
