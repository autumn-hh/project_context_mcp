import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateProject } from "../src/storage/schema.js";
import { remember, updateMemoryStatus } from "../src/memory/memory-service.js";
import { proposeMemoryKnowledge, reviewMemoryKnowledge } from "../src/memory/knowledge-service.js";
import { memoryGraph, memoryGraphNode } from "../src/memory/graph-service.js";

describe("reviewed entity graph", () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(":memory:"); db.pragma("foreign_keys=ON"); migrateProject(db); });
  afterEach(() => db.close());
  function fixture(name = "TeamService", alias = "知识中心") {
    const quote = `${name} provides SharedMemory.`;
    const memory = remember(db, { type: "fact", title: "Architecture", content: quote, sourceKind: "user" });
    const annotation = proposeMemoryKnowledge(db, memory.id, { entities: [
      { key: "service", name, type: "service", aliases: [alias], evidence: quote },
      { key: "memory", name: "SharedMemory", type: "concept", aliases: [], evidence: quote },
    ], relations: [{ from: "service", to: "memory", type: "provides", evidence: quote }] });
    return { quote, memory, annotation, accept: () => reviewMemoryKnowledge(db, { id: annotation.id, action: "accept", expectedVersion: 1 }) };
  }
  it("keeps pending annotations out of all graphs and shows accepted directed evidence on demand", () => {
    const f = fixture();
    expect(memoryGraph(db, { view: "entities" }).nodes).toEqual([]);
    f.accept();
    expect(memoryGraph(db).nodes.every((n) => n.nodeType === "memory")).toBe(true);
    const graph = memoryGraph(db, { view: "entities", query: "知识中心" });
    expect(graph.nodes.filter(n => n.nodeType === "entity")).toHaveLength(2);
    expect(graph.edges.find(e => e.relationType === "PROVIDES")).toMatchObject({ evidence: f.quote, memoryId: f.memory.id, annotationId: f.annotation.id });
    const entity = graph.nodes.find(n => n.label === "TeamService")!;
    expect(memoryGraphNode(db, entity.id).entity).toMatchObject({ name: "TeamService", aliases: ["知识中心"], memoryIds: [f.memory.id] });
    expect(memoryGraphNode(db, `memory:${f.memory.id}`).memoryHash).toBe(f.annotation.memoryHash);
    expect(memoryGraph(db, { view: "entities", nodeId: entity.id, relationTypes: [] }).edges).toEqual([]);
  });
  it("does not expose expired entity nodes even with history enabled", () => {
    const f = fixture(); f.accept();
    const entity = memoryGraph(db, { view: "entities" }).nodes.find(n => n.nodeType === "entity")!;
    updateMemoryStatus(db, f.memory.id, "stale");
    expect(memoryGraph(db, { view: "entities" }).nodes).toEqual([]);
    expect(() => memoryGraphNode(db, entity.id, { includeInactive: true })).toThrow(/unavailable/);
    expect(() => memoryGraph(db, { view: "entities", nodeId: `memory:${f.memory.id}` })).toThrow(/not active/);
  });
  it("rejects mismatched filters, invalid roots, unknown ids and never returns dangling edges", () => {
    const f = fixture(); f.accept();
    expect(() => memoryGraph(db, { view: "entities", relationTypes: ["CONTENT_RELATED"] })).toThrow();
    expect(() => memoryGraph(db, { view: "knowledge", relationTypes: ["PROVIDES"] })).toThrow();
    expect(() => memoryGraph(db, { view: "entities", includeSummaries: true })).toThrow();
    expect(() => memoryGraph(db, { view: "entities", includeInactive: true })).toThrow();
    expect(() => memoryGraph(db, { view: "entities", nodeId: "scope:bad" })).toThrow();
    expect(() => memoryGraphNode(db, "entity:bad")).toThrow();
    expect(() => memoryGraphNode(db, "entity:kent_" + "a".repeat(64))).toThrow();
    const graph = memoryGraph(db, { view: "entities", limit: 1, depth: 2 });
    expect(graph.nodes).toHaveLength(1); expect(graph.edges).toEqual([]); expect(graph.truncated).toBe(true);
  });
  it("retrieves older entity details beyond the default overview and preserves source quotes", () => {
    const old = fixture("OlderService", "旧知识中心"); old.accept();
    const first = memoryGraph(db, { view: "entities", query: "旧知识中心" }).nodes.find(n => n.label === "OlderService")!;
    for (let i = 0; i < 105; i++) fixture(`NewService${i}`, `新知识中心${i}`).accept();
    const detail = memoryGraphNode(db, first.id);
    expect(detail.entity?.name).toBe("OlderService");
    const graph = memoryGraph(db, { view: "entities", nodeId: first.id });
    expect(graph.edges.find(e => e.relationType === "PROVIDES")?.evidence).toBe(old.quote);
    expect(graph.nodes.length).toBeLessThanOrEqual(24);
  });
  it("follows a second hop across independently reviewed source memories", () => {
    for (const [from, to] of [["AlphaGateway", "BetaGateway"], ["BetaGateway", "GammaGateway"]]) {
      const quote = `${from} uses ${to}.`;
      const memory = remember(db, { type: "fact", title: from!, content: quote, sourceKind: "user" });
      const proposal = proposeMemoryKnowledge(db, memory.id, { entities: [
        { key: "a", name: from, type: "service", evidence: quote }, { key: "b", name: to, type: "service", evidence: quote },
      ], relations: [{ from: "a", to: "b", type: "uses", evidence: quote }] });
      reviewMemoryKnowledge(db, { id: proposal.id, action: "accept", expectedVersion: 1 });
    }
    const root = memoryGraph(db, { view: "entities", query: "AlphaGateway" }).nodes.find(n => n.label === "AlphaGateway")!.id;
    const one = memoryGraph(db, { view: "entities", nodeId: root, depth: 1 });
    expect(one.nodes.some(n => n.label === "GammaGateway")).toBe(false);
    const two = memoryGraph(db, { view: "entities", nodeId: root, depth: 2 });
    expect(two.nodes.some(n => n.label === "GammaGateway")).toBe(true);
    expect(two.edges.filter(e => e.relationType === "USES")).toHaveLength(2);
    expect(two.truncated).toBe(false);
    for (const edge of two.edges) expect(two.nodes.some(n => n.id === edge.source) && two.nodes.some(n => n.id === edge.target)).toBe(true);
  });
});
