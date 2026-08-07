import type { SqliteDatabase } from "../storage/database.js";
import { loadGlobalConfig } from "../config/paths.js";
import { ProjectService, type ProjectRecord } from "../projects/project-service.js";
import { indexProject, type IndexOptions, type IndexResult } from "../indexing/indexer.js";
import { searchProject, type SearchHit } from "../search/search-service.js";
import {
  listMemories,
  getMemory,
  remember,
  updateMemoryStatus,
  detectMemoryDrift,
  type MemoryRecord,
  memoryStatusSchema,
  memoryTypeSchema,
} from "../memory/memory-service.js";
import {
  acceptCandidate,
  generateFileCandidates,
  generateVersionControlCandidates,
  generateTaskCandidates,
  listCandidates,
  rejectCandidate,
  type IndexedSourceChange,
  type MemoryCandidate,
} from "../memory/candidate-service.js";
import type { GitSnapshot } from "../git/git-service.js";
import {
  captureVersionControlState,
  type VersionControlSnapshot,
} from "../vcs/vcs-service.js";
import { backupProjectDatabase, doctorProject, exportProject } from "../maintenance/maintenance-service.js";
import {
  checkpointTask,
  cancelTask,
  completeTask,
  listTasks,
  getTask,
  startTask,
  type TaskCheckpoint,
  type TaskRecord,
} from "../tasks/task-service.js";
import {
  buildProjectContext,
  DEFAULT_CONTEXT_BUDGET_TOKENS,
  type ProjectContext,
} from "../context/context-service.js";
import type { z } from "zod/v4";
import { ProjectContextError } from "../shared/errors.js";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import ignore from "ignore";
import { defaultIgnorePatterns } from "../indexing/file-policy.js";
import {
  UserMemoryService,
  type UserMemoryRecord,
  userMemoryScopeSchema,
  userMemorySourceKindSchema,
} from "../memory/user-memory-service.js";
import {
  DEFAULT_WATCH_DEBOUNCE_MS,
  ProjectWatchService,
  type ProjectWatchStatus,
} from "../indexing/watch-service.js";
import {
  backupEncrypted,
  decryptBackupToTemporary,
  readPassphraseEnvironment,
} from "../maintenance/encrypted-backup-service.js";
import {
  graphNeighbors,
  graphNodeDetails,
  graphOverview,
  graphSearch,
  type GraphOptions,
} from "../code-intelligence/graph-service.js";

export class ProjectContextApp {
  readonly projects: ProjectService;

  readonly userMemoryService: UserMemoryService;

  readonly allowedOutputRoots: string[];

  private constructor(config: Awaited<ReturnType<typeof loadGlobalConfig>>) {
    this.storageRoot = config.storageRoot;
    this.allowedOutputRoots = config.allowedOutputRoots;
    this.projects = new ProjectService(config.storageRoot, config.allowedProjectRoots, config.allowedOutputRoots);
    this.userMemoryService = new UserMemoryService(config.storageRoot);
  }

  readonly storageRoot: string;

  static async create(): Promise<ProjectContextApp> {
    const app = new ProjectContextApp(await loadGlobalConfig());
    try {
      await app.projects.migrateLegacyDatabases();
      return app;
    } catch (error) {
      app.close();
      throw error;
    }
  }

  async openProject(root: string): Promise<ProjectRecord> {
    return this.projects.open(root);
  }

  updateProject(projectId: string, name: string): ProjectRecord {
    return this.projects.update(projectId, { name });
  }

  archiveProject(projectId: string): ProjectRecord {
    return this.projects.archive(projectId);
  }

  unarchiveProject(projectId: string): ProjectRecord {
    return this.projects.unarchive(projectId);
  }

