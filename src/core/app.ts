import { indexMigrationPreview } from "../maintenance/index-migration-preview.js";
import { checkMigrationSpace, migrationFailureMessage, type MigrationMode, type MigrationSpaceCheck } from "../maintenance/migration-space.js";
import type { SqliteDatabase } from "../storage/database.js";
import { loadGlobalConfig } from "../config/paths.js";
import { ProjectService, type ProjectRecord } from "../projects/project-service.js";
import { indexProject, type IndexOptions, type IndexResult } from "../indexing/indexer.js";
import { searchProject, type SearchHit } from "../search/search-service.js";
import { readSearchRanking, readSearchRankingSync, writeSearchRanking, type SearchRankingSettings } from "../search/search-ranking.js";
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
  cleanupDatabase, cleanupHistory, recentIndexRuns, listIndexRuns, indexLogQuerySchema, databaseUsage, maintenanceSettings, setMaintenancePolicy, runAutomaticMaintenance,
  type CleanupOptions, maintenancePolicySchema,
} from "../maintenance/storage-maintenance.js";
import {
  checkpointTask,
  cancelTask,
  completeTask,
  listTasks,
  getTask,
  startTask,
  listTaskHistory,
  type TaskCheckpoint,
  type TaskRecord,
} from "../tasks/task-service.js";
import { queryWorkspaceTasks, type TaskQueryInput } from "../tasks/task-query.js";
import {
  buildProjectContext,
  DEFAULT_CONTEXT_BUDGET_TOKENS,
  type ProjectContext,
} from "../context/context-service.js";
import type { z } from "zod/v4";
import { ProjectContextError } from "../shared/errors.js";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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

  unregisterMissingProject(projectId: string, confirmProjectId: string) {
    this.assertProjectMigrationIdle(projectId);
    const watch = projectWatches.list().find((item) => item.projectId === projectId);
    if (watch?.indexing) {
      throw new ProjectContextError("INDEX_ALREADY_RUNNING", "请等待当前索引完成后再移除项目登记。");
    }
    // Validate first so failed confirmation never interrupts a healthy watcher.
    this.projects.assertMissingRegistration(projectId, confirmProjectId);
    if (watch) projectWatches.stop(projectId);
    return this.projects.unregisterMissing(projectId, confirmProjectId);
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

  async index(projectId: string, options: IndexOptions = {}) {
    if (activeMigrations.has(projectId)) {
      throw new ProjectContextError("INDEX_MIGRATION_RUNNING", "Wait for the active index migration to finish.");
    }
    return this.indexInternal(projectId, options);
  }

  private async indexInternal(projectId: string, options: IndexOptions = {}): Promise<IndexResult & {
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
        // Maintenance failure must not turn an otherwise successful index into a failure.
        try { if (!activeMigrations.has(projectId)) runAutomaticMaintenance(db); }
        catch (error) { console.error("Automatic database maintenance:", error instanceof Error ? error.message : String(error)); }
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
    if (activeMigrations.has(projectId)) {
      throw new ProjectContextError("INDEX_MIGRATION_RUNNING", "Wait for the active index migration before changing ignore rules.");
    }
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

  async searchRanking(projectId: string): Promise<SearchRankingSettings> {
    return readSearchRanking(this.projects.get(projectId).rootPath);
  }

  async setSearchRanking(projectId: string, settings: unknown): Promise<SearchRankingSettings> {
    return writeSearchRanking(this.projects.get(projectId).rootPath, settings);
  }

  search(projectId: string, query: string, limit = 20): SearchHit[] {
    const project = this.projects.get(projectId);
    return this.withDb(projectId, (db) => searchProject(db, query, limit, readSearchRankingSync(project.rootPath)));
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

  startTask(projectId: string, goal: string, options: { source?: string } = {}): TaskRecord {
    return this.withDb(projectId, (db) => startTask(db, goal, options));
  }

  checkpoint(projectId: string, taskId: string, checkpoint: TaskCheckpoint, options: { requestId?: string; source?: string } = {}): TaskRecord {
    return this.withDb(projectId, (db) => checkpointTask(db, taskId, checkpoint, options));
  }

  completeTask(projectId: string, taskId: string, checkpoint?: TaskCheckpoint, options: { source?: string } = {}): TaskRecord {
    return this.withDb(projectId, (db) => {
      const task = completeTask(db, taskId, checkpoint, options);
      generateTaskCandidates(db, task);
      return task;
    });
  }

  cancelTask(projectId: string, taskId: string, options: { source?: string } = {}): TaskRecord {
    return this.withDb(projectId, (db) => cancelTask(db, taskId, options));
  }

  tasks(projectId: string, status = "in_progress", limit = 20): TaskRecord[] {
    return this.withDb(projectId, (db) => listTasks(db, status, limit));
  }

  task(projectId: string, taskId: string): TaskRecord {
    return this.withDb(projectId, (db) => getTask(db, taskId));
  }

  queryTasks(input: TaskQueryInput = {}) {
    return queryWorkspaceTasks(this.projects.list(true), (projectId) => this.projects.projectDatabase(projectId), input);
  }

  taskHistory(projectId: string, taskId: string, options: { limit?: number; offset?: number } = {}) {
    return this.withDb(projectId, (db) => listTaskHistory(db, taskId, options));
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

  storageUsage(projectId: string) {
    return this.withDb(projectId, (db) => ({
      ...databaseUsage(db), policy: maintenanceSettings(db),
      cleanupHistory: cleanupHistory(db), recentIndexRuns: recentIndexRuns(db),
    }));
  }

  indexLogs(projectId: string, options: z.input<typeof indexLogQuerySchema> = {}) {
    return this.withDb(projectId, (db) => listIndexRuns(db, options));
  }

  cleanupProject(projectId: string, options: CleanupOptions & { confirmProjectId?: string | undefined } = {}) {
    this.projects.get(projectId);
    if (options.dryRun === false && options.confirmProjectId !== projectId) {
      throw new ProjectContextError("CLEANUP_CONFIRMATION_REQUIRED", "Pass the exact project ID to confirm database cleanup.");
    }
    if (options.dryRun === false && (activeIndexes.has(projectId) || activeMigrations.has(projectId))) {
      throw new ProjectContextError("INDEX_ALREADY_RUNNING", "Wait for the active index run to finish before database cleanup.");
    }
    return this.withDb(projectId, (db) => cleanupDatabase(db, options));
  }

  maintenanceSettings(projectId: string) {
    return this.withDb(projectId, (db) => maintenanceSettings(db));
  }

  setMaintenanceSettings(projectId: string, policy: z.input<typeof maintenancePolicySchema>) {
    return this.withDb(projectId, (db) => setMaintenancePolicy(db, policy));
  }

  async backup(projectId: string, destination: string) {
    return this.withDbAsync(projectId, (db) => backupProjectDatabase(db, destination, this.allowedOutputRoots));
  }

  indexMigrationPreview(projectId: string) {
    return this.withDb(projectId, (db) => indexMigrationPreview(db));
  }

  assertProjectMigrationIdle(projectId: string): void {
    this.projects.get(projectId);
    if (activeIndexes.has(projectId) || activeMigrations.has(projectId)) {
      throw new ProjectContextError("INDEX_ALREADY_RUNNING", "请等待当前索引或升级完成，再启动后台任务。");
    }
  }

  async migrationSpaceCheck(projectId: string, mode: MigrationMode = "upgrade") {
    const usage = this.storageUsage(projectId);
    return checkMigrationSpace({ ...usage, backupDirectory: join(this.allowedOutputRoots[0]!, "backups"), mode });
  }

  async compactProjectIndex(projectId: string) {
    this.projects.get(projectId);
    if (activeIndexes.has(projectId) || activeMigrations.has(projectId)) {
      throw new ProjectContextError("INDEX_ALREADY_RUNNING", "请等待当前索引或升级完成后再回收空间。");
    }
    activeMigrations.add(projectId);
    let phase = "preflight";
    let spaceCheck: MigrationSpaceCheck | undefined;
    try {
      const before = this.storageUsage(projectId);
      spaceCheck = await this.migrationSpaceCheck(projectId, "compact");
      if (!spaceCheck.sufficient) throw new Error("可用磁盘空间不足或无法验证，尚未开始空间回收。请检查空间预检中的路径。");
      phase = "compaction";
      const warnings: string[] = [];
      let vacuumCompleted = false;
      let checkpointBusy = false;
      // Deliberately bypass cleanupDatabase: retry must not back up, reindex or prune logs.
      this.withDb(projectId, db => {
        try {
          const checkpoint = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number }>;
          checkpointBusy = checkpoint.some(row => row.busy !== 0);
          if (!checkpointBusy) {
            db.exec("VACUUM");
            vacuumCompleted = true;
            phase = "checkpoint";
            checkpointBusy = (db.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number }>).some(row => row.busy !== 0);
          }
          if (checkpointBusy) warnings.push("其他数据库连接正在占用 WAL，空间回收尚未完成，请等待其他 MCP 或 Web 进程空闲后重试。");
        } catch (error) { warnings.push(migrationFailureMessage(error)); }
      });
      const after = this.storageUsage(projectId);
      const completed = vacuumCompleted && !checkpointBusy && warnings.length === 0;
      return {
        projectId, status: completed ? "completed" : "partial", warnings, before, after,
        reclaimedBytes: Math.max(0, before.totalBytes - after.totalBytes), byteChange: after.totalBytes - before.totalBytes,
        canRetryCompaction: !completed, phase: completed ? "completed" : phase, spaceCheck,
        vacuumCompleted, checkpointBusy,
      };
    } catch (error) {
      throw new ProjectContextError("INDEX_COMPACTION_FAILED", `空间回收未完成（${migrationPhaseLabel(phase)}）：${migrationFailureMessage(error)}`, {
        phase, spaceCheck, backupDestination: null, backupCompleted: false, ignoreRulesSaved: false, indexCompleted: false, canRetryCompaction: true,
      });
    } finally { activeMigrations.delete(projectId); }
  }

  async optimizeProjectIndex(projectId: string, excludeDirectories: string[] = []): Promise<Record<string, unknown>> {
    const project = this.projects.get(projectId);
    if (activeIndexes.has(projectId) || activeMigrations.has(projectId)) {
      throw new ProjectContextError("INDEX_ALREADY_RUNNING", "Wait for the active index run or migration to finish before migration.");
    }
    activeMigrations.add(projectId);
    let backupDestination: string | undefined;
    let backupCompleted = false;
    let ignoreRulesSaved = false;
    let indexCompleted = false;
    let phase = "validation";
    let spaceCheck: MigrationSpaceCheck | undefined;
    try {
      const selectedDirectories = [...new Set(excludeDirectories)];
      if (selectedDirectories.length) {
        const available = new Set(this.indexMigrationPreview(projectId).directories.map((item) => item.path));
        if (selectedDirectories.some((path) => !available.has(path) || !safeMigrationDirectory(path))) {
          throw new ProjectContextError("INVALID_MIGRATION_EXCLUSION", "Select only directories listed in the current index migration preview.");
        }
      }
      const before = this.storageUsage(projectId);
      phase = "preflight";
      spaceCheck = await this.migrationSpaceCheck(projectId);
      if (!spaceCheck.sufficient) throw new Error("可用磁盘空间不足或无法验证，尚未创建备份或修改忽略规则。请检查空间预检中的路径。");
      const destination = join(this.allowedOutputRoots[0]!, "backups", `${project.id}-pre-index-migration-${Date.now()}-${randomUUID()}.db`);
      backupDestination = destination;
      phase = "backup";
      const backup = await this.backup(projectId, destination);
      backupCompleted = true;
      let retainedBackupBytes = (await stat(destination)).size;
      phase = "ignore_rules";
      if (selectedDirectories.length) {
        const original = (await this.readProjectIgnore(projectId)).content;
        const addedRules = selectedDirectories.map((path) => `/${path}/**`);
        const content = `${original.replace(/\r\n?/g, "\n")}\n\n# Directories excluded by index migration (source files are preserved)\n${addedRules.join("\n")}\n`;
        validateProjectIgnore(content);
        const target = join(project.rootPath, ".project-context-ignore");
        const temporary = join(project.rootPath, `.project-context-ignore.${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
          await rename(temporary, target);
          ignoreRulesSaved = true;
        } finally {
          await rm(temporary, { force: true }).catch(() => undefined);
        }
      }
      phase = "index";
      const index = await this.indexInternal(projectId);
      indexCompleted = index.errors.length === 0;
      phase = "compaction";
      const cleanup = this.withDb(projectId, (db) => cleanupDatabase(db, { dryRun: false, vacuum: true, retentionDays: 30 }));
      // Read again after cleanup closes its connection and persists its final history entry.
      const after = this.storageUsage(projectId);
      const warnings = cleanup.warnings.map(migrationFailureMessage);
      if (index.errors.length) warnings.push(`Index migration encountered ${index.errors.length} file error(s); review index.errors and retry.`);
      if (!cleanup.vacuumCompleted) warnings.push("Database compaction did not complete; retry space reclamation when other connections are idle.");
      if (cleanup.checkpointBusy) warnings.push("WAL truncation is pending because another database connection is active.");
      let completed = index.errors.length === 0 && cleanup.vacuumCompleted && !cleanup.checkpointBusy && warnings.length === 0;
      let integrity: string | null = null;
      let backupStatus: "deleted" | "retained" = "retained";
      let backupDeletedBytes = 0;
      phase = !indexCompleted ? "index" : cleanup.checkpointBusy ? "checkpoint" : "compaction";
      if (completed) {
        phase = "integrity";
        try {
          integrity = this.withDb(projectId, db => String(db.pragma("quick_check", { simple: true })));
          if (integrity !== "ok") {
            completed = false;
            warnings.push(`升级后的数据库完整性检查未通过，保留迁移备份：${integrity}`);
          }
        } catch (error) {
          completed = false;
          warnings.push(`无法完成数据库完整性检查，保留迁移备份：${migrationFailureMessage(error)}`);
        }
      }
      if (completed) {
        phase = "backup_cleanup";
        try {
          // This exact path was created by this invocation. Never scan or prune historical backups.
          const backupBytes = (await stat(destination)).size;
          await rm(destination);
          backupDeletedBytes = backupBytes;
          retainedBackupBytes = 0;
          backupStatus = "deleted";
          phase = "completed";
        } catch (error) {
          completed = false;
          warnings.push(`索引和压缩已完成，但本次迁移备份未能删除，请检查备份路径：${migrationFailureMessage(error)}`);
        }
      }
      return {
        projectId, status: completed ? "completed" : "partial", warnings: [...new Set(warnings)],
        backup, backupDestination, backupStatus, backupDeletedBytes, retainedBackupBytes, integrity, index, cleanup, before, after,
        reclaimedBytes: Math.max(0, before.totalBytes - after.totalBytes),
        byteChange: after.totalBytes - before.totalBytes,
        excludeDirectories: selectedDirectories, ignoreRulesSaved, backupCompleted, indexCompleted, phase, spaceCheck,
        canRetryCompaction: indexCompleted && (!cleanup.vacuumCompleted || cleanup.checkpointBusy),
        notes: [
          "Reclaimed bytes compare the active database, WAL and SHM across the entire migration; retained backups are excluded.",
          backupStatus === "deleted" ? "本次临时迁移备份在完整升级和完整性检查成功后已删除；历史及手工备份不受影响。" : "本次迁移备份保留以便恢复；仅重试空间回收不会自动删除历史备份。",
          ...(ignoreRulesSaved ? ["Selected directory exclusions were saved to .project-context-ignore; source files were preserved."] : []),
        ],
      };
    } catch (error) {
      if (phase === "validation") throw error;
      throw new ProjectContextError("INDEX_MIGRATION_FAILED", `索引升级未完成（${migrationPhaseLabel(phase)}）：${migrationFailureMessage(error)}`, {
        phase, backupDestination: backupDestination ?? null, backupCompleted, ignoreRulesSaved, indexCompleted, spaceCheck,
        canRetryCompaction: indexCompleted,
        recovery: backupCompleted ? "已完成的数据库备份仍保留。索引已成功更新时可仅重试空间回收；否则检查已保存的忽略规则后再升级。" : "备份尚未完成，请保留当前数据库，释放空间后重试。",
      });
    } finally {
      activeMigrations.delete(projectId);
    }
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

function migrationPhaseLabel(phase: string): string {
  return ({ preflight: "空间检查", backup: "数据库备份", ignore_rules: "保存忽略规则", index: "更新索引", compaction: "压缩数据库", checkpoint: "回收 WAL", integrity: "检查数据库完整性", backup_cleanup: "清理本次迁移备份", completed: "完成" } as Record<string, string>)[phase] ?? phase;
}

function validateProjectIgnore(content: string): void {
  if (Buffer.byteLength(content, "utf8") > 60_000 || content.includes("\0")) {
    throw new ProjectContextError("INVALID_PROJECT_IGNORE", "Project ignore rules are invalid or too large.");
  }
}

function safeMigrationDirectory(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.endsWith("/") &&
    !/[\\*?!#\[\]\r\n\0]/.test(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part === part.trim());
}

const activeMigrations = new Set<string>();
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
