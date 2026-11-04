import type { SqliteDatabase } from "../storage/database.js";
import { knowledgeSnapshot } from "./knowledge-service.js";
import { getMemory, type MemoryRecord } from "./memory-service.js";
import { ProjectContextError } from "../shared/errors.js";

export interface EntityRecallEvidence {
  entityId: string;
  name: string;
  matchedName: string;
  annotationId: string;
  quote: string;
  relations: Array<{ from: string; to: string; type: string; quote: string; annotationId: string }>;
}

const MAX_NAMES_SCANNED = 16_384;
const MAX_NAME_CHARACTERS = 1_000_000;
const MAX_MATCHED_NAMES = 8;

/** Only explicitly reviewed aliases identify entities. Ambiguous names never expand a query. */
export function recallEntityMemories(db: SqliteDatabase, task: string,
  accepts: (memory: MemoryRecord, evidence: EntityRecallEvidence) => boolean, limit = 4,
): { items: Array<{ memory: MemoryRecord; evidence: EntityRecallEvidence }>; truncated: boolean } {
  if (!Number.isInteger(limit) || limit < 0 || limit > 4) {
    throw new ProjectContextError("INVALID_ENTITY_RECALL", "Entity recall limit must be an integer from 0 to 4.");
  }
  if (!limit) return { items: [], truncated: false };
  const query = normalize(task);
  if (!query) return { items: [], truncated: false };
  // Discover lightweight names independently of the bounded graph overview.
  // Snapshot validation below checks the source hash, evidence, review conflicts
  // and every owner of an actually matched name before it can contribute recall.
  const names = discoverMatchedNames(db, query);
  let truncated = names.truncated;
  const items: Array<{ memory: MemoryRecord; evidence: EntityRecallEvidence }> = [];
  const seen = new Set<string>();
  for (const matchedName of names.values) {
    const snapshot = knowledgeSnapshot(db, { matchedName, limit: 100 });
    // A partial inventory for this particular name cannot establish uniqueness.
    // Unrelated annotations no longer disable all entity recall globally.
    if (snapshot.truncated) { truncated = true; continue; }
    const owners = snapshot.entities.filter((entity) => [entity.name, ...entity.aliases]
      .some((name) => normalize(name) === matchedName));
    if (owners.length !== 1) continue;
    const entity = owners[0]!;
    const displayName = [entity.name, ...entity.aliases].find((name) => normalize(name) === matchedName)!;
    for (const binding of snapshot.bindings.filter((entry) => entry.entityId === entity.id)) {
      if (seen.has(binding.memoryId)) continue;
      const memory = getMemory(db, binding.memoryId);
      const relationEvidence = snapshot.relations.filter((edge) => edge.memoryId === memory.id
        && edge.annotationId === binding.annotationId && (edge.from === entity.id || edge.to === entity.id))
        .slice(0, 2).map((edge) => ({
          from: snapshot.entities.find((entry) => entry.id === edge.from)!.name,
          to: snapshot.entities.find((entry) => entry.id === edge.to)!.name,
          type: edge.type, quote: edge.quote, annotationId: edge.annotationId,
        }));
      const evidence: EntityRecallEvidence = {
        entityId: entity.id, name: entity.name, matchedName: displayName,
        annotationId: binding.annotationId, quote: binding.quote, relations: relationEvidence,
      };
      if (!accepts(memory, evidence)) continue;
      if (items.length >= limit) return { items, truncated: true };
      items.push({ memory, evidence });
      seen.add(memory.id);
    }
  }
  return { items, truncated };
}

function discoverMatchedNames(db: SqliteDatabase, query: string): { values: string[]; truncated: boolean } {
  const rows = db.prepare(`
    WITH eligible AS (
      SELECT k.id,k.updated_at,k.document_json FROM memory_knowledge k
      JOIN memories m ON m.id=k.memory_id
      WHERE k.status='accepted' AND m.status='active' AND m.type<>'task-summary'
    ), names AS (
      SELECT k.id,k.updated_at,e.key AS entity_key,-1 AS alias_key,
        json_extract(e.value,'$.name') AS name
      FROM eligible k,json_each(k.document_json,'$.entities') e
      UNION ALL
      SELECT k.id,k.updated_at,e.key AS entity_key,a.key AS alias_key,a.value AS name
      FROM eligible k,json_each(k.document_json,'$.entities') e,json_each(e.value,'$.aliases') a
    )
    SELECT name FROM names ORDER BY updated_at DESC,id,entity_key,alias_key LIMIT ?
  `).iterate(MAX_NAMES_SCANNED + 1) as Iterable<{ name: string }>;
  const found = new Set<string>();
  let count = 0;
  let characters = 0;
  let truncated = false;
  for (const row of rows) {
    count += 1;
    if (count > MAX_NAMES_SCANNED) { truncated = true; break; }
    if (typeof row.name !== "string") continue;
    characters += row.name.length;
    if (characters > MAX_NAME_CHARACTERS) { truncated = true; break; }
    const name = normalize(row.name);
    if (!matches(query, name)) continue;
    if (!found.has(name) && found.size >= MAX_MATCHED_NAMES) { truncated = true; continue; }
    found.add(name);
  }
  return { values: [...found], truncated };
}

function normalize(value: string) { return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " "); }
function matches(query: string, name: string): boolean {
  if ([...name].length < 3) return false;
  if (query === name) return true;
  let start = 0;
  while (start <= query.length) {
    const index = query.indexOf(name, start);
    if (index < 0) return false;
    const before = query[index - 1] ?? "", after = query[index + name.length] ?? "";
    if ((!/^[a-z0-9_]/u.test(name) || !/[a-z0-9_]/u.test(before))
      && (!/[a-z0-9_]$/u.test(name) || !/[a-z0-9_]/u.test(after))) return true;
    start = index + 1;
  }
  return false;
}
