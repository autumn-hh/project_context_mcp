import { posix as posixPath } from "node:path";
import type { SqliteDatabase } from "../storage/database.js";
import { matchingNgramItems, type SearchItemKind } from "./ngram-index.js";
import { rrfMerge, type FusedItem } from "./rank-fusion.js";
import { DEFAULT_SEARCH_RANKING, type SearchRankingSettings } from "./search-ranking.js";

export interface SearchHit {
  kind: "chunk" | "memory" | "symbol";
  id: string;
  title: string;
  content: string;
  source: string | null;
  startLine: number | null;
  score: number;
  status: string | null;
}

interface ScoredHit {
  hit: SearchHit;
  score: number;
}

const SYMBOL_FUSION_WEIGHT = 1.25;
const GRAPH_MAX_HOP = 2;
const GRAPH_DECAY = 0.65;
const GRAPH_MIN_SCORE = 0.12;
const GRAPH_MAX_NODES = 200;
const MAX_RELATED_RESULTS = 4;
const GRAPH_RELATION_WEIGHTS: Record<string, number> = {
  CALLS: 1,
  IMPORTS: 0.85,
  EXTENDS: 0.75,
  IMPLEMENTS: 0.75,
};

export function searchProject(
  db: SqliteDatabase,
  query: string,
  limit = 20,
  ranking: SearchRankingSettings = DEFAULT_SEARCH_RANKING,
): SearchHit[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const ftsQuery = toFtsQuery(query);
  if (!ftsQuery) return [];
  const perKind = Math.max(limit * 3, 20);
  const chunks = db.prepare(`
    SELECT c.id, c.source_path, c.content, c.start_line, bm25(chunks_fts, 0, 2, 1) AS rank
    FROM chunks_fts
    JOIN chunks c ON c.id = chunks_fts.chunk_id
    WHERE chunks_fts MATCH ?
    ORDER BY rank, c.id LIMIT ?
  `).all(ftsQuery, perKind) as Array<{
    id: string; source_path: string; content: string; start_line: number; rank: number;
  }>;
  const memories = db.prepare(`
    SELECT m.id, m.title, m.content, m.source_ref, m.status, bm25(memories_fts, 0, 2, 1, 0.5) AS rank
    FROM memories_fts
    JOIN memories m ON m.id = memories_fts.memory_id
    WHERE memories_fts MATCH ? AND m.status = 'active'
    ORDER BY rank, m.id LIMIT ?
  `).all(ftsQuery, perKind) as Array<{
    id: string; title: string; content: string; source_ref: string | null; status: string; rank: number;
  }>;
  const symbols = db.prepare(`
    SELECT s.id, s.name, s.qualified_name, s.kind, s.signature, s.source_path, s.start_line,
           bm25(symbols_fts, 0, 5, 2, 1) AS rank
    FROM symbols_fts
    JOIN symbols s ON s.id = symbols_fts.symbol_id
    WHERE symbols_fts MATCH ?
    ORDER BY rank, s.id LIMIT ?
  `).all(ftsQuery, perKind) as Array<{
    id: string; name: string; qualified_name: string; kind: string; signature: string | null;
    source_path: string; start_line: number; rank: number;
  }>;

  const exact = [
    ...symbols.map((row): SearchHit => ({
      kind: "symbol", id: row.id, title: `${row.kind} ${row.qualified_name}`,
      content: row.signature ?? row.name, source: row.source_path, startLine: row.start_line,
      score: normalizeRank(row.rank) + 0.25, status: null,
    })),
    ...chunks.map((row): SearchHit => ({
      kind: "chunk", id: row.id, title: row.source_path, content: row.content,
      source: row.source_path, startLine: row.start_line, score: normalizeRank(row.rank), status: null,
    })),
    ...memories.map((row): SearchHit => ({
      kind: "memory", id: row.id, title: row.title, content: row.content,
      source: row.source_ref, startLine: null, score: normalizeRank(row.rank), status: row.status,
    })),
  ].sort((a, b) => b.score - a.score);
  const fuzzy = matchingNgramItems(db, query, Math.max(limit * 4, 20))
    .map((item) => ngramHit(db, item.kind, item.id, item.coverage, query))
    .filter((hit): hit is SearchHit => hit !== null);
  const symbolExact = exact.filter((hit) => isExactSymbolMatch(hit, query));
  const fused = rrfMerge(
    [
      { items: exact },
      { items: fuzzy },
      { items: symbolExact, weight: SYMBOL_FUSION_WEIGHT },
    ],
    (hit) => hit.id,
  ).map(({ item, score }) => ({
    item,
    score: score * relevanceWeight(item, ranking),
  })).sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
  const direct = normalizeFusionScores(fused);
  const directIds = new Set(direct.map(({ hit }) => hit.id));
  const related = graphRelatedHits(db, direct.slice(0, 20), ranking)
    .filter(({ hit }) => !directIds.has(hit.id));
  const relatedLimit = Math.min(MAX_RELATED_RESULTS, Math.floor(limit / 4));
  const selectedRelated = related.slice(0, relatedLimit);
  const directLimit = Math.max(0, limit - selectedRelated.length);
  return [
    ...direct.slice(0, directLimit).map(({ hit }) => hit),
    ...selectedRelated.map(({ hit, score }) => ({ ...hit, score })),
  ];
}

