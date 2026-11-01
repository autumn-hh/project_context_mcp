import type { SqliteDatabase } from "../storage/database.js";
import { getMemory, type MemoryRecord } from "./memory-service.js";
import type { TaskRecord } from "../tasks/task-service.js";
import { taskTokens } from "../shared/task-relevance.js";
import { ProjectContextError } from "../shared/errors.js";
import { sha256 } from "../shared/ids.js";
import { findContentRelations } from "./content-relations.js";
import { ENTITY_GRAPH_RELATIONS, entityDetails, knowledgeEntityGraph, type KnowledgeGraphEntity } from "./knowledge-graph.js";
import { memoryKnowledgeHash } from "./knowledge-service.js";

export const MEMORY_GRAPH_RELATIONS = ["SOURCED_FROM", "SUPERSEDES", "PRODUCED_BY", "APPLIES_TO", "CONTENT_RELATED", ...ENTITY_GRAPH_RELATIONS] as const;
export type MemoryGraphRelation = typeof MEMORY_GRAPH_RELATIONS[number];

export interface MemoryGraphOptions {
  view?: "knowledge" | "evidence" | "entities" | undefined;
  includeSummaries?: boolean | undefined;
  query?: string | undefined;
  nodeId?: string | undefined;
  depth?: number | undefined;
  limit?: number | undefined;
  includeInactive?: boolean | undefined;
  relationTypes?: MemoryGraphRelation[] | undefined;
}

export interface MemoryGraphNodeRecord {
  id: string;
  label: string;
  nodeType: "memory" | "task" | "source" | "scope" | "entity";
  memoryType?: MemoryRecord["type"];
  status?: string;
  sourceKind?: string;
  sourceRef?: string | null;
  missing?: boolean;
  summary?: string;
}

export interface MemoryGraphEdge {
  id: string;
  source: string;
  target: string;
  relationType: MemoryGraphRelation;
  evidence: string;
  sharedTerms?: string[];
  excerpts?: { source: string; target: string };
  annotationId?: string;
  memoryId?: string;
}

export interface MemoryGraph {
  view: "knowledge" | "evidence" | "entities";
  nodes: MemoryGraphNodeRecord[];
  edges: MemoryGraphEdge[];
  root: string | null;
  truncated: boolean;
  counts: { nodes: number; edges: number };
  totals: { memories: number };
}

export interface MemoryGraphNodeDetails extends MemoryGraphNodeRecord {
  memory?: MemoryRecord;
  task?: TaskRecord;
  source?: SourceEvidence;
  scope?: string;
  entity?: KnowledgeGraphEntity;
  memoryHash?: string;
  truncated: boolean;
}

export interface SourceEvidence {
  sourceKind: string;
  sourceRef: string | null;
  sourceId: string | null;
  sourceHash: string | null;
  startLine: number | null;
  endLine: number | null;
  gitCommit: string | null;
  excerpt: string | null;
  excerptHash: string | null;
  missing: boolean;
  bindings?: Array<{
    memoryId: string;
    startLine: number | null;
    endLine: number | null;
    sourceExcerpt: string | null;
    sourceHash: string | null;
    sourceExcerptHash: string | null;
    gitCommit: string | null;
    missing: boolean;
  }>;
}

export interface GraphMemoryRecall {
  memory: MemoryRecord;
  fromMemoryId: string;
  viaNodeId: string;
  relation: "same-source" | "same-task" | "supersedes";
}

interface BindingRow {
  id: string; memory_id: string; source_kind: string; source_ref: string | null;
  source_id: string | null; source_hash: string | null; start_line: number | null;
  end_line: number | null; git_commit: string | null;
  source_excerpt: string | null; source_excerpt_hash: string | null;
  present: number;
  current_hash: string | null;
}
interface Connection { node: MemoryGraphNodeRecord; edge: MemoryGraphEdge }
type SourceKey = [string, string | null, string | null];
const MAX_EDGES = 450;
const MAX_BINDINGS = 24;
const NEIGHBOR_LIMIT = 150;
const ACTIVE = "m.status = 'active'";
const HISTORY = "m.status IN ('active', 'stale', 'conflicted', 'superseded')";
const BINDING_COLUMNS = `ms.id, ms.memory_id, ms.source_kind, ms.source_ref, ms.source_id,
  ms.source_hash, ms.start_line, ms.end_line, ms.git_commit,
  substr(ms.source_excerpt, 1, 8001) AS source_excerpt, ms.source_excerpt_hash,
  CASE WHEN EXISTS (SELECT 1 FROM sources s WHERE s.id = ms.source_id) THEN 1 ELSE 0 END AS present,
  (SELECT s.content_hash FROM sources s WHERE s.id = ms.source_id) AS current_hash`;

