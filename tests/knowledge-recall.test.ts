import Database from "better-sqlite3";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { migrateProject } from "../src/storage/schema.js";
import { remember, updateMemoryStatus, type MemoryRecord } from "../src/memory/memory-service.js";
import { proposeMemoryKnowledge, reviewMemoryKnowledge } from "../src/memory/knowledge-service.js";
import { recallEntityMemories } from "../src/memory/knowledge-recall.js";
import { buildProjectContext } from "../src/context/context-service.js";
import type { KnowledgeDocument } from "../src/memory/knowledge-schema.js";
import type { ProjectRecord } from "../src/projects/project-service.js";

const project: ProjectRecord = {
  id: "prj_fixture", name: "Entity fixture", rootPath: "/fixture", remoteUrl: null,
  createdAt: "", updatedAt: "", lastOpenedAt: "", archivedAt: null,
};

describe("reviewed entity recall", () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(":memory:"); migrateProject(db); });
  afterEach(() => db.close());
  function annotate(name: string, aliases: string[], options: {
    accept?: boolean; scope?: string[]; suffix?: string; relation?: boolean;
  } = {}) {
    const content = options.relation ? `${name} uses QuartzStore.${options.suffix ?? ""}` : `${name} manages durable records.${options.suffix ?? ""}`;
    const memory = remember(db, { type: "fact", title: "Architecture record", content, sourceKind: "user", scope: options.scope ?? [] });
    const document: KnowledgeDocument = {
      entities: [{ key: "service", name, type: "service", aliases, evidence: content }],
      relations: [],
    };
    if (options.relation) {
      document.entities.push({ key: "store", name: "QuartzStore", type: "storage", aliases: [], evidence: content });
      document.relations.push({ from: "service", to: "store", type: "uses", evidence: content });
    }
    const candidate = proposeMemoryKnowledge(db, memory.id, document);
    const annotation = options.accept === false ? candidate : reviewMemoryKnowledge(db, {
      id: candidate.id, action: "accept", expectedVersion: candidate.version,
    });
    return { memory, annotation };
  }

  it("recalls a memory through an accepted alias absent from its literal title and body", () => {
    const { memory, annotation } = annotate("OrionCoordinator", ["星河协调中心"], { relation: true });
    const result = recallEntityMemories(db, "检查星河协调中心", () => true);
    expect(result.items.map((entry) => entry.memory.id)).toEqual([memory.id]);
    expect(result.items[0]!.evidence).toMatchObject({
      name: "OrionCoordinator", matchedName: "星河协调中心", annotationId: annotation.id, quote: memory.content,
    });
    expect(result.items[0]!.evidence.relations).toEqual([expect.objectContaining({
      from: "OrionCoordinator", to: "QuartzStore", type: "uses", quote: memory.content, annotationId: annotation.id,
    })]);
  });

  it("does not recall proposed or rejected aliases and removes accepted aliases on revocation", () => {
    const pending = annotate("PendingCoordinator", ["UnseenAlias"], { accept: false });
    expect(recallEntityMemories(db, "UnseenAlias", () => true).items).toEqual([]);
    const accepted = reviewMemoryKnowledge(db, { id: pending.annotation.id, action: "accept", expectedVersion: 1 });
    expect(recallEntityMemories(db, "UnseenAlias", () => true).items).toHaveLength(1);
    reviewMemoryKnowledge(db, { id: accepted.id, action: "reject", expectedVersion: accepted.version });
    expect(recallEntityMemories(db, "UnseenAlias", () => true).items).toEqual([]);
  });

  it('uses reviewed application identity without granting unrelated or file scopes',()=>{
    const good=annotate('OrionCoordinator',['星河协调中心'],{scope:['external-local-app:OrionCoordinator-2.0']});
    const wrong=annotate('OrionCoordinator',['星河协调中心'],{scope:['external-local-app:OtherApplication'],suffix:' unrelated scope'});
    const pending=annotate('PendingCoordinator',['待审协调中心'],{scope:['external-local-app:PendingCoordinator'],accept:false});
    const context=JSON.stringify(buildProjectContext(db,project,'星河协调中心的最终结论'));
    expect(context).toContain(good.memory.id);expect(context).not.toContain(wrong.memory.id);
    expect(JSON.stringify(buildProjectContext(db,project,'待审协调中心的最终结论'))).not.toContain(pending.memory.id);
    expect(JSON.stringify(buildProjectContext(db,project,'星河协调中心 src/auth.ts'))).not.toContain(good.memory.id);
    reviewMemoryKnowledge(db,{id:good.annotation.id,action:'reject',expectedVersion:good.annotation.version});
    expect(JSON.stringify(buildProjectContext(db,project,'星河协调中心的最终结论'))).not.toContain(good.memory.id);
  });

  it("invalidates alias recall when the source changes or becomes inactive", () => {
    const first = annotate("OldCoordinator", ["FirstAlias"]);
    db.prepare("UPDATE memories SET content='A new conclusion.' WHERE id=?").run(first.memory.id);
    expect(recallEntityMemories(db, "FirstAlias", () => true).items).toEqual([]);
    const second = annotate("LiveCoordinator", ["SecondAlias"]);
    updateMemoryStatus(db, second.memory.id, "stale");
    expect(recallEntityMemories(db, "SecondAlias", () => true).items).toEqual([]);
  });

  it("refuses an alias owned by different confirmed entities across documents", () => {
    annotate("BillingCoordinator", ["SharedAlias"]);
    annotate("MediaCoordinator", ["SharedAlias"]);
    expect(recallEntityMemories(db, "SharedAlias", () => true).items).toEqual([]);
    expect(recallEntityMemories(db, "BillingCoordinator", () => true).items).toHaveLength(1);
  });

  it("includes locally ambiguous aliases when checking every owner of a matched name", () => {
    const first = annotate("BillingCoordinator", ["SharedAlias"], { relation: true, accept: false });
    const doc = first.annotation.document;
    doc.entities.find((entity) => entity.key === "store")!.aliases.push("SharedAlias");
    const proposal = proposeMemoryKnowledge(db, first.memory.id, doc);
    reviewMemoryKnowledge(db, { id: proposal.id, action: "accept", expectedVersion: proposal.version });
    annotate("MediaCoordinator", ["SharedAlias"]);
    expect(recallEntityMemories(db, "SharedAlias", () => true).items).toEqual([]);
  });

  it("uses normalized complete Latin boundaries and rejects short aliases", () => {
    annotate("QuasarCoordinator", ["Git", "DB", "HubAlias"]);
    expect(recallEntityMemories(db, "digit implementation", () => true).items).toEqual([]);
    expect(recallEntityMemories(db, "check GIT", () => true).items).toHaveLength(1);
    expect(recallEntityMemories(db, "DB", () => true).items).toEqual([]);
    expect(recallEntityMemories(db, "XHubAlias", () => true).items).toEqual([]);
    expect(recallEntityMemories(db, "hubalias", () => true).items).toHaveLength(1);
  });

  it("applies scope acceptance before result quotas and only cites current matching annotation evidence", () => {
    const good = annotate("ScopedCoordinator", ["AsterAlias"], { scope: ["src/auth"], relation: true });
    annotate("ScopedCoordinator", ["AsterAlias"], { scope: ["src/images"], suffix: " Different detail." });
    const result = recallEntityMemories(db, "AsterAlias", (memory) => memory.scope.includes("src/auth"), 1);
    expect(result.items.map((entry) => entry.memory.id)).toEqual([good.memory.id]);
    expect(result.items[0]!.evidence.annotationId).toBe(good.annotation.id);
    expect(result.items[0]!.evidence.quote).toBe(good.memory.content);
    expect(result.items[0]!.evidence.relations.every((edge) => edge.annotationId === good.annotation.id)).toBe(true);
  });

  it("returns no more than four memories and reports omitted matching bindings", () => {
    for (let i = 0; i < 7; i += 1) annotate("SharedCoordinator", ["ZetaAlias"], { suffix: ` Item ${i}.` });
    const result = recallEntityMemories(db, "ZetaAlias", () => true, 4);
    expect(result.items).toHaveLength(4);
    expect(result.truncated).toBe(true);
    expect(new Set(result.items.map((entry) => entry.memory.id)).size).toBe(4);
  });

  it("recalls old matching aliases after more than one hundred unrelated accepted annotations", () => {
    const target = annotate("AncientCoordinator", ["OldButValidAlias"]);
    db.prepare("UPDATE memory_knowledge SET updated_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(target.annotation.id);
    for (let i = 0; i < 105; i += 1) annotate(`UnrelatedSystem${i}`, [`PrivateAlias${i}`]);
    const result = recallEntityMemories(db, "OldButValidAlias", () => true);
    expect(result.items.map((entry) => entry.memory.id)).toEqual([target.memory.id]);
  });

  it("preserves conservative behavior when a queried alias has a truncated owner inventory", () => {
    for (let i = 0; i < 105; i += 1) annotate(`OwnerSystem${i}`, ["CrowdedAlias"]);
    const result = recallEntityMemories(db, "CrowdedAlias", () => true);
    expect(result.items).toEqual([]);
    expect(result.truncated).toBe(true);
  });

  it("integrates reviewed aliases into task context without exposing unreviewed or out-of-scope facts", () => {
    const good = annotate("HeliosCoordinator", ["太阳调度中心"]);
    const pending = annotate("LunarCoordinator", ["月面调度中心"], { accept: false });
    const scoped = annotate("TerraCoordinator", ["地面调度中心"], { scope: ["src/images.ts"] });
    const context = buildProjectContext(db, project, "请检查太阳调度中心", 5000);
    const hit = context.relevant.find((entry) => entry.id === good.memory.id);
    expect(hit?.entityRecall).toMatchObject({ matchedName: "太阳调度中心", annotationId: good.annotation.id });
    expect(context.budget.usedTokens).toBeLessThanOrEqual(5000);
    expect(JSON.stringify(buildProjectContext(db, project, "月面调度中心", 5000))).not.toContain(pending.memory.id);
    expect(JSON.stringify(buildProjectContext(db, project, "地面调度中心 src/auth.ts", 5000))).not.toContain(scoped.memory.id);
  });
});