  async relocateProject(projectId: string, newRoot: string): Promise<ProjectRecord> {
    const activeWatch = projectWatches.list().find((watch) => watch.projectId === projectId);
    const project = await this.projects.relocate(projectId, newRoot);
    if (activeWatch) {
      projectWatches.stop(projectId);
      projectWatches.start(projectId, project.rootPath, activeWatch.debounceMs, false);
    }
    return project;
  }

  async reconcileMovedProjects(): Promise<ProjectRecord[]> {
    const activeWatches = new Map(projectWatches.list().map((watch) => [watch.projectId, watch]));
    const relocated = await this.projects.reconcileMovedProjects();
    for (const project of relocated) {
      const activeWatch = activeWatches.get(project.id);
      if (!activeWatch) continue;
      projectWatches.stop(project.id);
      projectWatches.start(project.id, project.rootPath, activeWatch.debounceMs, false);
    }
    return relocated;
  }

  async deleteProject(projectId: string, options: {
    confirmProjectId: string;
    purge?: boolean;
    backupDestination?: string;
  }): Promise<Record<string, unknown>> {
    if (options.purge && projectWatches.list().some((watch) => watch.projectId === projectId)) {
      throw new ProjectContextError("PROJECT_WATCH_ACTIVE", "Stop the project watcher before permanent deletion.");
    }
    return this.projects.delete(projectId, options);
  }

  async restoreProject(input: {
    source: string;
    root?: string;
    name?: string;
    projectId?: string;
    confirmProjectId?: string;
  }): Promise<Record<string, unknown>> {
    return this.projects.restore(input);
  }

  watchStart(projectId: string, debounceMs = DEFAULT_WATCH_DEBOUNCE_MS, initialIndex = true): ProjectWatchStatus {
    const project = this.projects.get(projectId);
    return projectWatches.start(projectId, project.rootPath, debounceMs, initialIndex);
  }

  watchStop(projectId: string): ProjectWatchStatus {
    return projectWatches.stop(projectId);
  }

  watchList(): ProjectWatchStatus[] {
    return projectWatches.list();
  }

  watchFlush(projectId: string): Promise<ProjectWatchStatus | null> {
    return projectWatches.flushPending(projectId);
  }

  rememberUser(input: {
    type: z.infer<typeof memoryTypeSchema>;
    title: string;
    content: string;
    reason?: string;
    confidence?: number;
    scopeLevel?: z.infer<typeof userMemoryScopeSchema>;
    projectId?: string;
    scopeRef?: string;
    sourceKind: z.infer<typeof userMemorySourceKindSchema>;
    supersedesId?: string;
  }): UserMemoryRecord {
    if (input.projectId) this.projects.get(input.projectId);
    return this.userMemoryService.remember(input);
  }

  userMemories(status = "active", limit = 50): UserMemoryRecord[] {
    return this.userMemoryService.list(status, limit);
  }

  allUserMemories(limit = 500): UserMemoryRecord[] {
    return this.userMemoryService.listAll(limit);
  }

  userMemory(memoryId: string): UserMemoryRecord {
    return this.userMemoryService.get(memoryId);
  }

  setUserMemoryStatus(
    memoryId: string,
    status: z.infer<typeof memoryStatusSchema>,
  ): UserMemoryRecord {
    return this.userMemoryService.updateStatus(memoryId, status);
  }

