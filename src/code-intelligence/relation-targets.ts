import { extname, posix } from "node:path";
import type { SqliteDatabase } from "../storage/database.js";
import { analysisLanguage, type AnalysisLanguage } from "./languages.js";

// Unqualified calls inside these languages' classes refer to members of the class.
const IMPLICIT_MEMBER_LANGUAGES = new Set<AnalysisLanguage | null>(["java", "csharp", "cpp"]);
// Overloads share a qualified name; any of them is the same named target.
const OVERLOADING_LANGUAGES = new Set<AnalysisLanguage | null>(["java", "csharp", "cpp"]);

/** Indexed source paths by lowercase file name, for suffix matches of non-relative imports. */
type PathIndex = Map<string, string[]>;

interface SymbolRow {
  id: string;
  name: string;
  qualifiedName: string;
  sourcePath: string;
}
interface RelationRow {
  id: string;
  sourcePath: string;
  fromSymbolId: string | null;
  fromName: string;
  toName: string;
  relationType: string;
  evidence: string | null;
}
interface ImportBinding { path: string; name: string | null }
interface ResolveContext {
  byQualifiedName: Map<string, SymbolRow[]>;
  byName: Map<string, SymbolRow[]>;
  imports: Map<string, Map<string, ImportBinding>>;
  /** Java package directories imported with `.*`, by importing source path. */
  wildcardPackages: Map<string, string[]>;
  sourcePaths: Set<string>;
  supertypes: Map<string, SymbolRow[]>;
}
const TARGETS_VERSION = "2";

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
    SELECT id, source_path AS sourcePath, from_symbol_id AS fromSymbolId, from_name AS fromName, to_name AS toName,
           relation_type AS relationType, evidence FROM relations
  `).all() as RelationRow[];
  const pathIndex: PathIndex = new Map();
  for (const path of sourcePaths) append(pathIndex, posix.basename(path).toLowerCase(), path);
  const context: ResolveContext = {
    byQualifiedName, byName, imports: new Map(), wildcardPackages: new Map(), sourcePaths, supertypes: new Map(),
  };
  const importPaths = new Map<string, string>();
  const javaDirectories = [...new Set([...sourcePaths].filter((path) => path.endsWith(".java")).map((path) => posix.dirname(path)))];
  const wildcardCache = new Map<string, string | null>();
  for (const relation of relations) {
    if (relation.relationType !== "IMPORTS") continue;
    const wildcard = javaWildcardPackage(relation, javaDirectories, wildcardCache);
    if (wildcard) append(context.wildcardPackages, relation.sourcePath, wildcard);
    const resolved = resolveImport(relation, sourcePaths, pathIndex);
    if (!resolved) continue;
    importPaths.set(relation.id, resolved.path);
    const bindings = context.imports.get(relation.sourcePath) ?? new Map<string, ImportBinding>();
    context.imports.set(relation.sourcePath, bindings);
    for (const [local, name] of resolved.bindings) bindings.set(local, { path: resolved.path, name });
  }
  // Supertypes first, so calls can find members a type inherits.
  const heritageTargets = new Map<string, SymbolRow>();
  for (const relation of relations) {
    if ((relation.relationType !== "EXTENDS" && relation.relationType !== "IMPLEMENTS") || !relation.fromSymbolId) continue;
    const target = resolveSymbol(relation, context);
    if (!target) continue;
    heritageTargets.set(relation.id, target);
    append(context.supertypes, relation.fromSymbolId, target);
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
        const target = heritageTargets.get(relation.id) ?? resolveSymbol(relation, context);
        if (target) insert.run(relation.id, target.id, target.sourcePath);
      }
    }).immediate();
    await options.onBatch?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('relation_targets_version', ?)").run(TARGETS_VERSION);
}

function resolveSymbol(relation: RelationRow, context: ResolveContext): SymbolRow | null {
  const { byQualifiedName, byName, imports, sourcePaths, supertypes } = context;
  const qualified = (name: string) => named(byQualifiedName.get(name));
  // Breadth-first through resolved EXTENDS/IMPLEMENTS targets, a few levels deep.
  const inheritedMember = (type: SymbolRow, member: string): SymbolRow | null => {
    const seen = new Set([type.id]);
    let level = [type];
    for (let depth = 0; depth < 4 && level.length; depth++) {
      const next: SymbolRow[] = [];
      for (const current of level) {
        for (const parent of supertypes.get(current.id) ?? []) {
          if (seen.has(parent.id)) continue;
          seen.add(parent.id);
          const found = qualified(`${parent.qualifiedName}#${member}`);
          if (found) return found;
          next.push(parent);
        }
      }
      level = next;
    }
    return null;
  };
  const direct = qualified(relation.toName);
  if (direct) return direct;
  const parts = relation.toName.split(".");
  // `new Type(...)` from Java, C++, C# and PHP links to the class it creates.
  const constructed = relation.toName.match(/^new ([\p{L}_$][\p{L}\p{N}_$]*)$/u)?.[1];
  if (constructed) parts.splice(0, parts.length, constructed);
  if (!parts.every((part) => /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(part))) return null;
  const first = parts[0]!;
  const language = analysisLanguage(relation.sourcePath);
  const binding = imports.get(relation.sourcePath)?.get(first)
    ?? packageType(posix.dirname(relation.sourcePath), first, language, sourcePaths)
    ?? (context.wildcardPackages.get(relation.sourcePath) ?? []).map((directory) => packageType(directory, first, language, sourcePaths)).find(Boolean)
    ?? null;
  if (binding) {
    const names = binding.name === null ? parts.slice(1) : [binding.name, ...parts.slice(1)];
    if (!names.length) return null;
    const own = qualified([binding.path, ...names].join("#"));
    if (own || names.length !== 2) return own;
    // Methods declared by supertypes, e.g. queryByKey() from a shared base service interface.
    const type = qualified([binding.path, names[0]!].join("#"));
    return type ? inheritedMember(type, names[1]!) : null;
  }
  const container = relation.fromName.split("#").slice(0, -1);
  const containerType = () => container.length >= 2 ? qualified(container.join("#")) : null;
  if (first === "this") {
    if (container.length < 2) return null;
    const own = qualified([...container, ...parts.slice(1)].join("#"));
    const type = !own && parts.length === 2 ? containerType() : null;
    return own ?? (type ? inheritedMember(type, parts[1]!) : null);
  }
  const local = qualified([relation.sourcePath, ...parts].join("#"));
  if (local) return local;
  if (parts.length === 1 && !constructed && IMPLICIT_MEMBER_LANGUAGES.has(language) && container.length >= 2) {
    const member = qualified([...container, first].join("#"));
    if (member) return member;
    const type = containerType();
    const inherited = type ? inheritedMember(type, first) : null;
    if (inherited) return inherited;
  }
  // An unknown receiver is not a class: avoid connecting unrelated same-name methods.
  return parts.length === 1 ? unique(byName.get(first)) : null;
}

