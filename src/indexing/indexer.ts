import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import ignore from "ignore";
import type { Ignore } from "ignore";
import type { SqliteDatabase } from "../storage/database.js";
import type { ProjectRecord } from "../projects/project-service.js";
import { createId, nowIso, sha256 } from "../shared/ids.js";
import {
  containsLikelySecret,
  defaultIgnorePatterns,
  detectKind,
  isCandidateTextFile,
  isGeneratedTextArtifact,
  isSensitivePath,
} from "./file-policy.js";
import { analyzeCode, type CodeAnalysis } from "../code-intelligence/tree-sitter-analyzer.js";
import { deleteItemNgrams, rebuildNgramIndexIfNeeded, replaceItemNgrams } from "../search/ngram-index.js";
import { ProjectContextError } from "../shared/errors.js";
import { createRunLogger } from "./run-log.js";

const MAX_FILE_SIZE = 1_000_000;
const CHUNK_CHAR_LIMIT = 4_000;
const SOURCE_REMOVAL_BATCH_SIZE = 200;
const DELETE_ID_BATCH_SIZE = 900;
const FTS_REMOVAL_BATCH_SIZE = 500;

export interface IndexResult {
  runId: string;
  scanned: number;
  indexed: number;
  skipped: number;
  removed: number;
  errors: Array<{ path: string; message: string }>;
  visited: number;
  prunedDirectories: number;
}

export interface IndexProgress {
  phase: "walking" | "indexing" | "finalizing";
  visited: number;
  scanned: number;
  indexed: number;
  skipped: number;
  prunedDirectories: number;
  path?: string;
}

export interface IndexOptions {
  signal?: AbortSignal;
  onProgress?: (progress: IndexProgress) => void | Promise<void>;
}

interface SourceRow {
  id: string;
  path: string;
  content_hash: string;
}