/** A derived, read-only graph. Lexical suggestions are distinct from recorded evidence. */
export function memoryGraph(db: SqliteDatabase, options: MemoryGraphOptions = {}): MemoryGraph {
  const view = options.view ?? "knowledge";
  if (view !== "knowledge" && view !== "evidence" && view !== "entities") invalid("Unknown graph view.");
  const includeSummaries = view === "evidence" && (options.includeSummaries ?? false);
  const limit = integerOption(options.limit, 24, 1, 150);
  const depth = integerOption(options.depth, 1, 1, 2);
  if (options.query !== undefined && options.query.length > 200) invalid("Query must not exceed 200 characters.");
  if (view === "entities") return knowledgeEntityGraph(db, { ...options, limit, depth });
  const includeInactive = options.includeInactive ?? false;
  const viewRelations: MemoryGraphRelation[] = view === "knowledge" ? ["CONTENT_RELATED", "SUPERSEDES"]
    : ["SOURCED_FROM", "SUPERSEDES", "PRODUCED_BY", "APPLIES_TO"];
  const allowed = new Set(options.relationTypes ?? viewRelations);
  if ([...allowed].some((type) => !MEMORY_GRAPH_RELATIONS.includes(type))) invalid("Unknown relation type.");
  if ([...allowed].some((type) => !viewRelations.includes(type))) invalid("Relation type is unavailable in this graph view.");
  if (options.query !== undefined && options.query.length > 200) invalid("Query must not exceed 200 characters.");
  const nodes = new Map<string, MemoryGraphNodeRecord>();
  const edges = new Map<string, MemoryGraphEdge>();
  const contentDegree = new Map<string, number>();
  const total = db.prepare(`SELECT COUNT(*) AS count FROM memories m WHERE ${includeInactive ? HISTORY : ACTIVE}
    ${includeSummaries ? "" : "AND m.type <> 'task-summary'"}`).get() as { count: number };
  let truncated = false;
  const addNode = (node: MemoryGraphNodeRecord): boolean => {
    if (!includeSummaries && node.memoryType === "task-summary") return false;
    if (node.id.length > 8192) { truncated = true; return false; }
    if (nodes.has(node.id)) return true;
    if (nodes.size >= limit) { truncated = true; return false; }
    nodes.set(node.id, node);
    return true;
  };
  let roots: MemoryGraphNodeRecord[];
  if (options.nodeId) {
    const root = loadNode(db, options.nodeId, includeInactive, includeSummaries);
    if (view === "knowledge" && root.nodeType !== "memory") invalid("Choose evidence view for a provenance node.");
    if (!includeSummaries && root.memoryType === "task-summary") invalid("Task summaries are excluded from this view.");
    roots = [root];
  }
  else {
    const selected = seedNodes(db, options.query?.trim() ?? "", Math.min(12, limit), includeInactive, includeSummaries, view === "evidence");
    roots = selected.nodes;
    truncated = selected.truncated;
  }
  for (const root of roots) addNode(root);
  let frontier = [...nodes.keys()];
  const visited = new Set<string>();
  for (let hop = 0; hop < depth && frontier.length; hop += 1) {
    const next = new Set<string>();
    const reverse = incomingSupersedes(db, allowed.has("SUPERSEDES")
      ? frontier.filter((id) => id.startsWith("memory:")).map((id) => id.slice(7)) : [],
    includeInactive, MAX_EDGES, !includeSummaries);
    truncated ||= reverse.truncated;
    for (const id of frontier) {
      if (visited.has(id)) continue;
      visited.add(id);
      const adjacent = connections(db, nodes.get(id)!, includeInactive, allowed, reverse.byTarget, includeSummaries);
      truncated ||= adjacent.truncated;
      for (const { node, edge } of adjacent.items) {
        if (edges.has(edge.id)) continue;
        if (edges.size >= MAX_EDGES) { truncated = true; continue; }
        if (!addNode(node)) continue;
        edges.set(edge.id, edge);
        next.add(node.id);
      }
    }
    if (allowed.has("CONTENT_RELATED")) {
      const candidates = findContentRelations(db, frontier.filter((id) => id.startsWith("memory:")).map((id) => id.slice(7)), {
        limit: 24, perSeed: 2, includeInactive,
      });
      truncated ||= candidates.truncated;
      for (const relation of candidates.relations) {
        const source = `memory:${relation.sourceMemoryId}`;
        const target = `memory:${relation.targetMemoryId}`;
        const id = `content:${sha256(JSON.stringify([source, target].sort()))}`;
        if (edges.has(id)) continue;
        if ((contentDegree.get(source) ?? 0) >= 2 || (contentDegree.get(target) ?? 0) >= 2) {
          truncated = true;
          continue;
        }
        // Respect explicit supersession rather than attaching a second possible link.
        if ([...edges.values()].some((edge) => edge.relationType === "SUPERSEDES"
          && ((edge.source === source && edge.target === target) || (edge.source === target && edge.target === source)))) continue;
        if (edges.size >= MAX_EDGES) { truncated = true; break; }
        const missing = Number(!nodes.has(source)) + Number(!nodes.has(target));
        if (nodes.size + missing > limit) { truncated = true; continue; }
        if (!addNode(memoryNode(getMemory(db, relation.sourceMemoryId)))
          || !addNode(memoryNode(getMemory(db, relation.targetMemoryId)))) continue;
        edges.set(id, {
          id, source, target, relationType: "CONTENT_RELATED",
          evidence: "Possible topical relation based on shared text; not a dependency, support, causality or agreement.",
          sharedTerms: relation.sharedTerms, excerpts: relation.excerpts,
        });
        contentDegree.set(source, (contentDegree.get(source) ?? 0) + 1);
        contentDegree.set(target, (contentDegree.get(target) ?? 0) + 1);
        next.add(source); next.add(target);
      }
    }
    frontier = [...next].filter((id) => !visited.has(id));
  }
  return {
    view, nodes: [...nodes.values()], edges: [...edges.values()], root: options.nodeId ?? null, truncated,
    counts: { nodes: nodes.size, edges: edges.size },
    totals: { memories: total.count },
  };
}