  async index(projectId: string, options: IndexOptions = {}): Promise<IndexResult & {
    symbols: number;
    relations: number;
    staleMemories: string[];
    generatedCandidates: MemoryCandidate[];
    git: Omit<GitSnapshot, "diff">;
    vcs: Omit<VersionControlSnapshot, "diff">;
  }> {
    const project = this.projects.get(projectId);
    if (activeIndexes.has(projectId)) {
      throw new ProjectContextError("INDEX_ALREADY_RUNNING", `An index run is already active for project: ${projectId}`);
    }
    activeIndexes.add(projectId);
    try {
      return await this.withDbAsync(projectId, async (db) => {
        const sourceHashes = new Map((db.prepare("SELECT path, content_hash FROM sources").all() as Array<{
          path: string; content_hash: string;
        }>).map((row) => [row.path, row.content_hash]));
        const result = await indexProject(db, project, options);
        const vcs = await captureVersionControlState(db, project.rootPath);
        const vcsCandidates = generateVersionControlCandidates(db, vcs);
        const vcsChangedPaths = new Set(vcs.changes.map((change) => change.path));
        const fileCandidates = generateFileCandidates(
          db,
          indexedSourceChanges(db, sourceHashes).filter((change) => !vcsChangedPaths.has(change.path)),
        );
        const generatedCandidates = [...vcsCandidates, ...fileCandidates];
        const staleMemories = detectMemoryDrift(db);
        const { diff: _diff, ...safeVcs } = vcs;
        const safeGit: Omit<GitSnapshot, "diff"> = {
          available: vcs.kind === "git",
          head: vcs.kind === "git" ? vcs.revision : null,
          branch: vcs.kind === "git" ? vcs.branch : null,
          changes: vcs.kind === "git" ? vcs.changes : [],
          diffHash: vcs.kind === "git" ? vcs.diffHash : null,
          capturedAt: vcs.capturedAt,
        };
        return {
          ...result,
          symbols: scalar(db, "SELECT COUNT(*) FROM symbols"),
          relations: scalar(db, "SELECT COUNT(*) FROM relations"),
          staleMemories,
          generatedCandidates,
          git: safeGit,
          vcs: safeVcs,
        };
      });
    } finally {
      activeIndexes.delete(projectId);
    }
  }

