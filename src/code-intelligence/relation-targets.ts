import { extname, posix } from "node:path";
import type { SqliteDatabase } from "../storage/database.js";

interface SymbolRow {
  id: string;
  name: string;
  qualifiedName: string;
  sourcePath: string;
}
interface RelationRow {
  id: string;
  sourcePath: string;
  fromName: string;
  toName: string;
  relationType: string;
  evidence: string | null;
}
interface ImportBinding { path: string; name: string | null }
const TARGETS_VERSION = "1";

/** Resolve once after indexing; searches only traverse persisted IDs and paths. */
export async function rebuildRelationTargets(
  db: SqliteDatabase,
  changed: boolean,
  options: { signal?: AbortSignal; onBatch?: () => void | Promise<void> } = {},
): Promise<void> {
  if (!changed && db.prepare("SELECT value FROM metadata WHERE key = 'relation_targets_version'").pluck().get() === TARGETS_VERSION) return;
  const symbols = db.prepare(`
    SELECT id, name, qualified_name AS qualifiedName, source_path AS sourcePath FROM symbols
  `).all() as SymbolRow[];
  const sourcePaths = new Set(db.prepare("SELECT path FROM sources").pluck().all() as string[]);
  const byQualifiedName = new Map<string, SymbolRow[]>();
  const byName = new Map<string, SymbolRow[]>();
  for (const symbol of symbols) {
    append(byQualifiedName, symbol.qualifiedName, symbol);
    append(byName, symbol.name, symbol);
  }
  const relations = db.prepare(`
    SELECT id, source_path AS sourcePath, from_name AS fromName, to_name AS toName,
           relation_type AS relationType, evidence FROM relations
  `).all() as RelationRow[];
  const imports = new Map<string, Map<string, ImportBinding>>();
  const importPaths = new Map<string, string>();
  for (const relation of relations) {
    if (relation.relationType !== "IMPORTS") continue;
    const path = resolveImportPath(relation.sourcePath, relation.toName, sourcePaths);
    if (!path) continue;
    importPaths.set(relation.id, path);
    const bindings = imports.get(relation.sourcePath) ?? new Map<string, ImportBinding>();
    imports.set(relation.sourcePath, bindings);
    for (const [local, name] of importBindings(relation.evidence ?? "")) bindings.set(local, { path, name });
  }
  db.transaction(() => {
    db.prepare("DELETE FROM metadata WHERE key = 'relation_targets_version'").run();
    db.prepare("DELETE FROM relation_targets").run();
  }).immediate();
  const insert = db.prepare("INSERT INTO relation_targets (relation_id, to_symbol_id, to_source_path) VALUES (?, ?, ?)");
  for (let offset = 0; offset < relations.length; offset += 500) {
    if (options.signal?.aborted) {
      const error = new Error("Relation target indexing was cancelled.");
      error.name = "AbortError";
      throw error;
    }
    db.transaction(() => {
      for (const relation of relations.slice(offset, offset + 500)) {
        if (relation.relationType === "IMPORTS") {
          const path = importPaths.get(relation.id);
          if (path) insert.run(relation.id, null, path);
          continue;
        }
        const target = resolveSymbol(relation, byQualifiedName, byName, imports);
        if (target) insert.run(relation.id, target.id, target.sourcePath);
      }
    }).immediate();
    await options.onBatch?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('relation_targets_version', ?)").run(TARGETS_VERSION);
}

function resolveSymbol(
  relation: RelationRow,
  byQualifiedName: Map<string, SymbolRow[]>,
  byName: Map<string, SymbolRow[]>,
  imports: Map<string, Map<string, ImportBinding>>,
): SymbolRow | null {
  const direct = unique(byQualifiedName.get(relation.toName));
  if (direct) return direct;
  const parts = relation.toName.split(".");
  if (!parts.every((part) => /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(part))) return null;
  const first = parts[0]!;
  const binding = imports.get(relation.sourcePath)?.get(first);
  if (binding) {
    const names = binding.name === null ? parts.slice(1) : [binding.name, ...parts.slice(1)];
    return names.length ? unique(byQualifiedName.get([binding.path, ...names].join("#"))) : null;
  }
  if (first === "this") {
    const container = relation.fromName.split("#").slice(0, -1);
    if (container.length < 2) return null;
    return unique(byQualifiedName.get([...container, ...parts.slice(1)].join("#")));
  }
  const local = unique(byQualifiedName.get([relation.sourcePath, ...parts].join("#")));
  if (local) return local;
  // An unknown receiver is not a class: avoid connecting unrelated same-name methods.
  return parts.length === 1 ? unique(byName.get(first)) : null;
}

function importBindings(evidence: string): Array<[string, string | null]> {
  const clause = evidence.match(/^\s*import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]/u)?.[1];
  if (!clause) return [];
  const bindings: Array<[string, string | null]> = [];
  const namespace = clause.match(/\*\s+as\s+([\w$]+)/u)?.[1];
  if (namespace) bindings.push([namespace, null]);
  const named = clause.match(/\{([\s\S]*?)\}/u)?.[1];
  for (const specifier of named?.split(",") ?? []) {
    const match = specifier.trim().match(/^(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/u);
    if (match) bindings.push([match[2] ?? match[1]!, match[1]!]);
  }
  return bindings;
}

export function resolveImportPath(sourcePath: string, targetName: string, sourcePaths: Set<string>): string | null {
  if (!targetName.startsWith(".")) return null;
  const base = posix.normalize(posix.join(posix.dirname(sourcePath), targetName));
  const extension = extname(base);
  const withoutExtension = extension ? base.slice(0, -extension.length) : base;
  const candidates = [base, ...[".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].flatMap((suffix) => [
    `${withoutExtension}${suffix}`, `${withoutExtension}/index${suffix}`,
  ])];
  return candidates.find((candidate) => sourcePaths.has(candidate)) ?? null;
}

function unique(rows: SymbolRow[] | undefined): SymbolRow | null { return rows?.length === 1 ? rows[0]! : null; }
function append<T>(map: Map<string, T[]>, key: string, value: T): void {
  const rows = map.get(key) ?? [];
  rows.push(value);
  map.set(key, rows);
}
