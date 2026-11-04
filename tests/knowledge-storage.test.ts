import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod/v4";
import { openDatabase, type SqliteDatabase } from "../src/storage/database.js";
import { migrateProject, PROJECT_SCHEMA_VERSION } from "../src/storage/schema.js";
import { remember } from "../src/memory/memory-service.js";
import { knowledgeRowSchema, type KnowledgeDocument } from "../src/memory/knowledge-schema.js";
import { knowledgeSnapshot, listMemoryKnowledge, proposeMemoryKnowledge, reviewMemoryKnowledge } from "../src/memory/knowledge-service.js";
import { exportKnowledgePack, inspectKnowledgePack, restoreKnowledgePack } from "../src/storage/remote-pack/pack.js";
import { PACK_MAGIC, manifestSchema } from "../src/storage/remote-pack/schema.js";
import { exportProject } from "../src/maintenance/maintenance-service.js";
import {
  acknowledgeEvents, initializeSync, outgoingEvents, receiveEvents, resolveSyncConflict, syncConflicts, syncStatus,
} from "../src/storage/sync/event-store.js";

const quote = "API uses Redis. API depends on Redis.";
const document = (relation: "uses" | "depends_on" = "uses"): KnowledgeDocument => ({
  entities: [
    { key: "api", name: "API", type: "service", aliases: ["Application API"], evidence: quote },
    { key: "cache", name: "Redis", type: "storage", aliases: ["Shared cache"], evidence: quote },
  ],
  relations: [{ from: "api", to: "cache", type: relation, evidence: quote }],
});