function normalizeFusionScores(fused: Array<FusedItem<SearchHit>>): ScoredHit[] {
  const maximum = fused[0]?.score ?? 1;
  return fused.map(({ item, score }) => ({
    hit: { ...item, score: score / maximum },
    score: score / maximum,
  }));
}

function graphRelatedHits(db: SqliteDatabase, seeds: ScoredHit[], ranking: SearchRankingSettings): ScoredHit[] {
  const symbolSeeds = seeds
    .filter(({ hit }) => hit.kind === "symbol")
    .map(({ hit, score }) => ({ id: hit.id, score }))
    .slice(0, 20);
  if (symbolSeeds.length === 0) return [];

  const seedIds = new Set(symbolSeeds.map((seed) => seed.id));
  const best = new Map<string, { score: number; hop: number }>();
  for (const seed of symbolSeeds) best.set(seed.id, { score: seed.score, hop: 0 });

  let frontier = symbolSeeds;
  for (let hop = 1; hop <= GRAPH_MAX_HOP && frontier.length > 0; hop += 1) {
    const rows = graphNeighbors(db, frontier.map((item) => item.id));
    const frontierScores = new Map(frontier.map((item) => [item.id, item.score]));
    const next: Array<{ id: string; score: number }> = [];
    for (const row of rows) {
      if (seedIds.has(row.id)) continue;
      const weight = GRAPH_RELATION_WEIGHTS[row.relationType] ?? 0.5;
      const parentScore = Math.max(frontierScores.get(row.fromId) ?? 0, frontierScores.get(row.toId) ?? 0);
      if (parentScore === 0) continue;
      const score = parentScore * GRAPH_DECAY * weight;
      if (score < GRAPH_MIN_SCORE) continue;
      const previous = best.get(row.id);
      if (previous && previous.score >= score) continue;
      if (!previous && best.size >= GRAPH_MAX_NODES) break;
      best.set(row.id, { score, hop });
      if (best.size < GRAPH_MAX_NODES) next.push({ id: row.id, score });
    }
    frontier = next;
    if (best.size >= GRAPH_MAX_NODES) break;
  }

  return [...best.entries()]
    .filter(([id]) => !seedIds.has(id))
    .map(([id, info]) => ({ hit: ngramHit(db, "symbol", id, 0, ""), score: info.score }))
    .filter((item): item is { hit: SearchHit; score: number } => item.hit !== null)
    .map(({ hit, score }) => {
      const adjustedScore = score * relevanceWeight(hit, ranking);
      return { hit: { ...hit, score: adjustedScore }, score: adjustedScore };
    })
    .sort((a, b) => b.score - a.score || a.hit.id.localeCompare(b.hit.id));
}

interface GraphNeighbor {
  id: string;
  relationType: string;
  fromId: string;
  toId: string;
}

function graphNeighbors(db: SqliteDatabase, symbolIds: string[]): GraphNeighbor[] {
  if (symbolIds.length === 0) return [];
  const placeholders = symbolIds.map(() => "?").join(", ");
  const direct = db.prepare(`
    SELECT target.id AS id, relation.relation_type AS relationType,
           source.id AS fromId, target.id AS toId
    FROM relations relation
    JOIN symbols source ON source.id = relation.from_symbol_id
    JOIN symbols target ON target.name = relation.to_name
    WHERE relation.relation_type <> 'IMPORTS'
      AND source.id IN (${placeholders})
      AND (
        target.source_path = source.source_path
        OR NOT EXISTS (
          SELECT 1 FROM symbols duplicate
          WHERE duplicate.name = target.name AND duplicate.id <> target.id
        )
      )
    UNION ALL
    SELECT source.id AS id, relation.relation_type AS relationType,
           source.id AS fromId, target.id AS toId
    FROM relations relation
    JOIN symbols source ON source.id = relation.from_symbol_id
    JOIN symbols target ON target.name = relation.to_name
    WHERE relation.relation_type <> 'IMPORTS'
      AND target.id IN (${placeholders})
      AND (
        target.source_path = source.source_path
        OR NOT EXISTS (
          SELECT 1 FROM symbols duplicate
          WHERE duplicate.name = target.name AND duplicate.id <> target.id
        )
      )
    ORDER BY id, relationType, fromId, toId
  `).all(...symbolIds, ...symbolIds) as GraphNeighbor[];

  const symbolRows = db.prepare("SELECT id, source_path AS sourcePath FROM symbols")
    .all() as Array<{ id: string; sourcePath: string }>;
  const symbolsBySource = new Map<string, string[]>();
  for (const row of symbolRows) {
    const ids = symbolsBySource.get(row.sourcePath) ?? [];
    ids.push(row.id);
    symbolsBySource.set(row.sourcePath, ids);
  }
  const sourcePaths = new Set(symbolsBySource.keys());
  const imports = db.prepare(`
    SELECT relation.source_path AS sourcePath, relation.to_name AS targetName,
           relation.from_symbol_id AS fromId
    FROM relations relation
    WHERE relation.relation_type = 'IMPORTS'
  `).all() as Array<{ sourcePath: string; targetName: string; fromId: string | null }>;
  const seeds = new Set(symbolIds);
  const resolvedImports: GraphNeighbor[] = [];
  for (const relation of imports) {
    const targetPath = resolveImportPath(relation.sourcePath, relation.targetName, sourcePaths);
    if (!targetPath) continue;
    const targetIds = symbolsBySource.get(targetPath) ?? [];
    const importerIds = relation.fromId
      ? [relation.fromId]
      : (symbolsBySource.get(relation.sourcePath) ?? []);
    for (const fromId of importerIds) {
      for (const toId of targetIds) {
        if (seeds.has(fromId)) {
          resolvedImports.push({ id: toId, relationType: "IMPORTS", fromId, toId });
        }
        if (seeds.has(toId)) {
          resolvedImports.push({ id: fromId, relationType: "IMPORTS", fromId, toId });
        }
      }
    }
  }
  return [...direct, ...resolvedImports]
    .sort((a, b) => a.id.localeCompare(b.id)
      || a.relationType.localeCompare(b.relationType)
      || a.fromId.localeCompare(b.fromId)
      || a.toId.localeCompare(b.toId));
}