  async readProjectIgnore(projectId: string): Promise<{ content: string }> {
    const project = this.projects.get(projectId);
    try {
      return { content: await readFile(join(project.rootPath, ".project-context-ignore"), "utf8") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { content: "" };
      throw error;
    }
  }

  async previewProjectIgnore(projectId: string, content: string): Promise<{
    matchedCount: number;
    totalIndexed: number;
    samplePaths: string[];
  }> {
    validateProjectIgnore(content);
    const project = this.projects.get(projectId);
    const matcher = ignore().add(defaultIgnorePatterns(project.rootPath));
    try {
      matcher.add(await readFile(join(project.rootPath, ".gitignore"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      matcher.add(content.replace(/\r\n?/g, "\n"));
    } catch (error) {
      throw new ProjectContextError(
        "INVALID_PROJECT_IGNORE",
        `Project ignore rules are invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return this.withDb(projectId, (db) => {
      const paths = (db.prepare("SELECT path FROM sources ORDER BY path").all() as Array<{ path: string }>)
        .map((row) => row.path);
      const matched = paths.filter((path) => matcher.ignores(path));
      return { matchedCount: matched.length, totalIndexed: paths.length, samplePaths: matched.slice(0, 8) };
    });
  }

  async writeProjectIgnore(projectId: string, content: string): Promise<{
    content: string;
    index: Awaited<ReturnType<ProjectContextApp["index"]>>;
  }> {
    validateProjectIgnore(content);
    const project = this.projects.get(projectId);
    const normalized = content.replace(/\r\n?/g, "\n");
    const path = join(project.rootPath, ".project-context-ignore");
    const temporaryPath = join(project.rootPath, `.project-context-ignore.${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, normalized, { encoding: "utf8", flag: "wx" });
      await rename(temporaryPath, path);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return { content: normalized, index: await this.index(projectId) };
  }

  search(projectId: string, query: string, limit = 20): SearchHit[] {
    return this.withDb(projectId, (db) => searchProject(db, query, limit));
  }

  remember(projectId: string, input: {
    type: z.infer<typeof memoryTypeSchema>;
    title: string;
    content: string;
    reason?: string;
    status?: z.infer<typeof memoryStatusSchema>;
    confidence?: number;
    scope?: string[];
    sourceKind: string;
    sourceRef?: string;
    supersedesId?: string;
  }): MemoryRecord {
    return this.withDb(projectId, (db) => remember(db, input));
  }

  memories(projectId: string, status = "active", limit = 50): MemoryRecord[] {
    return this.withDb(projectId, (db) => listMemories(db, status, limit));
  }

  memory(projectId: string, memoryId: string): MemoryRecord {
    return this.withDb(projectId, (db) => getMemory(db, memoryId));
  }

  setMemoryStatus(
    projectId: string,
    memoryId: string,
    status: z.infer<typeof memoryStatusSchema>,
  ): MemoryRecord {
    return this.withDb(projectId, (db) => updateMemoryStatus(db, memoryId, status));
  }

  candidates(projectId: string, status = "pending", limit = 50): MemoryCandidate[] {
    return this.withDb(projectId, (db) => listCandidates(db, status, limit));
  }

  acceptCandidate(projectId: string, candidateId: string): MemoryRecord {
    return this.withDb(projectId, (db) => acceptCandidate(db, candidateId));
  }

  rejectCandidate(projectId: string, candidateId: string): MemoryCandidate {
    return this.withDb(projectId, (db) => rejectCandidate(db, candidateId));
  }

  startTask(projectId: string, goal: string): TaskRecord {
    return this.withDb(projectId, (db) => startTask(db, goal));
  }

  checkpoint(projectId: string, taskId: string, checkpoint: TaskCheckpoint): TaskRecord {
    return this.withDb(projectId, (db) => checkpointTask(db, taskId, checkpoint));
  }

  completeTask(projectId: string, taskId: string, checkpoint?: TaskCheckpoint): TaskRecord {
    return this.withDb(projectId, (db) => {
      const task = completeTask(db, taskId, checkpoint);
      generateTaskCandidates(db, task);
      return task;
    });
  }

  cancelTask(projectId: string, taskId: string): TaskRecord {
    return this.withDb(projectId, (db) => cancelTask(db, taskId));
  }

  tasks(projectId: string, status = "in_progress", limit = 20): TaskRecord[] {
    return this.withDb(projectId, (db) => listTasks(db, status, limit));
  }

  task(projectId: string, taskId: string): TaskRecord {
    return this.withDb(projectId, (db) => getTask(db, taskId));
  }

  source(projectId: string, sourceId: string): Record<string, unknown> {
    return this.withDb(projectId, (db) => {
      const source = db.prepare("SELECT * FROM sources WHERE id = ?").get(sourceId) as Record<string, unknown> | undefined;
      if (!source) throw new ProjectContextError("SOURCE_NOT_FOUND", `Unknown source: ${sourceId}`);
      const chunks = db.prepare(
        "SELECT id, content, start_line, end_line FROM chunks WHERE source_id = ? ORDER BY start_line",
      ).all(sourceId);
      return { source, chunks };
    });
  }

  context(projectId: string, task: string, budgetTokens = DEFAULT_CONTEXT_BUDGET_TOKENS): ProjectContext {
    const project = this.projects.get(projectId);
    const userMemories = this.userMemoryService.applicable(project, task);
    return this.withDb(projectId, (db) => buildProjectContext(db, project, task, budgetTokens, userMemories));
  }

  health(projectId: string): Record<string, unknown> {
    return this.withDb(projectId, (db) => {
      const vcsState = readVersionControlState(db);
      return {
        project: this.projects.get(projectId),
        sources: scalar(db, "SELECT COUNT(*) FROM sources"),
        chunks: scalar(db, "SELECT COUNT(*) FROM chunks"),
        symbols: scalar(db, "SELECT COUNT(*) FROM symbols"),
        relations: scalar(db, "SELECT COUNT(*) FROM relations"),
        memories: rowsToObject(db, "SELECT status, COUNT(*) AS count FROM memories GROUP BY status"),
        candidates: rowsToObject(db, "SELECT status, COUNT(*) AS count FROM memory_candidates GROUP BY status"),
        tasks: rowsToObject(db, "SELECT status, COUNT(*) AS count FROM tasks GROUP BY status"),
        schemaVersion: db.pragma("user_version", { simple: true }),
        vcsState,
        gitState: vcsState,
        lastIndexRun: db.prepare("SELECT * FROM index_runs ORDER BY started_at DESC LIMIT 1").get() ?? null,
      };
    });
  }

  portrait(projectId: string): Record<string, unknown> {
    return this.withDb(projectId, (db) => {
      const vcsState = readVersionControlState(db);
      const vcsCapturedAt = db.prepare("SELECT MAX(captured_at) FROM git_state").pluck().get() ?? null;
      const sources = db.prepare(`
        SELECT path, kind, size_bytes AS sizeBytes, indexed_at AS indexedAt
        FROM sources
        ORDER BY size_bytes DESC, path ASC
      `).all() as Array<{ path: string; kind: string; sizeBytes: number; indexedAt: string }>;
      const fileTypes = new Map<string, { count: number; bytes: number }>();
      for (const source of sources) {
        const extension = extname(source.path).toLowerCase() || "[no extension]";
        const current = fileTypes.get(extension) ?? { count: 0, bytes: 0 };
        current.count += 1;
        current.bytes += source.sizeBytes;
        fileTypes.set(extension, current);
      }
      return {
        project: this.projects.get(projectId),
        health: {
          sources: sources.length,
          chunks: scalar(db, "SELECT COUNT(*) FROM chunks"),
          symbols: scalar(db, "SELECT COUNT(*) FROM symbols"),
          relations: scalar(db, "SELECT COUNT(*) FROM relations"),
          schemaVersion: db.pragma("user_version", { simple: true }),
          lastIndexRun: db.prepare("SELECT * FROM index_runs ORDER BY started_at DESC LIMIT 1").get() ?? null,
        },
        statuses: {
          memories: rowsToObject(db, "SELECT status, COUNT(*) AS count FROM memories GROUP BY status"),
          candidates: rowsToObject(db, "SELECT status, COUNT(*) AS count FROM memory_candidates GROUP BY status"),
          tasks: rowsToObject(db, "SELECT status, COUNT(*) AS count FROM tasks GROUP BY status"),
        },
        vcsState,
        vcsCapturedAt,
        gitState: vcsState,
        gitCapturedAt: vcsCapturedAt,
        fileTypes: [...fileTypes.entries()]
          .map(([extension, totals]) => ({ extension, ...totals }))
          .sort((left, right) => right.count - left.count || right.bytes - left.bytes)
          .slice(0, 10),
        primarySources: sources.slice(0, 8),
        recentMemories: listMemories(db, "active", 6),
        staleMemories: listMemories(db, "stale", 6),
        activeTasks: listTasks(db, "in_progress", 6),
        completedTasks: listTasks(db, "completed", 4),
        pendingCandidates: listCandidates(db, "pending", 6),
        watch: this.watchList().find((item) => item.projectId === projectId) ?? null,
      };
    });
  }

  graphOverview(projectId: string, options: GraphOptions = {}): Record<string, unknown> {
    return this.withDb(projectId, (db) => graphOverview(db, options));
  }

  graphNeighbors(
    projectId: string,
    nodeId: string,
    options: GraphOptions & { depth?: number } = {},
  ): Record<string, unknown> {
    return this.withDb(projectId, (db) => graphNeighbors(db, nodeId, options));
  }

  graphSearch(projectId: string, query: string, limit = 20): Record<string, unknown> {
    return this.withDb(projectId, (db) => graphSearch(db, query, limit));
  }

  graphNode(projectId: string, nodeId: string): Record<string, unknown> {
    return this.withDb(projectId, (db) => graphNodeDetails(db, nodeId));
  }

  async doctor(projectId: string, repair = false) {
    const project = this.projects.get(projectId);
    return this.withDbAsync(projectId, (db) => doctorProject(db, project, repair));
  }

  async backup(projectId: string, destination: string) {
    return this.withDbAsync(projectId, (db) => backupProjectDatabase(db, destination, this.allowedOutputRoots));
  }

  async encryptedBackup(projectId: string, destination: string, passphraseEnv: string) {
    const passphrase = readPassphraseEnvironment(passphraseEnv);
    return this.withDbAsync(projectId, (db) => backupEncrypted(
      db,
      destination,
      this.allowedOutputRoots,
      passphrase,
    ));
  }

  async encryptedRestore(input: {
    source: string;
    passphraseEnv: string;
    root?: string;
    name?: string;
    projectId?: string;
    confirmProjectId?: string;
  }): Promise<Record<string, unknown>> {
    const passphrase = readPassphraseEnvironment(input.passphraseEnv);
    const decrypted = await decryptBackupToTemporary(input.source, this.allowedOutputRoots, passphrase);
    try {
      return await this.restoreProject({
        source: decrypted.temporary,
        ...(input.root ? { root: input.root } : {}),
        ...(input.name ? { name: input.name } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.confirmProjectId ? { confirmProjectId: input.confirmProjectId } : {}),
      });
    } finally {
      await rm(decrypted.temporary, { force: true });
    }
  }

  async export(projectId: string, outputDirectory: string) {
    const project = this.projects.get(projectId);
    return this.withDbAsync(projectId, (db) => exportProject(db, project, outputDirectory, this.allowedOutputRoots));
  }

  close(): void {
    this.userMemoryService.close();
    this.projects.close();
  }

  private withDb<T>(projectId: string, callback: (db: SqliteDatabase) => T): T {
    const db = this.projects.projectDatabase(projectId);
    try {
      return callback(db);
    } finally {
      db.close();
    }
  }

  private async withDbAsync<T>(
    projectId: string,
    callback: (db: SqliteDatabase) => Promise<T>,
  ): Promise<T> {
    const db = this.projects.projectDatabase(projectId);
    try {
      return await callback(db);
    } finally {
      db.close();
    }
  }
}

function validateProjectIgnore(content: string): void {
  if (Buffer.byteLength(content, "utf8") > 60_000 || content.includes("\0")) {
    throw new ProjectContextError("INVALID_PROJECT_IGNORE", "Project ignore rules are invalid or too large.");
  }
}

const activeIndexes = new Set<string>();
const projectWatches = new ProjectWatchService(async (projectId) => {
  const app = await ProjectContextApp.create();
  try {
    await app.index(projectId);
  } finally {
    app.close();
  }
});

export function stopAllProjectWatches(): void {
  projectWatches.stopAll();
}

function scalar(db: SqliteDatabase, sql: string): number {
  return (db.prepare(sql).pluck().get() as number | undefined) ?? 0;
}

function rowsToObject(db: SqliteDatabase, sql: string): Record<string, number> {
  const rows = db.prepare(sql).all() as Array<{ status: string; count: number }>;
  return Object.fromEntries(rows.map((row) => [row.status, row.count]));
}

function readVersionControlState(db: SqliteDatabase): Record<string, string> {
  const rows = db.prepare("SELECT key, value FROM git_state").all() as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function indexedSourceChanges(
  db: SqliteDatabase,
  previousHashes: Map<string, string>,
): IndexedSourceChange[] {
  const current = db.prepare("SELECT path, content_hash FROM sources").all() as Array<{
    path: string; content_hash: string;
  }>;
  return current.flatMap((source) => {
    const previousHash = previousHashes.get(source.path) ?? null;
    if (previousHash === source.content_hash) return [];
    const content = (db.prepare(
      "SELECT content FROM chunks WHERE source_path = ? ORDER BY start_line",
    ).pluck().all(source.path) as string[]).join("\n");
    return [{ path: source.path, previousHash, currentHash: source.content_hash, content }];
  });
}