describe("reviewed entity knowledge storage compatibility", () => {
  let root: string;
  let a: SqliteDatabase;
  let b: SqliteDatabase;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "knowledge-storage-"));
    a = openDatabase(join(root, "a.db"));
    b = openDatabase(join(root, "b.db"));
    migrateProject(a); migrateProject(b);
  });
  afterEach(async () => {
    a.close(); b.close();
    await rm(root, { recursive: true, force: true });
  });

  function source(db: SqliteDatabase) {
    return remember(db, { type: "decision", title: "Cache architecture", content: quote, sourceKind: "user" });
  }
  function accepted(db: SqliteDatabase, memoryId: string, relation: "uses" | "depends_on" = "uses") {
    const proposal = proposeMemoryKnowledge(db, memoryId, document(relation));
    return reviewMemoryKnowledge(db, { id: proposal.id, action: "accept", expectedVersion: proposal.version });
  }
  function sync() {
    initializeSync(a, "knowledge-space", "device-a");
    initializeSync(b, "knowledge-space", "device-b");
  }
  async function exchange() {
    const left = outgoingEvents(a, 1000), right = outgoingEvents(b, 1000);
    await receiveEvents(b, left); await receiveEvents(a, right);
    acknowledgeEvents(a, left.map((event) => event.id));
    acknowledgeEvents(b, right.map((event) => event.id));
  }
  async function pack(db = a, filename = "knowledge.pcmp") {
    const path = join(root, filename);
    const manifest = await exportKnowledgePack({ db, project: { id: "prj_fixture", name: "Fixture" }, destination: path, allowedRoots: [root] });
    return { path, manifest };
  }
  it("includes the full reviewed annotation and row count in JSONL export", async () => {
    const memory = source(a); const annotation = accepted(a, memory.id);
    const target = join(root, "jsonl");
    await exportProject(a, { id: "fixture", name: "Fixture", rootPath: root, remoteUrl: null, createdAt: "", updatedAt: "", lastOpenedAt: "", archivedAt: null }, target, [root]);
    const manifest = JSON.parse(await readFile(join(target, "manifest.json"), "utf8"));
    expect(manifest.files["memory-knowledge.jsonl"]).toBe(1);
    const row = JSON.parse(await readFile(join(target, "memory-knowledge.jsonl"), "utf8"));
    expect(row).toMatchObject({ id: annotation.id, status: "accepted", version: annotation.version, memory_hash: annotation.memoryHash });
    expect(JSON.parse(row.document_json)).toEqual(annotation.document);
  });

  it("round-trips complete annotations after their memories without exporting code indexes", async () => {
    const memory = source(a);
    accepted(a, memory.id);
    const pending = proposeMemoryKnowledge(a, memory.id, document("depends_on"));
    a.prepare("INSERT INTO sources VALUES('src','index.ts','code','hash',1,0,'')").run();
    a.prepare("INSERT INTO chunks VALUES('chunk','src','index.ts','PRIVATE_CODE_SENTINEL',1,1)").run();
    const original = a.prepare("SELECT * FROM memory_knowledge ORDER BY id").all();
    const { path, manifest } = await pack();
    expect(manifest.schemaVersion).toBe(10);
    const tables = manifest.shards.map((shard) => shard.table);
    expect(tables.indexOf("memory_knowledge")).toBeGreaterThan(tables.indexOf("memories"));
    expect(tables.indexOf("memory_knowledge")).toBeLessThan(tables.indexOf("memory_sources"));
    expect((await readFile(path)).includes(Buffer.from("PRIVATE_CODE_SENTINEL"))).toBe(false);
    const restored = await restoreKnowledgePack(path, join(root, "restored"), [root]);
    const copy = openDatabase(restored.projectDatabase);
    try {
      expect(copy.prepare("SELECT * FROM memory_knowledge ORDER BY id").all()).toEqual(original);
      expect(knowledgeSnapshot(copy)).toEqual(knowledgeSnapshot(a));
      expect(listMemoryKnowledge(copy, { status: "pending" }).items[0]?.id).toBe(pending.id);
      expect(copy.pragma("foreign_key_check")).toEqual([]);
      copy.prepare("DELETE FROM memories WHERE id=?").run(memory.id);
      expect(copy.prepare("SELECT COUNT(*) FROM memory_knowledge").pluck().get()).toBe(0);
    } finally { copy.close(); }
  });

  it("restores an actual schema 9 table layout into schema 10 with an empty knowledge table", async () => {
    const memory = source(a);
    a.exec("DROP TABLE memory_knowledge");
    a.pragma("user_version = 9");
    const { path, manifest } = await pack();
    expect(manifest.schemaVersion).toBe(9);
    const restored = await restoreKnowledgePack(path, join(root, "legacy"), [root]);
    const copy = openDatabase(restored.projectDatabase);
    try {
      expect(copy.pragma("user_version", { simple: true })).toBe(PROJECT_SCHEMA_VERSION);
      expect(copy.prepare("SELECT id FROM memories").pluck().get()).toBe(memory.id);
      expect(copy.prepare("SELECT COUNT(*) FROM memory_knowledge").pluck().get()).toBe(0);
    } finally { copy.close(); }
  });

  it("marks new packages incompatible with schema 9 readers and rejects a falsely downgraded manifest", async () => {
    accepted(a, source(a).id);
    const { path, manifest } = await pack();
    // Version 9 readers required this exact schema literal before decoding shards.
    expect(z.object({ schemaVersion: z.literal(9) }).safeParse(manifest).success).toBe(false);
    expect(manifestSchema.safeParse({ ...manifest, schemaVersion: 9 }).success).toBe(false);
    const bytes = await readFile(path);
    const length = bytes.readUInt32BE(PACK_MAGIC.length);
    const changed = Buffer.from(JSON.stringify({ ...manifest, schemaVersion: 9 }));
    const header = Buffer.alloc(4); header.writeUInt32BE(changed.length);
    await writeFile(path, Buffer.concat([PACK_MAGIC, header, changed, bytes.subarray(PACK_MAGIC.length + 4 + length)]));
    await expect(inspectKnowledgePack(path, [root])).rejects.toMatchObject({ code: "INVALID_REMOTE_PACK" });
    // A mismatched database version must not silently omit a populated new table.
    a.pragma("user_version = 9");
    await expect(pack(a, "downgraded.pcmp")).rejects.toMatchObject({ code: "INVALID_REMOTE_PACK" });
  });

  it("rejects missing memory dependencies during snapshot restore without publishing partial data", async () => {
    const memory = source(a);
    accepted(a, memory.id);
    const { path, manifest } = await pack();
    const bytes = await readFile(path);
    const length = bytes.readUInt32BE(PACK_MAGIC.length);
    const skipped = manifest.shards.filter((shard) => shard.table === "memories").reduce((sum, shard) => sum + shard.bytes, 0);
    const changed = Buffer.from(JSON.stringify({ ...manifest, shards: manifest.shards.filter((shard) => shard.table !== "memories") }));
    const header = Buffer.alloc(4); header.writeUInt32BE(changed.length);
    await writeFile(path, Buffer.concat([PACK_MAGIC, header, changed, bytes.subarray(PACK_MAGIC.length + 4 + length + skipped)]));
    await expect(restoreKnowledgePack(path, join(root, "broken"), [root])).rejects.toMatchObject({ code: "PACK_RESTORE_FAILED" });
  });

  it("buffers out-of-order annotation events until their memory and causal parents arrive", async () => {
    sync();
    const memory = source(a);
    const knowledge = accepted(a, memory.id);
    const events = outgoingEvents(a);
    const annotation = events.filter((event) => event.table === "memory_knowledge");
    expect(annotation).toHaveLength(2);
    expect((await receiveEvents(b, annotation.slice().reverse())).status).toMatchObject({ waiting: 2 });
    expect(b.prepare("SELECT COUNT(*) FROM memory_knowledge").pluck().get()).toBe(0);
    await receiveEvents(b, events.filter((event) => event.table !== "memory_knowledge"));
    expect(syncStatus(b)).toMatchObject({ waiting: 0, conflicts: 0 });
    expect(listMemoryKnowledge(b).items[0]).toMatchObject({ id: knowledge.id, status: "accepted", effectiveStatus: "accepted" });
    expect(knowledgeSnapshot(b)).toEqual(knowledgeSnapshot(a));
    expect((await receiveEvents(b, events)).inserted).toBe(0);
  });

  it("upgrades an initialized replica once without rebinding or duplicating existing history", () => {
    sync();
    const memory = source(a);
    const existing = outgoingEvents(a);
    acknowledgeEvents(a, existing.map((event) => event.id));
    for (const operation of ["insert", "update", "delete"]) a.exec(`DROP TRIGGER sync_memory_knowledge_${operation}`);
    const annotation = accepted(a, memory.id);
    expect(outgoingEvents(a)).toEqual([]);
    const before = a.prepare("SELECT COUNT(*) FROM sync_events").pluck().get() as number;
    expect(initializeSync(a, "knowledge-space", "device-a")).toMatchObject({ deviceId: "device-a", pending: 1 });
    expect(outgoingEvents(a)[0]).toMatchObject({ table: "memory_knowledge", entity: annotation.id, device: "baseline" });
    initializeSync(a, "knowledge-space", "device-a");
    expect(a.prepare("SELECT COUNT(*) FROM sync_events").pluck().get()).toBe(before + 1);
    reviewMemoryKnowledge(a, { id: annotation.id, action: "reject", expectedVersion: annotation.version });
    expect(outgoingEvents(a).at(-1)).toMatchObject({ table: "memory_knowledge", parents: [outgoingEvents(a)[0]!.id] });
    expect(() => initializeSync(a, "knowledge-space", "different-device")).toThrow(/already bound/u);
  });

  it("preserves one shared baseline for identical snapshots and queues subsequent knowledge reviews", async () => {
    accepted(a, source(a).id);
    const { path } = await pack();
    const restored = await restoreKnowledgePack(path, join(root, "replica"), [root]);
    b.close(); b = openDatabase(restored.projectDatabase);
    sync();
    expect(outgoingEvents(a).filter((event) => event.table === "memory_knowledge")).toEqual(
      outgoingEvents(b).filter((event) => event.table === "memory_knowledge"),
    );
    await exchange();
    expect(syncConflicts(a)).toEqual([]);
    expect(syncConflicts(b)).toEqual([]);
  });

  it("validates inbound documents transactionally, including unknown fields, references and secrets", async () => {
    sync();
    const memory = source(a);
    accepted(a, memory.id);
    const event = outgoingEvents(a).find((entry) => entry.table === "memory_knowledge")!;
    const row = knowledgeRowSchema.parse(event.payload);
    const badDocuments = [
      { ...document(), executable: "not allowed" },
      { ...document(), relations: [{ from: "api", to: "missing", type: "uses", evidence: quote }] },
    ];
    for (const invalid of badDocuments) {
      await expect(receiveEvents(b, [{ ...event, payload: { ...row, document_json: JSON.stringify(invalid) } }]))
        .rejects.toMatchObject({ code: "INVALID_REMOTE_PACK" });
    }
    const secret = document();
    secret.entities[0]!.evidence = "api_key=abcdefghijklmnopqrstuvwxyz123456";
    await expect(receiveEvents(b, [{ ...event, payload: { ...row, document_json: JSON.stringify(secret) } }]))
      .rejects.toMatchObject({ code: "SENSITIVE_MEMORY_REJECTED" });
    expect(b.prepare("SELECT COUNT(*) FROM sync_events").pluck().get()).toBe(0);
  });

  it("keeps concurrent same-ID reviews pending until one causal version is explicitly resolved", async () => {
    sync();
    const memory = source(a);
    const proposal = proposeMemoryKnowledge(a, memory.id, document());
    await exchange();
    reviewMemoryKnowledge(a, { id: proposal.id, action: "accept", expectedVersion: 1 });
    reviewMemoryKnowledge(b, { id: proposal.id, action: "reject", expectedVersion: 1 });
    await exchange();
    for (const db of [a, b]) {
      expect(listMemoryKnowledge(db).items[0]).toMatchObject({ status: "pending", effectiveStatus: "pending" });
      expect(knowledgeSnapshot(db).entities).toEqual([]);
    }
    const conflict = syncConflicts(a).find((entry) => entry.table === "memory_knowledge")!;
    expect(conflict.versions).toHaveLength(2);
    const chosen = conflict.versions.find((event) => (event.payload as { status: string }).status === "accepted")!;
    await resolveSyncConflict(a, conflict.table, conflict.entity, chosen.id);
    await exchange();
    expect(syncConflicts(b)).toEqual([]);
    expect(listMemoryKnowledge(b).items[0]).toMatchObject({ status: "accepted", effectiveStatus: "accepted" });
    expect(knowledgeSnapshot(b).relations).toHaveLength(1);
  });

  it("preserves competing accepted documents but excludes them until explicit re-review, including a snapshot round trip", async () => {
    sync();
    const memory = source(a);
    await exchange();
    const left = accepted(a, memory.id, "uses");
    accepted(b, memory.id, "depends_on");
    await exchange();
    for (const db of [a, b]) {
      expect(listMemoryKnowledge(db).items.map((item) => [item.status, item.effectiveStatus])).toEqual([
        ["accepted", "stale"], ["accepted", "stale"],
      ]);
      expect(knowledgeSnapshot(db).entities).toEqual([]);
    }
    const { path } = await pack();
    const restored = await restoreKnowledgePack(path, join(root, "conflict"), [root]);
    const copy = openDatabase(restored.projectDatabase);
    try {
      expect(listMemoryKnowledge(copy).items).toHaveLength(2);
      expect(knowledgeSnapshot(copy).entities).toEqual([]);
    } finally { copy.close(); }
    reviewMemoryKnowledge(a, { id: left.id, action: "accept", expectedVersion: left.version });
    await exchange();
    expect(knowledgeSnapshot(b).relations.map((relation) => relation.type)).toEqual(["uses"]);
  });

  it("propagates cascade deletion and never revives knowledge when a deleted memory tombstone wins", async () => {
    sync();
    const memory = source(a);
    const annotation = accepted(a, memory.id);
    await exchange();
    a.prepare("DELETE FROM memories WHERE id=?").run(memory.id);
    const events = outgoingEvents(a);
    expect(events.some((event) => event.table === "memory_knowledge" && event.operation === "delete" && event.entity === annotation.id)).toBe(true);
    await receiveEvents(b, events.slice().reverse());
    expect(a.prepare("SELECT COUNT(*) FROM memory_knowledge").pluck().get()).toBe(0);
    expect(b.prepare("SELECT COUNT(*) FROM memory_knowledge").pluck().get()).toBe(0);
    expect(b.prepare("SELECT status FROM memories WHERE id=?").pluck().get(memory.id)).toBe("deleted");
    expect(knowledgeSnapshot(b).entities).toEqual([]);
    expect(b.pragma("foreign_key_check")).toEqual([]);
    expect((await receiveEvents(b, events)).inserted).toBe(0);
  });

  it("retains annotation history but makes accepted knowledge stale after synchronized source edits", async () => {
    sync();
    const memory = source(a);
    const annotation = accepted(a, memory.id);
    await exchange();
    a.prepare("UPDATE memories SET content=? WHERE id=?").run("API now uses PostgreSQL.", memory.id);
    await exchange();
    expect(listMemoryKnowledge(b).items[0]).toMatchObject({ id: annotation.id, status: "accepted", effectiveStatus: "stale" });
    expect(knowledgeSnapshot(b).entities).toEqual([]);
    expect(b.prepare("SELECT document_json FROM memory_knowledge WHERE id=?").pluck().get(annotation.id))
      .toBe(a.prepare("SELECT document_json FROM memory_knowledge WHERE id=?").pluck().get(annotation.id));
  });
});
