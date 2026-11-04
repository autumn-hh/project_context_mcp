import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateProject, PROJECT_SCHEMA_VERSION } from "../src/storage/schema.js";
import { restoreSchema10Ngrams } from "./helpers/schema.js";
import { remember, updateMemoryStatus } from "../src/memory/memory-service.js";
import {
  knowledgeDocumentSchema, knowledgeRowSchema, type KnowledgeDocument,
} from "../src/memory/knowledge-schema.js";
import {
  proposeMemoryKnowledge, reviewMemoryKnowledge, listMemoryKnowledge, knowledgeSnapshot, memoryKnowledgeHash,
} from "../src/memory/knowledge-service.js";

const quote = "TeamService uses SQLite and provides SharedMemory.";
function document(): KnowledgeDocument {
  return {
    entities: [
      { key: "service", name: "TeamService", type: "service", aliases: ["Team"], evidence: quote },
      { key: "database", name: "SQLite", type: "storage", aliases: ["LocalDB"], evidence: quote },
      { key: "memory", name: "SharedMemory", type: "concept", aliases: [], evidence: quote },
    ],
    relations: [
      { from: "service", to: "database", type: "uses", evidence: quote },
      { from: "service", to: "memory", type: "provides", evidence: quote },
    ],
  };
}

describe("reviewed local memory knowledge", () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(":memory:"); db.pragma("foreign_keys=ON"); migrateProject(db); });
  afterEach(() => db.close());
  const memory = (content = quote) => remember(db, { type: "decision", title: "Architecture", content, sourceKind: "user" });
  function accept(memoryId: string, doc = document()) {
    const candidate = proposeMemoryKnowledge(db, memoryId, doc);
    return reviewMemoryKnowledge(db, { id: candidate.id, action: "accept", expectedVersion: candidate.version });
  }

  it("migrates v9 databases without altering existing memories and cascades annotation deletion", () => {
    const item = memory();
    restoreSchema10Ngrams(db);
    db.exec("DROP TABLE memory_knowledge; PRAGMA user_version=9");
    migrateProject(db);
    expect(db.pragma("user_version", { simple: true })).toBe(PROJECT_SCHEMA_VERSION);
    expect(db.prepare("SELECT content FROM memories WHERE id=?").pluck().get(item.id)).toBe(quote);
    const candidate = proposeMemoryKnowledge(db, item.id, document());
    expect(candidate.status).toBe("pending");
    db.prepare("DELETE FROM memory_sources WHERE memory_id=?").run(item.id);
    db.prepare("DELETE FROM memories WHERE id=?").run(item.id);
    expect(db.prepare("SELECT COUNT(*) FROM memory_knowledge").pluck().get()).toBe(0);
  });

  it("keeps proposals pending and canonical retry idempotent without changing records", () => {
    const item = memory();
    const proposed = proposeMemoryKnowledge(db, item.id, document(), memoryKnowledgeHash(item));
    expect(proposed).toMatchObject({ status: "pending", effectiveStatus: "pending", version: 1 });
    expect(knowledgeSnapshot(db).entities).toEqual([]);
    const reordered = document();
    reordered.entities.reverse();
    reordered.relations.reverse();
    const before = db.prepare("SELECT total_changes()").pluck().get();
    expect(proposeMemoryKnowledge(db, item.id, reordered)).toEqual(proposed);
    expect(db.prepare("SELECT total_changes()").pluck().get()).toBe(before);
    const rejected = reviewMemoryKnowledge(db, { id: proposed.id, action: "reject", expectedVersion: 1 });
    expect(proposeMemoryKnowledge(db, item.id, document())).toEqual(rejected);
    expect(rejected.version).toBe(2);
  });

  it("requires exact source quotes, grounded entity names, valid endpoints, and no semantic self loops", () => {
    const item = memory();
    const wrongQuote = document(); wrongQuote.entities[0]!.evidence = "TeamService uses other storage.";
    expect(() => proposeMemoryKnowledge(db, item.id, wrongQuote)).toThrow(/quotation/u);
    const hallucinated = document(); hallucinated.entities[0]!.name = "UnknownService"; hallucinated.entities[0]!.aliases = [];
    expect(() => proposeMemoryKnowledge(db, item.id, hallucinated)).toThrow(/name/u);
    const missingEndpoint = document(); missingEndpoint.relations[0]!.to = "missing";
    expect(() => proposeMemoryKnowledge(db, item.id, missingEndpoint)).toThrow();
    const self = document(); self.relations[0]!.to = "service";
    expect(() => proposeMemoryKnowledge(db, item.id, self)).toThrow();
    const relationQuote = document(); relationQuote.relations[0]!.evidence = "TeamService";
    expect(() => proposeMemoryKnowledge(db, item.id, relationQuote)).toThrow(/both/u);
    const normalized = document();
    normalized.entities[1] = { key: "other", name: "teamservice", type: "service", aliases: ["TeamService"], evidence: quote };
    normalized.relations = [];
    expect(() => proposeMemoryKnowledge(db, item.id, normalized)).toThrow(/repeat/u);
  });

  it("does not match a Latin entity inside an unrelated larger word", () => {
    const item = memory("Digit provides parser.");
    const doc = {
      entities: [{ key: "git", name: "Git", type: "technology", aliases: [], evidence: "Digit provides parser." }],
      relations: [],
    };
    expect(() => proposeMemoryKnowledge(db, item.id, doc)).toThrow(/name/u);
  });

  it("requires review even when a complete quote contains negation or a condition", () => {
    const text = "TeamService does not use SQLite unless an administrator authorizes it.";
    const item = memory(text);
    const doc = document(); doc.entities.pop(); doc.relations.pop();
    doc.entities.forEach((entity) => entity.evidence = text);
    doc.relations[0]!.evidence = text;
    const candidate = proposeMemoryKnowledge(db, item.id, doc);
    expect(candidate.status).toBe("pending");
    expect(candidate.document.relations[0]!.evidence).toContain("does not");
    expect(knowledgeSnapshot(db).relations).toEqual([]);
    const accepted = reviewMemoryKnowledge(db, { id: candidate.id, action: "accept", expectedVersion: 1 });
    expect(accepted.status).toBe("accepted");
    expect(knowledgeSnapshot(db).relations[0]!.quote).toBe(text);
  });

  it("enforces optimistic versions and atomically supersedes the previous accepted annotation", () => {
    const item = memory();
    const first = accept(item.id);
    const secondDoc = document(); secondDoc.entities[0]!.aliases.push("SharedTeam");
    const second = proposeMemoryKnowledge(db, item.id, secondDoc);
    expect(() => reviewMemoryKnowledge(db, { id: second.id, action: "accept", expectedVersion: 7 })).toThrow(/changed/u);
    const accepted = reviewMemoryKnowledge(db, { id: second.id, action: "accept", expectedVersion: 1 });
    expect(accepted.version).toBe(2);
    const old = listMemoryKnowledge(db, { status: "superseded" }).items[0]!;
    expect(old.id).toBe(first.id);
    expect(old.version).toBe(3);
    expect(listMemoryKnowledge(db, { status: "accepted" }).items.map((record) => record.id)).toEqual([second.id]);
    expect(() => reviewMemoryKnowledge(db, { id: first.id, action: "accept", expectedVersion: 2 })).toThrow(/changed/u);
    expect(() => reviewMemoryKnowledge(db, { id: first.id, action: "accept", expectedVersion: 3 })).toThrow(/pending/u);
  });

  it("derives stale from changed or inactive memory while still permitting rejection", () => {
    const item = memory();
    const first = accept(item.id);
    db.prepare("UPDATE memories SET content=? WHERE id=?").run("New text.", item.id);
    expect(listMemoryKnowledge(db, { status: "stale" }).items[0]).toMatchObject({
      id: first.id, status: "accepted", effectiveStatus: "stale",
    });
    expect(knowledgeSnapshot(db).entities).toEqual([]);
    expect(() => reviewMemoryKnowledge(db, { id: first.id, action: "accept", expectedVersion: first.version })).toThrow(/changed/u);
    expect(reviewMemoryKnowledge(db, { id: first.id, action: "reject", expectedVersion: first.version }).status).toBe("rejected");
    const second = memory(); const pending = proposeMemoryKnowledge(db, second.id, document());
    updateMemoryStatus(db, second.id, "stale");
    expect(listMemoryKnowledge(db, { status: "stale" }).items.map((record) => record.id)).toContain(pending.id);
    expect(() => proposeMemoryKnowledge(db, second.id, document())).toThrow(/active/u);
  });

  it("checks expected hashes and excludes task summaries even when active", () => {
    const item = memory();
    expect(() => proposeMemoryKnowledge(db, item.id, document(), "a".repeat(64))).toThrow(/changed/u);
    const summary = remember(db, { type: "task-summary", title: "Completed", content: quote, sourceKind: "tool" });
    expect(() => proposeMemoryKnowledge(db, summary.id, document())).toThrow(/non-summary/u);
  });

  it("merges only canonical entity names and combines reviewed aliases without alias-based entity merging", () => {
    const a = memory();
    const firstDoc = document();
    accept(a.id, firstDoc);
    const b = memory("teamservice uses PostgreSQL. TeamService is a readable alias.");
    const secondDoc: KnowledgeDocument = {
      entities: [
        { key: "service", name: "teamservice", type: "service", aliases: ["TeamService", "Coordinator"], evidence: b.content },
        { key: "db", name: "PostgreSQL", type: "storage", aliases: ["LocalDB"], evidence: b.content },
      ],
      relations: [{ from: "service", to: "db", type: "uses", evidence: b.content }],
    };
    accept(b.id, secondDoc);
    const snapshot = knowledgeSnapshot(db);
    const service = snapshot.entities.find((entity) => entity.type === "service")!;
    expect(service.memoryIds.sort()).toEqual([a.id, b.id].sort());
    expect(service.aliases).toContain("Coordinator");
    expect(snapshot.entities.filter((entity) => entity.type === "storage")).toHaveLength(2);
    expect(new Set(snapshot.relations.map((relation) => relation.memoryId))).toEqual(new Set([a.id, b.id]));
    expect(snapshot.bindings.every((binding) => binding.annotationId && binding.quote)).toBe(true);
    const changes = db.prepare("SELECT total_changes()").pluck().get();
    knowledgeSnapshot(db);
    expect(db.prepare("SELECT total_changes()").pluck().get()).toBe(changes);
  });

  it("paginates effective status and finds older valid knowledge past stale history pages", () => {
    const goodMemory = memory(); const good = accept(goodMemory.id);
    db.prepare("UPDATE memory_knowledge SET updated_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(good.id);
    for (let i = 0; i < 8; i += 1) {
      const item = memory(); accept(item.id);
      db.prepare("UPDATE memories SET content='Changed' WHERE id=?").run(item.id);
    }
    const stale = listMemoryKnowledge(db, { status: "stale", limit: 3, offset: 3 });
    expect(stale).toMatchObject({ total: 8, limit: 3, offset: 3 });
    expect(stale.items).toHaveLength(3);
    const snapshot = knowledgeSnapshot(db, { limit: 1 });
    expect(snapshot.bindings.every((binding) => binding.memoryId === goodMemory.id)).toBe(true);
    expect(snapshot.truncated).toBe(false);
    const second = memory(); accept(second.id);
    expect(knowledgeSnapshot(db, { limit: 1 }).truncated).toBe(true);
    expect(listMemoryKnowledge(db, { query: "LocalDB", status: "accepted" }).items).toHaveLength(2);
  });

  it("keeps projects isolated and rejects malformed documents, rows and suspected secrets", () => {
    const item = memory(); const proposal = proposeMemoryKnowledge(db, item.id, document());
    const other = new Database(":memory:"); migrateProject(other);
    try {
      expect(() => reviewMemoryKnowledge(other, { id: proposal.id, action: "accept", expectedVersion: 1 })).toThrow(/unavailable/u);
      expect(knowledgeSnapshot(other).entities).toEqual([]);
    } finally { other.close(); }
    expect(() => knowledgeDocumentSchema.parse({ ...document(), arbitrary: true })).toThrow();
    expect(() => knowledgeDocumentSchema.parse({ entities: [], relations: [] })).toThrow();
    expect(() => knowledgeDocumentSchema.parse({ ...document(), entities: Array.from({ length: 13 }, () => document().entities[0]) })).toThrow();
    const row = db.prepare("SELECT * FROM memory_knowledge WHERE id=?").get(proposal.id) as object;
    expect(knowledgeRowSchema.safeParse(row).success).toBe(true);
    expect(knowledgeRowSchema.safeParse({ ...row, version: 0 }).success).toBe(false);
    expect(knowledgeRowSchema.safeParse({ ...row, document_json: "{}" }).success).toBe(false);
    expect(knowledgeRowSchema.safeParse({ ...row, extra: 1 }).success).toBe(false);
    const secret = document(); secret.entities[0]!.aliases = ["api_key=abcdefghijklmnopqrstuvwxyz123456"];
    expect(() => proposeMemoryKnowledge(db, item.id, secret)).toThrow(/credential/u);
  });

  it("excludes concurrent accepted documents until an explicit reviewed winner supersedes peers", () => {
    const item = memory(); const first = accept(item.id);
    const alternate = document(); alternate.entities[0]!.aliases.push("Coordinator");
    const second = proposeMemoryKnowledge(db, item.id, alternate);
    // Simulate independent device acceptance arriving through an auditable sync projection.
    db.prepare("UPDATE memory_knowledge SET status='accepted',version=2 WHERE id=?").run(second.id);
    const stale = listMemoryKnowledge(db, { status: "stale" });
    expect(stale.items.map((entry) => entry.id).sort()).toEqual([first.id, second.id].sort());
    expect(stale.items.every((entry) => entry.status === "accepted")).toBe(true);
    expect(knowledgeSnapshot(db).entities).toEqual([]);
    const winner = reviewMemoryKnowledge(db, { id: second.id, action: "accept", expectedVersion: 2 });
    expect(winner).toMatchObject({ status: "accepted", effectiveStatus: "accepted", version: 3 });
    expect(listMemoryKnowledge(db, { status: "superseded" }).items[0]!.id).toBe(first.id);
    expect(knowledgeSnapshot(db).entities.length).toBeGreaterThan(0);
  });

  it("does not enable short or locally ambiguous alias-only lookups", () => {
    const item = memory(); const doc = document();
    doc.entities[0]!.aliases = ["S", "SharedAlias", "Coordinator"];
    doc.entities[1]!.aliases = ["SharedAlias"];
    accept(item.id, doc);
    expect(knowledgeSnapshot(db, { query: "SharedAlias" }).entities).toEqual([]);
    expect(knowledgeSnapshot(db, { query: "S" }).entities).toEqual([]);
    expect(knowledgeSnapshot(db, { query: "Coordinator" }).entities.length).toBeGreaterThan(0);
    expect(knowledgeSnapshot(db, { query: "Coord" }).entities).toEqual([]);
  });

  it("does not expose imported accepted annotations with fabricated evidence or a changed memory type", () => {
    const item = memory(); const proposal = proposeMemoryKnowledge(db, item.id, document());
    const changed = document(); changed.entities[0]!.evidence = "TeamService never appeared in this fabricated quote.";
    db.prepare("UPDATE memory_knowledge SET status='accepted',document_json=? WHERE id=?")
      .run(JSON.stringify(changed), proposal.id);
    expect(knowledgeSnapshot(db)).toMatchObject({ entities: [], relations: [] });
    expect(listMemoryKnowledge(db, { status: "stale" }).items[0]?.id).toBe(proposal.id);
    db.prepare("UPDATE memory_knowledge SET document_json=? WHERE id=?").run(JSON.stringify(document()), proposal.id);
    db.prepare("UPDATE memories SET type='task-summary' WHERE id=?").run(item.id);
    expect(knowledgeSnapshot(db).entities).toEqual([]);
    expect(listMemoryKnowledge(db, { status: "stale" }).items[0]?.id).toBe(proposal.id);
  });

  it("resolves an entity directly before applying annotation limits", () => {
    const old = memory(); const oldAnnotation = accept(old.id);
    const targetId = knowledgeSnapshot(db, { memoryId: old.id }).entities.find((entity) => entity.name === "SQLite")!.id;
    db.prepare("UPDATE memory_knowledge SET updated_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(oldAnnotation.id);
    for (let i = 0; i < 105; i += 1) {
      const content = `IsolatedSystem${i} owns PrivateCache${i}.`;
      const item = memory(content);
      accept(item.id, {
        entities: [{ key: "system", name: `IsolatedSystem${i}`, type: "service", aliases: [], evidence: content }],
        relations: [],
      });
    }
    expect(knowledgeSnapshot(db, { limit: 1 }).entities.some((entity) => entity.id === targetId)).toBe(false);
    const direct = knowledgeSnapshot(db, { entityId: targetId, limit: 1 });
    expect(direct.entities.some((entity) => entity.id === targetId)).toBe(true);
    expect(direct.bindings.every((binding) => binding.memoryId === old.id)).toBe(true);
    expect(direct.truncated).toBe(false);
    expect(() => knowledgeSnapshot(db, { entityId: "invalid" })).toThrow(/entity/u);
  });
});
