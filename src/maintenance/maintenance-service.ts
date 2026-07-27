import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { SqliteDatabase } from "../storage/database.js";
import type { ProjectRecord } from "../projects/project-service.js";
import { ProjectContextError } from "../shared/errors.js";
import { nowIso } from "../shared/ids.js";
import { authorizeOutputPath, isWithinRoot } from "../security/path-policy.js";
import { isNgramIndexCurrent, rebuildNgramIndex } from "../search/ngram-index.js";

export interface DoctorResult {
  ok: boolean;
  schemaVersion: number;
  integrity: string;
  issues: string[];
  repaired: string[];
  counts: Record<string, number>;
}

export async function doctorProject(
  db: SqliteDatabase,
  project: ProjectRecord,
  repair = false,
): Promise<DoctorResult> {
  const issues: string[] = [];
  const repaired: string[] = [];
  const integrity = String(db.pragma("quick_check", { simple: true }));
  if (integrity !== "ok") issues.push(`SQLite quick_check: ${integrity}`);
  const foreignKeyViolations = db.pragma("foreign_key_check") as unknown[];
  if (foreignKeyViolations.length > 0) {
    issues.push(`SQLite foreign_key_check: ${foreignKeyViolations.length} violation(s).`);
  }
  let counts = projectCounts(db);
  if (counts.chunks !== counts.chunkFts) issues.push("Chunk FTS index is inconsistent.");
  if (counts.symbols !== counts.symbolFts) issues.push("Symbol FTS index is inconsistent.");
  if (counts.memories !== counts.memoryFts) issues.push("Memory FTS index is inconsistent.");
  if (!isNgramIndexCurrent(db)) {
    issues.push("Unicode n-gram search index needs rebuilding; run project_index.");
  }

  const sourcePaths = db.prepare("SELECT path FROM sources").pluck().all() as string[];
  const missing: string[] = [];
  for (const path of sourcePaths) {
    const absolute = resolve(project.rootPath, path);
    if (!isWithinRoot(project.rootPath, absolute)) {
      issues.push(`Unsafe indexed source path: ${path}`);
      continue;
    }
    try {
      await access(absolute);
    } catch {
      missing.push(path);
    }
  }
  if (missing.length > 0) issues.push(`${missing.length} indexed source files are missing; run project_index.`);

  const hasFtsIssue = issues.some((issue) => issue.includes("FTS index"));
  if (repair && hasFtsIssue) {
    rebuildFts(db);
    counts = projectCounts(db);
    repaired.push("Rebuilt chunk, symbol, and memory FTS indexes from canonical tables.");
  }
  if (repair && issues.some((issue) => issue.includes("n-gram"))) {
    await rebuildNgramIndex(db);
    counts = projectCounts(db);
    repaired.push("Rebuilt the Unicode n-gram search index from canonical tables.");
  }
  const unresolvedIssues = issues.filter((issue) => !(
    repair && ((hasFtsIssue && issue.includes("FTS index")) || issue.includes("n-gram"))
  ));
  return {
    ok: integrity === "ok" && unresolvedIssues.length === 0,
    schemaVersion: db.pragma("user_version", { simple: true }) as number,
    integrity,
    issues,
    repaired,
    counts,
  };
}

export async function backupProjectDatabase(
  db: SqliteDatabase,
  destination: string,
  allowedOutputRoots: string[],
): Promise<Record<string, unknown>> {
  const target = await authorizeOutputPath(destination, allowedOutputRoots);
  await mkdir(dirname(target), { recursive: true });
  try {
    await access(target);
    throw new ProjectContextError("OUTPUT_EXISTS", `Backup destination already exists: ${target}`);
  } catch (error) {
    if (error instanceof ProjectContextError) throw error;
  }
  const result = await db.backup(target);
  return { destination: target, pages: result.totalPages, remainingPages: result.remainingPages, completedAt: nowIso() };
}

export async function exportProject(
  db: SqliteDatabase,
  project: ProjectRecord,
  outputDirectory: string,
  allowedOutputRoots: string[],
): Promise<Record<string, unknown>> {
  const target = await authorizeOutputPath(outputDirectory, allowedOutputRoots);
  const existing = await readdir(target).catch(() => [] as string[]);
  if (existing.length > 0) {
    throw new ProjectContextError("OUTPUT_NOT_EMPTY", `Export directory is not empty: ${target}`);
  }
  await mkdir(target, { recursive: true });
  const files: Record<string, unknown[]> = {
    "memories.jsonl": db.prepare("SELECT * FROM memories ORDER BY created_at").all(),
    "memory-candidates.jsonl": db.prepare("SELECT * FROM memory_candidates ORDER BY created_at").all(),
    "tasks.jsonl": db.prepare("SELECT * FROM tasks ORDER BY created_at").all(),
    "symbols.jsonl": db.prepare("SELECT * FROM symbols ORDER BY source_path, start_line").all(),
    "relations.jsonl": db.prepare("SELECT * FROM relations ORDER BY source_path, start_line").all(),
  };
  for (const [name, rows] of Object.entries(files)) {
    await writeFile(join(target, name), rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), "utf8");
  }
  const manifest = {
    version: 1,
    exportedAt: nowIso(),
    project,
    schemaVersion: db.pragma("user_version", { simple: true }),
    files: Object.fromEntries(Object.entries(files).map(([name, rows]) => [name, rows.length])),
  };
  await writeFile(join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { outputDirectory: target, ...manifest };
}

function rebuildFts(db: SqliteDatabase): void {
  db.transaction(() => {
    db.exec("DELETE FROM chunks_fts; DELETE FROM symbols_fts; DELETE FROM memories_fts;");
    db.exec(`
      INSERT INTO chunks_fts (chunk_id, source_path, content)
      SELECT id, source_path, content FROM chunks;
      INSERT INTO symbols_fts (symbol_id, name, qualified_name, signature)
      SELECT id, name, qualified_name, COALESCE(signature, '') FROM symbols;
      INSERT INTO memories_fts (memory_id, title, content, reason)
      SELECT id, title, content, COALESCE(reason, '') FROM memories;
    `);
  })();
}

function projectCounts(db: SqliteDatabase): Record<string, number> {
  return {
    sources: scalar(db, "SELECT COUNT(*) FROM sources"),
    chunks: scalar(db, "SELECT COUNT(*) FROM chunks"),
    chunkFts: scalar(db, "SELECT COUNT(*) FROM chunks_fts"),
    symbols: scalar(db, "SELECT COUNT(*) FROM symbols"),
    symbolFts: scalar(db, "SELECT COUNT(*) FROM symbols_fts"),
    relations: scalar(db, "SELECT COUNT(*) FROM relations"),
    memories: scalar(db, "SELECT COUNT(*) FROM memories"),
    memoryFts: scalar(db, "SELECT COUNT(*) FROM memories_fts"),
    staleMemories: scalar(db, "SELECT COUNT(*) FROM memories WHERE status IN ('stale', 'conflicted')"),
    pendingCandidates: scalar(db, "SELECT COUNT(*) FROM memory_candidates WHERE status = 'pending'"),
    searchNgrams: scalar(db, "SELECT COUNT(*) FROM search_ngrams"),
  };
}

function scalar(db: SqliteDatabase, sql: string): number {
  return (db.prepare(sql).pluck().get() as number | undefined) ?? 0;
}