export function memoryGraphNode(
  db: SqliteDatabase, nodeId: string, options: { includeInactive?: boolean; includeSummaries?: boolean } = {},
): MemoryGraphNodeDetails {
  if (nodeId.startsWith("entity:")) return entityDetails(db, nodeId);
  const node = loadNode(db, nodeId, options.includeInactive ?? false, options.includeSummaries ?? false);
  if (node.nodeType === "memory") {
    const original = getMemory(db, nodeId.slice(7));
    const memory: MemoryRecord = {
      ...original, title: clipped(original.title, 8000), content: clipped(original.content, 8000),
      reason: original.reason === null ? null : clipped(original.reason, 3000),
      scope: original.scope.slice(0, 24).map((value) => clipped(value, 1000)),
      sourceKind: clipped(original.sourceKind, 1000),
      sourceRef: original.sourceRef === null ? null : clipped(original.sourceRef, 8000),
    };
    return { ...node, memory, memoryHash: memoryKnowledgeHash(original), truncated: JSON.stringify(memory) !== JSON.stringify(original) };
  }
  if (node.nodeType === "task") {
    const id = nodeId.slice(5);
    const row = db.prepare(`SELECT id, substr(goal,1,8001) AS goal, status, created_at, updated_at, completed_at,
      substr(json_extract(checkpoint_json,'$.summary'),1,2001) AS summary FROM tasks WHERE id=?`).get(id) as {
        id: string; goal: string; status: TaskRecord["status"]; created_at: string; updated_at: string;
        completed_at: string | null; summary: string | null;
      };
    let truncated = row.goal.length > 8000 || (row.summary?.length ?? 0) > 2000;
    const entries = (field: string): string[] => {
      const values = db.prepare(`SELECT substr(value,1,1001) AS value FROM tasks,
        json_each(tasks.checkpoint_json, ?) WHERE tasks.id=? ORDER BY CAST(key AS INTEGER) LIMIT 11`)
        .all(`$.${field}`, id) as Array<{ value: string }>;
      truncated ||= values.length > 10 || values.some(({ value }) => value.length > 1000);
      return values.slice(0, 10).map(({ value }) => clipped(value, 1000));
    };
    const verification = db.prepare(`SELECT substr(value,1,3001) AS value FROM tasks,
      json_each(tasks.checkpoint_json,'$.verification') WHERE tasks.id=? ORDER BY CAST(key AS INTEGER) LIMIT 11`)
      .all(id) as Array<{ value: string }>;
    truncated ||= verification.length > 10 || verification.some(({ value }) => value.length > 3000);
    const task: TaskRecord = {
      id, goal: clipped(row.goal, 8000), status: row.status,
      checkpoint: {
        ...(row.summary ? { summary: clipped(row.summary, 2000) } : {}),
        completed: entries("completed"), next: entries("next"), changedFiles: entries("changedFiles"),
        blockers: entries("blockers"), risks: entries("risks"),
        verification: verification.slice(0, 10).map(({ value }) => {
          if (value.length > 3000) return { command: "Details omitted", status: "truncated" };
          const entry = JSON.parse(value) as { command: string; status: string; summary?: string };
          return entry;
        }),
      },
      createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at,
    };
    return { ...node, task, truncated };
  }
  if (node.nodeType === "scope") return { ...node, scope: decodeScope(nodeId), truncated: false };
  const key = decodeSource(nodeId);
  const binding = sourceBinding(db, key, options.includeInactive ?? false, options.includeSummaries ?? false)!;
  const source = sourceEvidence(db, binding);
  const [kind, ref, bindingId] = key;
  const bindings = db.prepare(`SELECT ${BINDING_COLUMNS} FROM memory_sources ms JOIN memories m ON m.id=ms.memory_id
    WHERE ${options.includeInactive ? HISTORY : ACTIVE} AND ms.source_kind=? AND ms.source_ref IS ?
      ${options.includeSummaries ? "" : "AND m.type <> 'task-summary'"}
      AND (? IS NULL OR ms.id=?) ORDER BY ms.created_at DESC,ms.id LIMIT 17`)
    .all(kind, ref, bindingId, bindingId) as BindingRow[];
  source.bindings = bindings.slice(0, 16).map((row) => ({
    memoryId: row.memory_id, startLine: row.start_line, endLine: row.end_line,
    sourceExcerpt: row.source_excerpt === null ? null : clipped(row.source_excerpt, 2000),
    sourceHash: row.source_hash, sourceExcerptHash: row.source_excerpt_hash,
    gitCommit: row.git_commit, missing: sourceNode(db, row).missing ?? false,
  }));
  return {
    ...node, source, truncated: bindings.length > 16 || bindings.some((row) => (row.source_excerpt?.length ?? 0) > 2000)
      || (binding.source_excerpt?.length ?? 0) > 8000,
  };
}

