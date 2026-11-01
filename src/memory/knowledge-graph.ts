import type { SqliteDatabase } from "../storage/database.js";
import { knowledgeSnapshot, type KnowledgeSnapshot } from "./knowledge-service.js";
import { getMemory } from "./memory-service.js";
import type { MemoryGraph, MemoryGraphOptions, MemoryGraphEdge, MemoryGraphNodeRecord } from "./graph-service.js";
import { ProjectContextError } from "../shared/errors.js";

export const ENTITY_GRAPH_RELATIONS = ["MENTIONS", "USES", "PROVIDES", "STORED_IN", "DEPENDS_ON", "GOVERNED_BY"] as const;
export type KnowledgeGraphEntity = KnowledgeSnapshot["entities"][number];
export function entityNode(entity: KnowledgeGraphEntity): MemoryGraphNodeRecord {
  return { id: `entity:${entity.id}`, label: entity.name, nodeType: "entity", status: "accepted", summary: entity.type };
}
export function entityDetails(db: SqliteDatabase, nodeId: string) {
  if (!/^entity:kent_[a-f0-9]{64}$/u.test(nodeId)) throw new ProjectContextError("INVALID_MEMORY_GRAPH", "Invalid entity node ID.");
  const snapshot = knowledgeSnapshot(db, { entityId: nodeId.slice(7), limit: 100 });
  const entity = snapshot.entities.find((item) => item.id === nodeId.slice(7));
  if (!entity) throw new ProjectContextError("MEMORY_GRAPH_NODE_NOT_FOUND", "Confirmed entity is unavailable in this project.");
  return { ...entityNode(entity), entity, truncated: snapshot.truncated };
}

/** An explicit, opt-in graph of reviewed annotations, bounded independently of the knowledge overview. */
export function knowledgeEntityGraph(db: SqliteDatabase, options: MemoryGraphOptions): MemoryGraph {
  const limit = options.limit ?? 24, depth = options.depth ?? 1;
  const allowed = new Set(options.relationTypes ?? ENTITY_GRAPH_RELATIONS);
  if (options.includeInactive || options.includeSummaries) throw new ProjectContextError("INVALID_MEMORY_GRAPH", "Entity relationships require current non-summary evidence.");
  if ([...allowed].some((type) => !(ENTITY_GRAPH_RELATIONS as readonly string[]).includes(type))) {
    throw new ProjectContextError("INVALID_MEMORY_GRAPH", "Relationship is unavailable in entity view.");
  }
  const root = options.nodeId;
  let snapshot: KnowledgeSnapshot;
  if (root?.startsWith("memory:")) snapshot = knowledgeSnapshot(db, { memoryId: root.slice(7), limit: 100 });
  else if (root?.startsWith("entity:")) {
    entityDetails(db, root); // Validate format and current visibility before expansion.
    snapshot = knowledgeSnapshot(db, { entityId: root.slice(7), limit: 100 });
  } else if (root) throw new ProjectContextError("INVALID_MEMORY_GRAPH", "Entity view accepts memory or entity nodes.");
  else snapshot = knowledgeSnapshot(db, { query: options.query, limit: 100 });
  const candidates = new Map<string, MemoryGraphNodeRecord>(snapshot.entities.map((entity) => [`entity:${entity.id}`, entityNode(entity)]));
  const addMemory = (id: string) => {
    const memory = getMemory(db, id);
    if (memory.status !== "active" || memory.type === "task-summary") throw new ProjectContextError("MEMORY_GRAPH_NODE_NOT_FOUND", "Memory evidence is not active.");
    candidates.set(`memory:${id}`, { id: `memory:${id}`, label: memory.title.slice(0, 240), nodeType: "memory", memoryType: memory.type, status: memory.status });
  };
  for (const binding of snapshot.bindings) addMemory(binding.memoryId);
  if (root?.startsWith("memory:")) addMemory(root.slice(7));
  const allEdges = new Map<string, MemoryGraphEdge>();
  const ingest = (part: KnowledgeSnapshot) => {
    for (const entity of part.entities) candidates.set(`entity:${entity.id}`, entityNode(entity));
    for (const binding of part.bindings) {
      addMemory(binding.memoryId);
      const id = `mention:${binding.annotationId}:${binding.entityId}`;
      allEdges.set(id, { id, source: `memory:${binding.memoryId}`, target: `entity:${binding.entityId}`,
        relationType: "MENTIONS", evidence: binding.quote, annotationId: binding.annotationId, memoryId: binding.memoryId });
    }
    for (const edge of part.relations) allEdges.set(edge.id, {
      id: edge.id, source: `entity:${edge.from}`, target: `entity:${edge.to}`,
      relationType: edge.type.toUpperCase() as MemoryGraphEdge["relationType"], evidence: edge.quote,
      annotationId: edge.annotationId, memoryId: edge.memoryId,
    });
  };
  ingest(snapshot);
  const normalizedQuery = normalize(options.query ?? "");
  const matches = snapshot.entities.filter((entity) => !normalizedQuery || [entity.name, ...entity.aliases].some((name) => normalize(name).includes(normalizedQuery)));
  const seeds = root ? [root] : (matches.length ? matches.map((entity) => `entity:${entity.id}`) : [...candidates.keys()]);
  const nodes = new Map(seeds.slice(0, Math.min(12, limit)).map((id) => [id, candidates.get(id)!]));
  const edges = new Map<string, MemoryGraphEdge>();
  let truncated = snapshot.truncated || seeds.length > nodes.size;
  let frontier = new Set(nodes.keys());
  const loaded = new Set(root ? [root] : []);
  let expansions = 0;
  for (let hop = 0; hop < depth; hop++) {
    // Load each frontier's own annotations; a second hop may cross a different memory.
    for (const id of frontier) {
      if (loaded.has(id) || !allowed.size) continue;
      if (expansions >= 24) { truncated = true; continue; }
      const part = knowledgeSnapshot(db, id.startsWith("entity:")
        ? { entityId: id.slice(7), limit: 100 } : { memoryId: id.slice(7), limit: 100 });
      loaded.add(id); expansions++; truncated ||= part.truncated; ingest(part);
    }
    const next = new Set<string>();
    for (const edge of allEdges.values()) {
      if (!allowed.has(edge.relationType) || edges.has(edge.id) || (!frontier.has(edge.source) && !frontier.has(edge.target))) continue;
      const missing = [edge.source, edge.target].filter((id) => !nodes.has(id));
      if (nodes.size + missing.length > limit || edges.size >= 450) { truncated = true; continue; }
      for (const id of missing) { nodes.set(id, candidates.get(id)!); next.add(id); }
      edges.set(edge.id, edge);
    }
    frontier = next;
  }
  const total = db.prepare("SELECT COUNT(*) AS count FROM memories WHERE status='active' AND type<>'task-summary'").get() as { count: number };
  return { view: "entities", nodes: [...nodes.values()], edges: [...edges.values()], root: root ?? null,
    counts: { nodes: nodes.size, edges: edges.size }, totals: { memories: total.count }, truncated };
}
function normalize(value: string) { return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " "); }