/** A Java type declared in a package directory: the caller's own package or one imported with `.*`. */
function packageType(directory: string, name: string, language: AnalysisLanguage | null, sourcePaths: Set<string>): ImportBinding | null {
  if (language !== "java" || !/^[A-Z]/u.test(name)) return null;
  const path = posix.join(directory, `${name}.java`);
  return sourcePaths.has(path) ? { path, name } : null;
}

/** The single directory of Java sources matching an `import a.b.*;` package; cached per package. */
function javaWildcardPackage(relation: RelationRow, javaDirectories: string[], cache: Map<string, string | null>): string | null {
  if (analysisLanguage(relation.sourcePath) !== "java" || !relation.toName.endsWith(".*")) return null;
  const suffix = relation.toName.slice(0, -2).replaceAll(".", "/").toLowerCase();
  if (!suffix) return null;
  if (!cache.has(suffix)) {
    const matches = javaDirectories.filter((directory) => { const lower = directory.toLowerCase(); return lower === suffix || lower.endsWith(`/${suffix}`); });
    cache.set(suffix, matches.length === 1 ? matches[0]! : null);
  }
  return cache.get(suffix) ?? null;
}

/** Where an IMPORTS relation points and which local names it binds there. */
function resolveImport(
  relation: RelationRow, sourcePaths: Set<string>, pathIndex: PathIndex,
): { path: string; bindings: Array<[string, string | null]> } | null {
  const language = analysisLanguage(relation.sourcePath);
  const target = relation.toName;
  const evidence = relation.evidence ?? "";
  if (language === "java") {
    // a.b.Type, or a.b.Type.Member for static and nested-type imports; package wildcards bind nothing.
    const segments = target.replace(/\.\*$/u, "").split(".");
    for (const memberCount of [0, 1]) {
      const typeSegments = segments.slice(0, segments.length - memberCount);
      if (typeSegments.length === 0) break;
      const path = suffixPath([...typeSegments.slice(0, -1), `${typeSegments.at(-1)}.java`], pathIndex, typeSegments.length);
      if (!path) continue;
      if (target.endsWith(".*")) return { path, bindings: [] };
      const type = typeSegments.at(-1)!;
      return { path, bindings: memberCount ? [[segments.at(-1)!, `${type}#${segments.at(-1)}`]] : [[type, type]] };
    }
    return null;
  }
  if (language === "php") {
    if (target.includes("\\") || /^[A-Z]/u.test(target)) {
      const segments = target.split("\\");
      const path = suffixPath([...segments.slice(0, -1), `${segments.at(-1)}.php`], pathIndex, Math.min(2, segments.length));
      const alias = evidence.match(/\bas\s+(\w+)\s*$/iu)?.[1];
      return path ? { path, bindings: [[alias ?? segments.at(-1)!, segments.at(-1)!]] } : null;
    }
    const path = relativePath(relation.sourcePath, target, sourcePaths) ?? (sourcePaths.has(target.replace(/^\//u, "")) ? target.replace(/^\//u, "") : null);
    return path ? { path, bindings: [] } : null;
  }
  if (language === "c" || language === "cpp") {
    const path = relativePath(relation.sourcePath, target, sourcePaths) ?? suffixPath(target.split("/"), pathIndex, target.split("/").length);
    return path ? { path, bindings: [] } : null;
  }
  const path = resolveImportPath(relation.sourcePath, target, sourcePaths);
  return path ? { path, bindings: importBindings(evidence) } : null;
}

function relativePath(sourcePath: string, target: string, sourcePaths: Set<string>): string | null {
  const path = posix.normalize(posix.join(posix.dirname(sourcePath), target.replace(/^\//u, "")));
  return sourcePaths.has(path) ? path : null;
}

/**
 * The single indexed path ending with the given segments, trying shorter suffixes down to
 * minSegments; an ambiguous suffix resolves nothing rather than guessing.
 */
function suffixPath(segments: string[], pathIndex: PathIndex, minSegments: number): string | null {
  const candidates = pathIndex.get(segments.at(-1)!.toLowerCase());
  if (!candidates) return null;
  for (let take = segments.length; take >= Math.max(1, minSegments); take--) {
    const suffix = segments.slice(-take).join("/").toLowerCase();
    const matches = candidates.filter((path) => { const lower = path.toLowerCase(); return lower === suffix || lower.endsWith(`/${suffix}`); });
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) return null;
  }
  return null;
}

/** Unique match, or the first overload of a method in a language that overloads. */
function named(rows: SymbolRow[] | undefined): SymbolRow | null {
  if (!rows?.length) return null;
  if (rows.length === 1 || OVERLOADING_LANGUAGES.has(analysisLanguage(rows[0]!.sourcePath))) return rows[0]!;
  return null;
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