/** At most four explainable 2-hop suggestions; callers still apply task scope checks. */
export function relatedGraphMemories(
  db: SqliteDatabase, seedIds: string[], limit = 4, accepts?: (memory: MemoryRecord) => boolean,
): GraphMemoryRecall[] {
  const take = integerOption(limit, 4, 0, 4);
  if (!take) return [];
  const seen = new Set(seedIds);
  const seeds = [...new Set(seedIds)].slice(0, 5);
  const reverse = incomingSupersedes(db, seeds, false, 80, true).byTarget;
  const taskPeers = new Map<string, Array<{ id: string }>>();
  const peersForTask = (id: string): Array<{ id: string }> => {
    let peers = taskPeers.get(id);
    if (!peers) {
      peers = memoryIdsForTask(db, id, false, 17, true).slice(0, 16);
      taskPeers.set(id, peers);
    }
    return peers;
  };
  const result: GraphMemoryRecall[] = [];
  const append = (id: string, fromMemoryId: string, viaNodeId: string, relation: GraphMemoryRecall["relation"]): void => {
    if (seen.has(id) || result.length >= take || viaNodeId.length > 8192) return;
    const row = db.prepare("SELECT id FROM memories WHERE id=? AND status='active' AND type<>'task-summary'").get(id);
    if (!row) return;
    const memory = getMemory(db, id);
    if (accepts && !accepts(memory)) return;
    seen.add(id);
    result.push({ memory, fromMemoryId, viaNodeId, relation });
  };
  for (const seedId of seeds) {
    if (result.length >= take) break;
    const row = db.prepare("SELECT id FROM memories WHERE id=? AND status='active' AND type<>'task-summary'").get(seedId);
    if (!row) continue;
    const seed = getMemory(db, seedId);
    if (seed.supersedesId) append(seed.supersedesId, seedId, `memory:${seedId}`, "supersedes");
    for (const { id } of (reverse.get(seedId) ?? []).slice(0, 16)) {
      append(id, seedId, `memory:${seedId}`, "supersedes");
    }
    for (const binding of bindingsForMemory(db, seedId).slice(0, MAX_BINDINGS)) {
      if (result.length >= take) break;
      if (!binding.source_ref) continue; // Shared sourceKind alone is not evidence of a relationship.
      const taskId = existingTaskRef(db, binding.source_ref);
      if (taskId) {
        for (const { id } of peersForTask(taskId)) {
          append(id, seedId, `task:${taskId}`, "same-task");
        }
        continue;
      }
      if (binding.source_ref.startsWith("task:")) continue;
      // File provenance must still bind to an indexed source. Exact reference,
      // line range and excerpt fingerprint avoid joining unrelated paragraphs.
      if (binding.source_kind === "file" && (!binding.present || binding.source_hash !== binding.current_hash)) continue;
      const viaNodeId = sourceNodeId(binding);
      if (viaNodeId.length > 8192) continue;
      const peers = db.prepare(`SELECT DISTINCT m.id FROM memory_sources ms
        ${binding.source_kind === "file" ? "INDEXED BY memory_sources_source_idx" : ""}
        CROSS JOIN memories m ON m.id=ms.memory_id
        WHERE ${ACTIVE} AND m.type<>'task-summary' AND ms.source_kind=? AND ms.source_ref=?
          ${binding.source_kind === "file" ? "AND ms.source_id=?" : ""}
          AND ms.start_line IS ? AND ms.end_line IS ? AND ms.source_excerpt_hash IS ?
          AND (ms.source_kind<>'file' OR EXISTS(SELECT 1 FROM sources s
            WHERE s.id=ms.source_id AND s.content_hash=ms.source_hash))
        ORDER BY m.updated_at DESC,m.id LIMIT 17`).all(
          binding.source_kind, binding.source_ref, ...(binding.source_kind === "file" ? [binding.source_id] : []),
          binding.start_line, binding.end_line, binding.source_excerpt_hash,
        ) as Array<{ id: string }>;
      for (const { id } of peers.slice(0, 16)) append(id, seedId, viaNodeId, "same-source");
    }
    const taskId = existingTaskRef(db, seed.sourceRef);
    if (taskId) for (const { id } of peersForTask(taskId)) {
      append(id, seedId, `task:${taskId}`, "same-task");
    }
  }
  return result;
}