function resolveImportPath(sourcePath: string, targetName: string, sourcePaths: Set<string>): string | null {
  if (!targetName.startsWith(".")) return null;
  const base = posixPath.normalize(posixPath.join(posixPath.dirname(sourcePath), targetName));
  const candidates = [
    base,
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`,
    `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.jsx`,
  ];
  return candidates.find((candidate) => sourcePaths.has(candidate)) ?? null;
}

function ngramHit(
  db: SqliteDatabase,
  kind: SearchItemKind,
  id: string,
  coverage: number,
  query: string,
): SearchHit | null {
  const score = 0.25 + Math.min(1, coverage) * 0.6;
  if (kind === "chunk") {
    const row = db.prepare("SELECT source_path, content, start_line FROM chunks WHERE id = ?").get(id) as
      { source_path: string; content: string; start_line: number } | undefined;
    return row ? {
      kind, id, title: row.source_path, content: row.content, source: row.source_path,
      startLine: row.start_line, score, status: null,
    } : null;
  }
  if (kind === "symbol") {
    const row = db.prepare(
      "SELECT name, qualified_name, kind, signature, source_path, start_line FROM symbols WHERE id = ?",
    ).get(id) as {
      name: string; qualified_name: string; kind: string; signature: string | null;
      source_path: string; start_line: number;
    } | undefined;
    return row ? {
      kind, id, title: `${row.kind} ${row.qualified_name}`, content: row.signature ?? row.name,
      source: row.source_path,
      startLine: row.start_line,
      score: Math.min(1, score + (normalizedIdentifier(row.name) === normalizedIdentifier(query) ? 0.25 : 0.05)),
      status: null,
    } : null;
  }
  const row = db.prepare(`
    SELECT title, content, source_ref, status FROM memories
    WHERE id = ? AND status = 'active'
  `).get(id) as { title: string; content: string; source_ref: string | null; status: string } | undefined;
  return row ? {
    kind, id, title: row.title, content: row.content, source: row.source_ref,
    startLine: null, score, status: row.status,
  } : null;
}

function normalizedIdentifier(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}_]/gu, "");
}

function isExactSymbolMatch(hit: SearchHit, query: string): boolean {
  if (hit.kind !== "symbol") return false;
  const symbolName = normalizedIdentifier(hit.title.split("#").at(-1) ?? "");
  if (!symbolName) return false;
  return query
    .trim()
    .split(/\s+/)
    .map(normalizedIdentifier)
    .some((token) => token === symbolName);
}

/**
 * Keep broad retrieval coverage while putting application code ahead of
 * generated/static and third-party resources in the final ranking.
 */
function relevanceWeight(hit: SearchHit, ranking: SearchRankingSettings): number {
  if (hit.kind === "memory") return ranking.memory;
  if (hit.kind === "symbol") return isLowRelevancePath(hit.source) ? ranking.lowRelevanceSymbol : ranking.businessSymbol;
  return isLowRelevancePath(hit.source) ? ranking.lowRelevanceChunk : ranking.businessChunk;
}

function isLowRelevancePath(source: string | null): boolean {
  if (!source) return false;
  const path = source.replaceAll("\\", "/").toLowerCase();
  const segments = path.split("/");
  if (["vendor", "vendors", "plugin", "plugins", "static", "dist", "assets", "build"].some((segment) => segments.includes(segment))) {
    return true;
  }
  return /\.(svg|eot|ttf|otf|woff2?|map|min\.(?:js|css))$/u.test(path);
}

function toFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .map((token) => token.replaceAll('"', '""').replace(/[^\p{L}\p{N}_-]/gu, ""))
    .filter(Boolean)
    .map((token) => `"${token}"`)
    .join(" OR ");
}

function normalizeRank(rank: number): number {
  return 1 / (1 + Math.abs(rank));
}