export async function indexProject(
  db: SqliteDatabase,
  project: ProjectRecord,
  options: IndexOptions = {},
): Promise<IndexResult> {
  const runId = createId("idx");
  const startedAt = nowIso();
  db.prepare("INSERT INTO index_runs (id, started_at, status) VALUES (?, ?, 'running')")
    .run(runId, startedAt);
  const log = createRunLogger(db, runId);
  log.record("开始索引项目，读取忽略规则并扫描文件。");

  const result: IndexResult = {
    runId, scanned: 0, indexed: 0, skipped: 0, removed: 0, errors: [], visited: 0, prunedDirectories: 0,
  };
  try {
    const matcher = ignore().add(defaultIgnorePatterns(project.rootPath));
    for (const fileName of [".gitignore", ".project-context-ignore"]) {
      try {
        matcher.add(await readFile(join(project.rootPath, fileName), "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    const existingRows = db.prepare("SELECT id, path, content_hash FROM sources").all() as SourceRow[];
    const existingByPath = new Map(existingRows.map((row) => [row.path, row]));
    const seen = new Set<string>();

    for await (const absolutePath of walk(project.rootPath, matcher, result, options)) {
      throwIfCancelled(options.signal);
      const relativePath = relative(project.rootPath, absolutePath).split(sep).join("/");
      if (matcher.ignores(relativePath) || isSensitivePath(relativePath) || !isCandidateTextFile(relativePath)) continue;
      result.scanned += 1;
      seen.add(relativePath);
      try {
        const info = await stat(absolutePath);
        if (info.size > MAX_FILE_SIZE) {
          if (existingByPath.has(relativePath)) deleteSource(db, existingByPath.get(relativePath)!.id);
          result.skipped += 1;
          log.record("文件超过大小限制，跳过。", relativePath);
          continue;
        }
        const buffer = await readFile(absolutePath);
        if (buffer.includes(0)) {
          if (existingByPath.has(relativePath)) deleteSource(db, existingByPath.get(relativePath)!.id);
          result.skipped += 1;
          log.record("检测到二进制内容，跳过。", relativePath);
          continue;
        }
        const content = buffer.toString("utf8");
        if (isGeneratedTextArtifact(relativePath, content)) {
          if (existingByPath.has(relativePath)) deleteSource(db, existingByPath.get(relativePath)!.id);
          result.skipped += 1;
          log.record("检测到生成文件，跳过。", relativePath);
          continue;
        }
        if (containsLikelySecret(content)) {
          if (existingByPath.has(relativePath)) deleteSource(db, existingByPath.get(relativePath)!.id);
          result.skipped += 1;
          log.record("检测到疑似敏感内容，跳过；未保存文件内容。", relativePath, "warn");
          continue;
        }
        const contentHash = sha256(buffer);
        const existing = existingByPath.get(relativePath);
        if (existing?.content_hash === contentHash) {
          result.skipped += 1;
          log.record("内容未变化，复用已有索引。", relativePath);
          continue;
        }
        replaceSource(db, {
          sourceId: existing?.id ?? `src_${sha256(relativePath).slice(0, 24)}`,
          relativePath,
          content,
          contentHash,
          sizeBytes: info.size,
          modifiedMs: info.mtimeMs,
          analysis: analyzeCode(relativePath, content),
        });
        result.indexed += 1;
        log.record("已更新文件索引。", relativePath);
        await reportProgress(options, result, "indexing", relativePath);
      } catch (error) {
        result.errors.push({ path: relativePath, message: error instanceof Error ? error.message : String(error) });
        log.record("文件处理失败，详情见错误记录。", relativePath, "error");
      }
    }

    await reportProgress(options, result, "finalizing");
    log.record("文件扫描结束，开始清理失效索引并更新搜索索引。");
    log.flush();
    const missingRows = existingRows.filter((row) => !seen.has(row.path));
    const removeBatch = db.transaction((rows: SourceRow[]) => deleteSources(db, rows.map((row) => row.id), false));
    for (let offset = 0; offset < missingRows.length; offset += SOURCE_REMOVAL_BATCH_SIZE) {
      const batch = missingRows.slice(offset, offset + SOURCE_REMOVAL_BATCH_SIZE);
      removeBatch(batch);
      for (const row of batch) log.record("已移除失效的索引来源；未删除项目文件。", row.path);
      result.removed += batch.length;
      await yieldToEventLoop();
      throwIfCancelled(options.signal);
    }
    if (missingRows.length > 0) {
      await removeOrphanedFtsRows(db, "chunks_fts", "chunk_id", "chunks", result, options);
      await removeOrphanedFtsRows(db, "symbols_fts", "symbol_id", "symbols", result, options);
    }

    await rebuildNgramIndexIfNeeded(db, {
      ...(options.signal ? { signal: options.signal } : {}),
      onBatch: () => reportProgress(options, result, "finalizing", "search index"),
    });

    finishRun(db, result, "completed");
    log.record(`索引完成：扫描 ${result.scanned}，更新 ${result.indexed}，跳过 ${result.skipped}，移除索引 ${result.removed}，错误 ${result.errors.length}。`, undefined, result.errors.length ? "warn" : "info", true);
    return result;
  } catch (error) {
    result.errors.push({ path: "<index>", message: error instanceof Error ? error.message : String(error) });
    finishRun(db, result, "failed");
    log.record(error instanceof Error && error.name === "AbortError" ? "索引已取消，已保存当前进度和错误记录。" : "索引失败，详情见错误记录。", undefined, "error", true);
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProjectContextError("INDEX_CANCELLED", error.message);
    }
    throw error;
  }
}

function deleteSource(db: SqliteDatabase, sourceId: string): void {
  deleteSources(db, [sourceId], true);
}

function deleteSources(db: SqliteDatabase, sourceIds: string[], deleteFts: boolean): void {
  if (sourceIds.length === 0) return;
  const sourcePlaceholders = sourceIds.map(() => "?").join(", ");
  const chunkIds = db.prepare(`SELECT id FROM chunks WHERE source_id IN (${sourcePlaceholders})`)
    .pluck().all(...sourceIds) as string[];
  const symbolIds = db.prepare(`SELECT id FROM symbols WHERE source_id IN (${sourcePlaceholders})`)
    .pluck().all(...sourceIds) as string[];
  deleteSearchItems(db, "chunk", deleteFts ? { table: "chunks_fts", idColumn: "chunk_id" } : null, chunkIds);
  deleteSearchItems(db, "symbol", deleteFts ? { table: "symbols_fts", idColumn: "symbol_id" } : null, symbolIds);
  db.prepare(`DELETE FROM relations WHERE source_id IN (${sourcePlaceholders})`).run(...sourceIds);
  deleteRowsById(db, "chunks", chunkIds);
  deleteRowsById(db, "symbols", symbolIds);
  db.prepare(`UPDATE memory_sources SET source_id = NULL WHERE source_id IN (${sourcePlaceholders})`).run(...sourceIds);
  db.prepare(`DELETE FROM sources WHERE id IN (${sourcePlaceholders})`).run(...sourceIds);
}

function deleteSearchItems(
  db: SqliteDatabase,
  kind: "chunk" | "symbol",
  fts: { table: "chunks_fts" | "symbols_fts"; idColumn: "chunk_id" | "symbol_id" } | null,
  ids: string[],
): void {
  for (let offset = 0; offset < ids.length; offset += DELETE_ID_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + DELETE_ID_BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(", ");
    db.prepare(`DELETE FROM search_ngrams WHERE item_kind = ? AND item_id IN (${placeholders})`)
      .run(kind, ...batch);
    if (fts) db.prepare(`DELETE FROM ${fts.table} WHERE ${fts.idColumn} IN (${placeholders})`).run(...batch);
  }
}

async function removeOrphanedFtsRows(
  db: SqliteDatabase,
  ftsTable: "chunks_fts" | "symbols_fts",
  ftsIdColumn: "chunk_id" | "symbol_id",
  canonicalTable: "chunks" | "symbols",
  result: IndexResult,
  options: IndexOptions,
): Promise<void> {
  const select = db.prepare(`
    SELECT rowid FROM ${ftsTable}
    WHERE rowid > ? AND ${ftsIdColumn} NOT IN (SELECT id FROM ${canonicalTable})
    ORDER BY rowid LIMIT ?
  `);
  let cursor = 0;
  while (true) {
    throwIfCancelled(options.signal);
    const rowIds = select.pluck().all(cursor, FTS_REMOVAL_BATCH_SIZE) as number[];
    if (rowIds.length === 0) return;
    const placeholders = rowIds.map(() => "?").join(", ");
    db.transaction(() => db.prepare(`DELETE FROM ${ftsTable} WHERE rowid IN (${placeholders})`).run(...rowIds))();
    cursor = rowIds.at(-1)!;
    await reportProgress(options, result, "finalizing", "search cleanup");
    await yieldToEventLoop();
  }
}

function deleteRowsById(db: SqliteDatabase, table: "chunks" | "symbols", ids: string[]): void {
  for (let offset = 0; offset < ids.length; offset += DELETE_ID_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + DELETE_ID_BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(", ");
    db.prepare(`DELETE FROM ${table} WHERE id IN (${placeholders})`).run(...batch);
  }
}

function replaceSource(db: SqliteDatabase, input: {
  sourceId: string;
  relativePath: string;
  content: string;
  contentHash: string;
  sizeBytes: number;
  modifiedMs: number;
  analysis: CodeAnalysis | null;
}): void {
  const chunks = chunkText(input.content);
  const transaction = db.transaction(() => {
    db.prepare("DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE source_id = ?)")
      .run(input.sourceId);
    for (const id of db.prepare("SELECT id FROM chunks WHERE source_id = ?").pluck().all(input.sourceId) as string[]) {
      deleteItemNgrams(db, "chunk", id);
    }
    db.prepare("DELETE FROM chunks WHERE source_id = ?").run(input.sourceId);
    for (const id of db.prepare("SELECT id FROM symbols WHERE source_id = ?").pluck().all(input.sourceId) as string[]) {
      deleteItemNgrams(db, "symbol", id);
    }
    db.prepare("DELETE FROM symbols_fts WHERE symbol_id IN (SELECT id FROM symbols WHERE source_id = ?)")
      .run(input.sourceId);
    db.prepare("DELETE FROM relations WHERE source_id = ?").run(input.sourceId);
    db.prepare("DELETE FROM symbols WHERE source_id = ?").run(input.sourceId);
    db.prepare(`
      INSERT INTO sources (id, path, kind, content_hash, size_bytes, modified_ms, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        kind = excluded.kind,
        content_hash = excluded.content_hash,
        size_bytes = excluded.size_bytes,
        modified_ms = excluded.modified_ms,
        indexed_at = excluded.indexed_at
    `).run(
      input.sourceId,
      input.relativePath,
      detectKind(input.relativePath),
      input.contentHash,
      input.sizeBytes,
      input.modifiedMs,
      nowIso(),
    );
    const insertChunk = db.prepare(
      "INSERT INTO chunks (id, source_id, source_path, content, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const insertFts = db.prepare("INSERT INTO chunks_fts (chunk_id, source_path, content) VALUES (?, ?, ?)");
    for (const chunk of chunks) {
      const id = `chk_${sha256(`${input.relativePath}:${chunk.startLine}:${chunk.content}`).slice(0, 24)}`;
      insertChunk.run(id, input.sourceId, input.relativePath, chunk.content, chunk.startLine, chunk.endLine);
      insertFts.run(id, input.relativePath, chunk.content);
      replaceItemNgrams(db, "chunk", id, `${input.relativePath}\n${chunk.content}`);
    }
    if (input.analysis) insertCodeAnalysis(db, input.sourceId, input.relativePath, input.analysis);
  });
  transaction();
}

function insertCodeAnalysis(
  db: SqliteDatabase,
  sourceId: string,
  sourcePath: string,
  analysis: CodeAnalysis,
): void {
  const insertSymbol = db.prepare(`
    INSERT INTO symbols (
      id, source_id, source_path, name, qualified_name, kind, signature, start_line, end_line, content_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSymbolFts = db.prepare(
    "INSERT INTO symbols_fts (symbol_id, name, qualified_name, signature) VALUES (?, ?, ?, ?)",
  );
  for (const symbol of analysis.symbols) {
    insertSymbol.run(
      symbol.id, sourceId, sourcePath, symbol.name, symbol.qualifiedName, symbol.kind,
      symbol.signature, symbol.startLine, symbol.endLine, symbol.contentHash,
    );
    insertSymbolFts.run(symbol.id, symbol.name, symbol.qualifiedName, symbol.signature ?? "");
    replaceItemNgrams(db, "symbol", symbol.id, `${symbol.name}\n${symbol.qualifiedName}\n${symbol.signature ?? ""}`);
  }
  const insertRelation = db.prepare(`
    INSERT INTO relations (
      id, source_id, source_path, from_symbol_id, from_name, to_name, relation_type, start_line, evidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const item of analysis.relations) {
    insertRelation.run(
      item.id, sourceId, sourcePath, item.fromSymbolId, item.fromName, item.toName,
      item.relationType, item.startLine, item.evidence,
    );
  }
}

function chunkText(content: string): Array<{ content: string; startLine: number; endLine: number }> {
  const lines = content.split(/\r?\n/);
  const chunks: Array<{ content: string; startLine: number; endLine: number }> = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let chars = 0;
    while (end < lines.length && (chars + (lines[end]?.length ?? 0) + 1 <= CHUNK_CHAR_LIMIT || end === start)) {
      chars += (lines[end]?.length ?? 0) + 1;
      end += 1;
    }
    chunks.push({ content: lines.slice(start, end).join("\n"), startLine: start + 1, endLine: end });
    start = end;
  }
  return chunks;
}

async function* walk(
  root: string,
  matcher: Ignore,
  result: IndexResult,
  options: IndexOptions,
  relativeDirectory = "",
): AsyncGenerator<string> {
  throwIfCancelled(options.signal);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    throwIfCancelled(options.signal);
    const path = join(root, entry.name);
    const relativePath = [relativeDirectory, entry.name].filter(Boolean).join("/");
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (matcher.ignores(`${relativePath}/`)) {
        result.prunedDirectories += 1;
        continue;
      }
      yield* walk(path, matcher, result, options, relativePath);
    } else if (entry.isFile()) {
      result.visited += 1;
      if (result.visited % 100 === 0) await reportProgress(options, result, "walking", relativePath);
      yield path;
    }
  }
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error("Project indexing was cancelled.");
    error.name = "AbortError";
    throw error;
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function reportProgress(
  options: IndexOptions,
  result: IndexResult,
  phase: IndexProgress["phase"],
  path?: string,
): Promise<void> {
  if (!options.onProgress) return;
  await options.onProgress({
    phase,
    visited: result.visited,
    scanned: result.scanned,
    indexed: result.indexed,
    skipped: result.skipped,
    prunedDirectories: result.prunedDirectories,
    ...(path ? { path } : {}),
  });
}

function finishRun(db: SqliteDatabase, result: IndexResult, status: "completed" | "failed"): void {
  db.prepare(`
    UPDATE index_runs SET completed_at = ?, status = ?, scanned = ?, indexed = ?, skipped = ?, removed = ?, errors_json = ?
    WHERE id = ?
  `).run(
    nowIso(), status, result.scanned, result.indexed, result.skipped, result.removed,
    JSON.stringify(result.errors), result.runId,
  );
}