function seedNodes(db: SqliteDatabase, query: string, limit: number, inactive: boolean, summaries: boolean, evidence: boolean): {
  nodes: MemoryGraphNodeRecord[]; truncated: boolean;
} {
  const status = `${inactive ? HISTORY : ACTIVE} ${summaries ? "" : "AND m.type <> 'task-summary'"}`;
  if (!query) {
    const rows = db.prepare(`SELECT m.id FROM memories m WHERE ${status} ORDER BY m.updated_at DESC,m.id LIMIT ?`)
      .all(limit + 1) as Array<{ id: string }>;
    return { nodes: rows.slice(0, limit).map(({ id }) => memoryNode(getMemory(db, id))), truncated: rows.length > limit };
  }
  const terms = taskTokens(query).slice(0, 32);
  const ids = new Set<string>();
  let capped = false;
  if (terms.length) {
    const exact = db.prepare(`SELECT m.id FROM memories_fts f JOIN memories m ON m.id=f.memory_id
      WHERE memories_fts MATCH ? AND ${status}
      ORDER BY bm25(memories_fts,0,2,1,0.5),m.id LIMIT ?`)
      .all(terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR "), limit + 1) as Array<{ id: string }>;
    exact.forEach(({ id }) => ids.add(id));
    capped ||= exact.length > limit;
    const han = terms.filter((term) => /^\p{Script=Han}{2}$/u.test(term));
    if (han.length) {
      const partial = db.prepare(`SELECT m.id FROM search_ngrams n JOIN memories m ON m.id=n.item_id
        WHERE n.item_kind='memory' AND n.term IN (${han.map(() => "?").join(",")}) AND ${status}
        GROUP BY m.id ORDER BY COUNT(*) DESC,m.id LIMIT ?`).all(...han, limit + 1) as Array<{ id: string }>;
      partial.forEach(({ id }) => ids.add(id));
      capped ||= partial.length > limit;
    }
  }
  const normalized = query.normalize("NFKC").toLowerCase();
  const metadata = evidence ? db.prepare(`SELECT m.id FROM memories m WHERE ${status} AND
    (instr(lower(m.source_ref),?)>0 OR EXISTS(SELECT 1 FROM json_each(m.scope_json) WHERE instr(lower(value),?)>0))
    ORDER BY m.updated_at DESC,m.id LIMIT ?`).all(normalized, normalized, limit + 1) as Array<{ id: string }> : [];
  metadata.forEach(({ id }) => ids.add(id));
  const memories = [...ids].slice(0, limit).map((id) => memoryNode(getMemory(db, id)));
  const tasks = evidence ? db.prepare("SELECT id,substr(goal,1,241) AS goal,status FROM tasks WHERE instr(lower(goal),?)>0 ORDER BY updated_at DESC,id LIMIT ?")
    .all(normalized, limit + 1) as Array<{ id: string; goal: string; status: string }> : [];
  const nodes = [...memories, ...tasks.map((task): MemoryGraphNodeRecord => ({
    id: `task:${task.id}`, label: clipped(task.goal, 240), nodeType: "task", status: task.status,
  }))];
  return { nodes: nodes.slice(0, limit), truncated: capped || ids.size > limit || nodes.length > limit || metadata.length > limit };
}

function connections(
  db: SqliteDatabase, node: MemoryGraphNodeRecord, inactive: boolean, allowed: Set<MemoryGraphRelation>,
  reverse: Map<string, Array<{ id: string }>>,
  summaries: boolean,
): { items: Connection[]; truncated: boolean } {
  const items: Connection[] = [];
  let truncated = false;
  const add = (other: MemoryGraphNodeRecord, relation: MemoryGraphRelation, evidence: string, reverse = false): void => {
    if (!allowed.has(relation) || (!summaries && other.memoryType === "task-summary")) return;
    const source = reverse ? other.id : node.id;
    const target = reverse ? node.id : other.id;
    items.push({ node: other, edge: {
      id: `edge:${sha256(JSON.stringify([source, target, relation]))}`,
      source, target, relationType: relation, evidence: clipped(evidence, 1000),
    } });
  };
  if (node.nodeType === "memory") {
    const memory = getMemory(db, node.id.slice(7));
    const bindings = bindingsForMemory(db, memory.id);
    if (allowed.has("SOURCED_FROM") || allowed.has("PRODUCED_BY")) truncated ||= bindings.length > MAX_BINDINGS;
    const taskIds = new Set<string>();
    const directTask = existingTaskRef(db, memory.sourceRef);
    if (directTask) taskIds.add(directTask);
    for (const binding of bindings.slice(0, MAX_BINDINGS)) {
      const taskId = existingTaskRef(db, binding.source_ref);
      if (taskId) taskIds.add(taskId);
      else add(sourceNode(db, binding), "SOURCED_FROM", `memory_sources:${binding.id}; ${binding.source_ref ?? binding.source_kind}`);
    }
    for (const taskId of taskIds) add(loadNode(db, `task:${taskId}`, inactive), "PRODUCED_BY", `source_ref=task:${taskId}`);
    if (allowed.has("SUPERSEDES")) {
      if (memory.supersedesId && visibleMemory(db, memory.supersedesId, inactive)) {
        add(memoryNode(getMemory(db, memory.supersedesId)), "SUPERSEDES", `memories.supersedes_id=${memory.supersedesId}`);
      }
      const newer = reverse.get(memory.id) ?? [];
      truncated ||= newer.length > NEIGHBOR_LIMIT;
      for (const { id } of newer.slice(0, NEIGHBOR_LIMIT)) add(memoryNode(getMemory(db, id)), "SUPERSEDES", `memories.supersedes_id=${memory.id}`, true);
    }
    if (allowed.has("APPLIES_TO")) {
      const scopes = [...new Set(memory.scope)];
      truncated ||= scopes.length > MAX_BINDINGS;
      for (const scope of scopes.slice(0, MAX_BINDINGS)) if (scope.trim()) {
        add({ id: scopeNodeId(scope), label: clipped(scope, 240), nodeType: "scope" }, "APPLIES_TO", "Explicit memory.scope");
      }
    }
  } else {
    let peers: Array<{ id: string }> = [];
    let relation: MemoryGraphRelation;
    if (node.nodeType === "task") {
      relation = "PRODUCED_BY";
      if (allowed.has(relation)) peers = memoryIdsForTask(db, node.id.slice(5), inactive, NEIGHBOR_LIMIT + 1, !summaries);
    } else if (node.nodeType === "scope") {
      relation = "APPLIES_TO";
      if (allowed.has(relation)) peers = db.prepare(`SELECT m.id FROM memories m WHERE ${inactive ? HISTORY : ACTIVE}
        ${summaries ? "" : "AND m.type <> 'task-summary'"}
        AND EXISTS(SELECT 1 FROM json_each(m.scope_json) WHERE value=?) ORDER BY m.updated_at DESC,m.id LIMIT ?`)
        .all(decodeScope(node.id), NEIGHBOR_LIMIT + 1) as Array<{ id: string }>;
    } else {
      relation = "SOURCED_FROM";
      if (allowed.has(relation)) {
        const [kind, ref, bindingId] = decodeSource(node.id);
        peers = db.prepare(`SELECT DISTINCT m.id FROM memory_sources ms CROSS JOIN memories m ON m.id=ms.memory_id
          WHERE ${inactive ? HISTORY : ACTIVE} AND ms.source_kind=? AND ms.source_ref IS ?
          ${summaries ? "" : "AND m.type <> 'task-summary'"}
          AND (? IS NULL OR ms.id=?) ORDER BY m.updated_at DESC,m.id LIMIT ?`)
          .all(kind, ref, bindingId, bindingId, NEIGHBOR_LIMIT + 1) as Array<{ id: string }>;
      }
    }
    truncated ||= peers.length > NEIGHBOR_LIMIT;
    for (const { id } of peers.slice(0, NEIGHBOR_LIMIT)) {
      add(memoryNode(getMemory(db, id)), relation, `Explicit ${relation === "APPLIES_TO" ? "memory.scope" : "memory provenance"}`, true);
    }
  }
  return { items, truncated };
}

function loadNode(db: SqliteDatabase, nodeId: string, inactive: boolean, summaries = false): MemoryGraphNodeRecord {
  if (!nodeId || nodeId.length > 8192) invalid("Invalid node ID.");
  if (nodeId.startsWith("memory:")) {
    const id = nodeId.slice(7);
    if (visibleMemory(db, id, inactive)) {
      const memory = getMemory(db, id);
      if (summaries || memory.type !== "task-summary") return memoryNode(memory);
    }
  } else if (nodeId.startsWith("task:")) {
    const row = db.prepare("SELECT substr(goal,1,241) AS goal,status FROM tasks WHERE id=?").get(nodeId.slice(5)) as
      { goal: string; status: string } | undefined;
    if (row) return { id: nodeId, label: clipped(row.goal, 240), nodeType: "task", status: row.status };
  } else if (nodeId.startsWith("source:")) {
    const binding = sourceBinding(db, decodeSource(nodeId), inactive, summaries);
    if (binding) return sourceNode(db, binding);
  } else if (nodeId.startsWith("scope:")) {
    const scope = decodeScope(nodeId);
    const row = db.prepare(`SELECT m.id FROM memories m WHERE ${inactive ? HISTORY : ACTIVE}
      ${summaries ? "" : "AND m.type <> 'task-summary'"}
      AND EXISTS(SELECT 1 FROM json_each(m.scope_json) WHERE value=?) LIMIT 1`).get(scope);
    if (row) return { id: nodeId, label: clipped(scope, 240), nodeType: "scope" };
  } else invalid("Unknown memory graph node type.");
  throw new ProjectContextError("MEMORY_GRAPH_NODE_NOT_FOUND", "Memory graph node is unavailable in this project or lifecycle filter.");
}

function memoryNode(memory: MemoryRecord): MemoryGraphNodeRecord {
  return {
    id: `memory:${memory.id}`, label: clipped(memory.title, 240), nodeType: "memory",
    memoryType: memory.type, status: memory.status, summary: clipped(memory.content, 240),
  };
}

function visibleMemory(db: SqliteDatabase, id: string, inactive: boolean): boolean {
  return Boolean(db.prepare(`SELECT id FROM memories m WHERE m.id=? AND ${inactive ? HISTORY : ACTIVE}`).get(id));
}

function bindingsForMemory(db: SqliteDatabase, id: string): BindingRow[] {
  return db.prepare(`SELECT ${BINDING_COLUMNS} FROM memory_sources ms WHERE ms.memory_id=? ORDER BY ms.id LIMIT ?`)
    .all(id, MAX_BINDINGS + 1) as BindingRow[];
}

function sourceBinding(db: SqliteDatabase, key: SourceKey, inactive: boolean, summaries: boolean): BindingRow | undefined {
  const [kind, ref, bindingId] = key;
  return db.prepare(`SELECT ${BINDING_COLUMNS} FROM memory_sources ms CROSS JOIN memories m ON m.id=ms.memory_id
    WHERE ${inactive ? HISTORY : ACTIVE} AND ms.source_kind=? AND ms.source_ref IS ?
      ${summaries ? "" : "AND m.type <> 'task-summary'"}
      AND (? IS NULL OR ms.id=?) ORDER BY ms.created_at DESC,ms.id LIMIT 1`)
    .get(kind, ref, bindingId, bindingId) as BindingRow | undefined;
}

function sourceNode(db: SqliteDatabase, binding: BindingRow): MemoryGraphNodeRecord {
  return {
    id: sourceNodeId(binding), label: clipped(binding.source_ref ?? `${binding.source_kind}（未提供引用）`, 240),
    nodeType: "source", sourceKind: clipped(binding.source_kind, 100),
    sourceRef: binding.source_ref === null ? null : clipped(binding.source_ref, 1000),
    missing: binding.source_kind === "file" ? !binding.present
      : Boolean(binding.source_ref?.startsWith("task:") && !existingTaskRef(db, binding.source_ref)),
  };
}

function sourceEvidence(db: SqliteDatabase, binding: BindingRow): SourceEvidence {
  return {
    // The canonical source node ID already bounds the complete kind/ref pair
    // to < 8192 encoded bytes, so details can preserve the exact reference.
    sourceKind: binding.source_kind, sourceRef: binding.source_ref,
    sourceId: binding.source_id, sourceHash: binding.source_hash, startLine: binding.start_line,
    endLine: binding.end_line, gitCommit: binding.git_commit,
    excerpt: binding.source_excerpt === null ? null : clipped(binding.source_excerpt, 8000),
    excerptHash: binding.source_excerpt_hash, missing: sourceNode(db, binding).missing ?? false,
  };
}

function sourceNodeId(binding: BindingRow): string {
  return `source:${Buffer.from(JSON.stringify([
    binding.source_kind, binding.source_ref, binding.source_ref === null ? binding.id : null,
  ])).toString("base64url")}`;
}
function scopeNodeId(scope: string): string { return `scope:${Buffer.from(scope).toString("base64url")}`; }

function decodeSource(id: string): SourceKey {
  try {
    const parsed = JSON.parse(Buffer.from(id.slice(7), "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 3 || typeof parsed[0] !== "string"
      || (parsed[1] !== null && typeof parsed[1] !== "string")
      || (parsed[2] !== null && typeof parsed[2] !== "string")
      || (parsed[1] === null && !parsed[2]) || (parsed[1] !== null && parsed[2] !== null)) invalid("Invalid source node ID.");
    const key = parsed as SourceKey;
    if (id !== `source:${Buffer.from(JSON.stringify(key)).toString("base64url")}`) invalid("Invalid source node encoding.");
    return key;
  } catch { return invalid("Invalid source node ID."); }
}
function decodeScope(id: string): string {
  const value = Buffer.from(id.slice(6), "base64url").toString("utf8");
  if (!value || scopeNodeId(value) !== id) invalid("Invalid scope node ID.");
  return value;
}

function existingTaskRef(db: SqliteDatabase, ref: string | null): string | null {
  const match = /^task:(task_[a-z0-9]+)$/u.exec(ref ?? "");
  if (!match) return null;
  return db.prepare("SELECT id FROM tasks WHERE id=?").get(match[1]!) ? match[1]! : null;
}
function memoryIdsForTask(
  db: SqliteDatabase, id: string, inactive: boolean, limit: number, excludeSummaries = false,
): Array<{ id: string }> {
  const ref = `task:${id}`;
  // Probe the primary provenance index, then union additional source bindings.
  // Avoid a correlated binding lookup for every active memory in the project.
  return db.prepare(`WITH candidates(id) AS MATERIALIZED (
      SELECT id FROM memories INDEXED BY memories_source_ref_idx WHERE source_ref=?
      UNION SELECT memory_id FROM memory_sources WHERE source_ref=?
    )
    SELECT m.id FROM candidates c CROSS JOIN memories m ON m.id=c.id
    WHERE ${inactive ? HISTORY : ACTIVE} ${excludeSummaries ? "AND m.type<>'task-summary'" : ""}
    ORDER BY m.updated_at DESC,m.id LIMIT ?`).all(ref, ref, limit) as Array<{ id: string }>;
}

function incomingSupersedes(
  db: SqliteDatabase, ids: string[], inactive: boolean, limit: number, excludeSummaries = false,
): { byTarget: Map<string, Array<{ id: string }>>; truncated: boolean } {
  const byTarget = new Map<string, Array<{ id: string }>>();
  if (!ids.length) return { byTarget, truncated: false };
  // There is no supersedes_id index in the current schema. Scan once per BFS
  // frontier / recall request rather than once for each selected memory.
  const rows = db.prepare(`SELECT m.id,m.supersedes_id FROM memories m
    WHERE m.supersedes_id IN (${ids.map(() => "?").join(",")}) AND ${inactive ? HISTORY : ACTIVE}
      ${excludeSummaries ? "AND m.type<>'task-summary'" : ""}
    ORDER BY m.updated_at DESC,m.id LIMIT ?`).all(...ids, limit + 1) as Array<{ id: string; supersedes_id: string }>;
  for (const row of rows.slice(0, limit)) {
    const entries = byTarget.get(row.supersedes_id) ?? [];
    entries.push({ id: row.id });
    byTarget.set(row.supersedes_id, entries);
  }
  return { byTarget, truncated: rows.length > limit };
}
function clipped(value: string, limit: number): string { return value.length > limit ? `${value.slice(0, limit)}…` : value; }
function integerOption(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) invalid(`Expected an integer from ${minimum} to ${maximum}.`);
  return value;
}
function invalid(message: string): never { throw new ProjectContextError("INVALID_MEMORY_GRAPH", message); }
