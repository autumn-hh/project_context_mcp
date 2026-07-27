import { basename, dirname, join, normalize, resolve } from "node:path";
import { access, copyFile, mkdir, readdir, realpath, rename, rm, rmdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import type { SqliteDatabase } from "../storage/database.js";
import { openDatabase } from "../storage/database.js";
import { migrateProject, migrateRegistry, PROJECT_SCHEMA_VERSION } from "../storage/schema.js";
import { createId, nowIso } from "../shared/ids.js";
import { ProjectContextError } from "../shared/errors.js";
import { authorizeExistingPath, authorizeOutputPath } from "../security/path-policy.js";
import { detectVersionControlRemote } from "../vcs/vcs-service.js";

const PROJECT_STORAGE_LAYOUT = "project-root";
const PROJECT_DATA_DIRECTORY = ".project-context";
const PROJECT_ID_METADATA_KEY = "project_id";
const DISCOVERY_IGNORED_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", "node_modules", "dist", "build", "coverage",
]);

export interface ProjectRecord {
  id: string;
  name: string;
  rootPath: string;
  remoteUrl: string | null;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  archivedAt: string | null;
}

interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  remote_url: string | null;
  created_at: string;
  updated_at: string;
  last_opened_at: string;
  archived_at: string | null;
  storage_layout: string | null;
}

export interface ProjectDatabaseMigration {
  projectId: string;
  source: string;
  destination: string;
  safetyBackup: string | null;
}

export class ProjectService {
  private readonly registry: SqliteDatabase;

  constructor(
    private readonly storageRoot: string,
    private readonly allowedProjectRoots: string[],
    private readonly allowedOutputRoots: string[] = [],
  ) {
    this.registry = openDatabase(join(storageRoot, "registry.db"));
    migrateRegistry(this.registry);
  }

  async open(rootInput: string): Promise<ProjectRecord> {
    const rootPath = await realpath(resolve(rootInput)).catch(() => {
      throw new ProjectContextError("PROJECT_NOT_FOUND", `Project root does not exist: ${rootInput}`);
    });
    const normalized = normalize(rootPath);
    const timestamp = nowIso();
    const existing = this.registry.prepare("SELECT * FROM projects WHERE root_path = ?")
      .get(normalized) as ProjectRow | undefined;
    if (existing) {
      await this.migrateLegacyDatabase(existing);
      this.ensureProjectIdentity(existing.id, normalized);
      this.registry.prepare("UPDATE projects SET last_opened_at = ?, updated_at = ? WHERE id = ?")
        .run(timestamp, timestamp, existing.id);
      return { ...mapProject(existing), updatedAt: timestamp, lastOpenedAt: timestamp };
    }

    if (this.allowedProjectRoots.length === 0) {
      throw new ProjectContextError(
        "PROJECT_ROOT_NOT_AUTHORIZED",
        "New project registration is disabled until an allowed project root is configured.",
      );
    }
    await authorizeExistingPath(normalized, this.allowedProjectRoots, "PROJECT_ROOT_NOT_AUTHORIZED", "Project root");

    const remoteUrl = await detectVersionControlRemote(normalized);
    if (remoteUrl) {
      const byRemote = this.registry.prepare("SELECT * FROM projects WHERE remote_url = ?")
        .get(remoteUrl) as ProjectRow | undefined;
      if (byRemote && !(await pathExists(byRemote.root_path))) {
        const previousDatabase = await this.moveDatabaseToRoot(byRemote, normalized);
        this.registry.prepare(
          "UPDATE projects SET root_path = ?, storage_layout = ?, updated_at = ?, last_opened_at = ? WHERE id = ?",
        ).run(normalized, PROJECT_STORAGE_LAYOUT, timestamp, timestamp, byRemote.id);
        if (previousDatabase) await removeDatabaseFile(previousDatabase);
        return { ...mapProject(byRemote), rootPath: normalized, updatedAt: timestamp, lastOpenedAt: timestamp };
      }
    }

    const project: ProjectRecord = {
      id: createId("prj"),
      name: basename(normalized),
      rootPath: normalized,
      remoteUrl,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastOpenedAt: timestamp,
      archivedAt: null,
    };
    const target = this.projectDatabasePathForRoot(project.rootPath);
    const targetExisted = await pathExists(target);
    if (targetExisted) validateBackupSource(target);
    const db = openDatabase(target);
    try {
      migrateProject(db);
      validateOpenDatabase(db);
    } finally {
      db.close();
    }
    try {
      this.registry.prepare(`
        INSERT INTO projects (
          id, name, root_path, remote_url, created_at, updated_at, last_opened_at, storage_layout
        ) VALUES (@id, @name, @rootPath, @remoteUrl, @createdAt, @updatedAt, @lastOpenedAt, '${PROJECT_STORAGE_LAYOUT}')
      `).run(project);
      this.ensureProjectIdentity(project.id, project.rootPath, true);
    } catch (error) {
      this.registry.prepare("DELETE FROM projects WHERE id = ?").run(project.id);
      if (!targetExisted) {
        await removeDatabaseFile(target);
        await removeEmptyDirectory(dirname(target));
      }
      throw error;
    }
    return project;
  }

  async migrateLegacyDatabases(): Promise<ProjectDatabaseMigration[]> {
    const rows = this.registry.prepare("SELECT * FROM projects WHERE storage_layout IS NULL")
      .all() as ProjectRow[];
    const migrations: ProjectDatabaseMigration[] = [];
    for (const row of rows) {
      const migration = await this.migrateLegacyDatabase(row);
      if (migration) migrations.push(migration);
    }
    this.backfillProjectIdentities();
    return migrations;
  }

  async reconcileMovedProjects(): Promise<ProjectRecord[]> {
    this.backfillProjectIdentities();
    const missing = this.registry.prepare("SELECT * FROM projects WHERE storage_layout = ?")
      .all(PROJECT_STORAGE_LAYOUT) as ProjectRow[];
    const missingRows: ProjectRow[] = [];
    for (const row of missing) {
      if (!(await pathExists(row.root_path))) missingRows.push(row);
    }
    if (missingRows.length === 0 || this.allowedProjectRoots.length === 0) return [];

    const candidates = await discoverProjectDatabases(this.allowedProjectRoots);
    const relocated: ProjectRecord[] = [];
    for (const row of missingRows) {
      const matches = candidates.filter((candidate) => candidate.projectId === row.id);
      if (matches.length !== 1) continue;
      const candidate = matches[0]!;
      const conflict = this.registry.prepare("SELECT id FROM projects WHERE root_path = ? AND id <> ?")
        .get(candidate.rootPath, row.id) as { id: string } | undefined;
      if (conflict) continue;

      await this.relocate(row.id, candidate.rootPath);
      if (row.name === basename(row.root_path)) {
        this.registry.prepare("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?")
          .run(basename(candidate.rootPath), nowIso(), row.id);
      }
      relocated.push(this.get(row.id));
    }
    return relocated;
  }

  get(projectId: string): ProjectRecord {
    const row = this.registry.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow | undefined;
    if (!row) throw new ProjectContextError("PROJECT_NOT_FOUND", `Unknown project: ${projectId}`);
    return mapProject(row);
  }

  list(includeArchived = false): ProjectRecord[] {
    const rows = this.registry.prepare(`
      SELECT * FROM projects
      WHERE archived_at IS NULL OR ? = 1
      ORDER BY last_opened_at DESC
    `).all(includeArchived ? 1 : 0) as ProjectRow[];
    return rows.map(mapProject);
  }

  update(projectId: string, input: { name: string }): ProjectRecord {
    this.getIfRegistered(projectId);
    const name = input.name.trim();
    if (!name) throw new ProjectContextError("INVALID_PROJECT_NAME", "Project name cannot be empty.");
    this.registry.prepare("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?")
      .run(name, nowIso(), projectId);
    return this.get(projectId);
  }

  archive(projectId: string): ProjectRecord {
    this.getIfRegistered(projectId);
    const timestamp = nowIso();
    this.registry.prepare("UPDATE projects SET archived_at = COALESCE(archived_at, ?), updated_at = ? WHERE id = ?")
      .run(timestamp, timestamp, projectId);
    return this.get(projectId);
  }

  unarchive(projectId: string): ProjectRecord {
    this.getIfRegistered(projectId);
    this.registry.prepare("UPDATE projects SET archived_at = NULL, updated_at = ? WHERE id = ?")
      .run(nowIso(), projectId);
    return this.get(projectId);
  }

  async relocate(projectId: string, newRootInput: string): Promise<ProjectRecord> {
    const current = this.get(projectId);
    const currentRow = this.getRow(projectId);
    const newRoot = await authorizeExistingPath(
      normalize(resolve(newRootInput)),
      this.allowedProjectRoots,
      "PROJECT_ROOT_NOT_AUTHORIZED",
      "Project root",
    );
    const conflict = this.registry.prepare("SELECT id FROM projects WHERE root_path = ? AND id <> ?")
      .get(newRoot, projectId) as { id: string } | undefined;
    if (conflict) {
      throw new ProjectContextError("PROJECT_ROOT_ALREADY_REGISTERED", `Project root is already registered: ${newRoot}`);
    }
    const previousDatabase = await this.moveDatabaseToRoot(currentRow, newRoot);
    this.ensureProjectIdentity(projectId, newRoot);
    const remoteUrl = await detectVersionControlRemote(newRoot);
    const timestamp = nowIso();
    this.registry.prepare(`
      UPDATE projects
      SET root_path = ?, remote_url = ?, storage_layout = ?, updated_at = ?, last_opened_at = ?
      WHERE id = ?
    `).run(newRoot, remoteUrl, PROJECT_STORAGE_LAYOUT, timestamp, timestamp, projectId);
    if (previousDatabase) await removeDatabaseFile(previousDatabase);
    return { ...current, rootPath: newRoot, remoteUrl, updatedAt: timestamp, lastOpenedAt: timestamp };
  }

  async delete(projectId: string, options: {
    confirmProjectId: string;
    purge?: boolean;
    backupDestination?: string;
  }): Promise<Record<string, unknown>> {
    const project = this.get(projectId);
    const databasePath = this.projectDatabasePath(projectId);
    if (options.confirmProjectId !== projectId) {
      throw new ProjectContextError("PROJECT_DELETE_CONFIRMATION_MISMATCH", "confirmProjectId must exactly match projectId.");
    }
    if (!project.archivedAt) {
      throw new ProjectContextError("PROJECT_NOT_ARCHIVED", "Archive the project before requesting deletion.");
    }
    const db = this.projectDatabase(projectId);
    const counts = {
      activeMemories: scalar(db, "SELECT COUNT(*) FROM memories WHERE status = 'active'"),
      inProgressTasks: scalar(db, "SELECT COUNT(*) FROM tasks WHERE status = 'in_progress'"),
      pendingCandidates: scalar(db, "SELECT COUNT(*) FROM memory_candidates WHERE status = 'pending'"),
    };
    if (!options.purge) {
      db.close();
      return { project, counts, purgeRequired: true, deleted: false };
    }
    if (Object.values(counts).some((count) => count > 0)) {
      db.close();
      throw new ProjectContextError(
        "PROJECT_DELETE_BLOCKED",
        "Project deletion requires zero active memories, in-progress tasks, and pending candidates.",
        counts,
      );
    }
    let backupDestination: string | null = null;
    try {
      if (options.backupDestination) {
        backupDestination = await authorizeOutputPath(options.backupDestination, this.allowedOutputRoots);
        await ensureAbsent(backupDestination, "OUTPUT_EXISTS");
        await mkdir(dirname(backupDestination), { recursive: true });
        await db.backup(backupDestination);
      }
    } finally {
      db.close();
    }
    await removeDatabaseFile(databasePath);
    await removeEmptyDirectory(dirname(databasePath));
    this.registry.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    return { projectId, deleted: true, purged: true, backupDestination, deletedAt: nowIso() };
  }

  async restore(input: {
    source: string;
    root?: string;
    name?: string;
    projectId?: string;
    confirmProjectId?: string;
  }): Promise<Record<string, unknown>> {
    const source = await authorizeExistingPath(
      input.source,
      this.allowedOutputRoots,
      "BACKUP_SOURCE_NOT_AUTHORIZED",
      "Backup source",
    );
    validateBackupSource(source);
    if (input.projectId) return this.restoreExisting(source, input.projectId, input.confirmProjectId);
    if (!input.root) {
      throw new ProjectContextError("RESTORE_ROOT_REQUIRED", "A project root is required when restoring a new project.");
    }
    return this.restoreNew(source, input.root, input.name);
  }

  projectDatabase(projectId: string): SqliteDatabase {
    const databasePath = this.projectDatabasePath(projectId);
    if (!existsSync(databasePath)) {
      throw new ProjectContextError("PROJECT_DATABASE_NOT_FOUND", `Project database does not exist: ${databasePath}`);
    }
    const db = openDatabase(databasePath);
    migrateProject(db);
    return db;
  }

  close(): void {
    this.registry.close();
  }

  private getIfRegistered(projectId: string): void {
    this.getRow(projectId);
  }

  private getRow(projectId: string): ProjectRow {
    const row = this.registry.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow | undefined;
    if (!row) throw new ProjectContextError("PROJECT_NOT_FOUND", `Unknown project: ${projectId}`);
    return row;
  }

  private projectDatabasePath(projectId: string): string {
    const row = this.getRow(projectId);
    if (row.storage_layout === PROJECT_STORAGE_LAYOUT) return this.projectDatabasePathForRoot(row.root_path);
    if (row.storage_layout === null) return this.legacyProjectDatabasePath(projectId);
    throw new ProjectContextError(
      "UNSUPPORTED_PROJECT_STORAGE_LAYOUT",
      `Unsupported project storage layout: ${row.storage_layout}`,
    );
  }

  private projectDatabasePathForRoot(rootPath: string): string {
    return join(rootPath, PROJECT_DATA_DIRECTORY, "project.db");
  }

  private legacyProjectDatabasePath(projectId: string): string {
    return join(this.storageRoot, "projects", projectId, "project.db");
  }

  private async migrateLegacyDatabase(row: ProjectRow): Promise<ProjectDatabaseMigration | null> {
    if (row.storage_layout === PROJECT_STORAGE_LAYOUT) return null;
    if (!(await pathExists(row.root_path))) return null;

    const source = this.legacyProjectDatabasePath(row.id);
    const destination = this.projectDatabasePathForRoot(row.root_path);
    const sourceExists = await pathExists(source);
    const destinationExists = await pathExists(destination);
    if (!sourceExists && !destinationExists) {
      throw new ProjectContextError(
        "PROJECT_DATABASE_NOT_FOUND",
        `Legacy project database does not exist: ${source}`,
      );
    }

    await mkdir(dirname(destination), { recursive: true });
    if (!sourceExists) {
      validateProjectDatabaseFile(destination);
      this.registry.prepare("UPDATE projects SET storage_layout = ?, updated_at = ? WHERE id = ?")
        .run(PROJECT_STORAGE_LAYOUT, nowIso(), row.id);
      return { projectId: row.id, source, destination, safetyBackup: null };
    }

    const timestamp = fileTimestamp();
    const recoveryDirectory = join(this.storageRoot, "recovery");
    const safetyBackup = join(recoveryDirectory, `${row.id}-pre-project-layout-${timestamp}.db`);
    const temporary = join(dirname(destination), `.project-db-migration-${timestamp}.tmp`);
    await mkdir(recoveryDirectory, { recursive: true });
    await snapshotProjectDatabase(source, safetyBackup);
    await snapshotProjectDatabase(source, temporary);

    try {
      if (destinationExists) {
        const displaced = join(recoveryDirectory, `${row.id}-displaced-project-layout-${timestamp}.db`);
        await snapshotProjectDatabase(destination, displaced);
        await removeDatabaseFile(destination);
      }
      await rename(temporary, destination);
      validateProjectDatabaseFile(destination);
      this.registry.prepare("UPDATE projects SET storage_layout = ?, updated_at = ? WHERE id = ?")
        .run(PROJECT_STORAGE_LAYOUT, nowIso(), row.id);
      await removeDatabaseFile(source);
      await removeEmptyDirectory(dirname(source));
      return { projectId: row.id, source, destination, safetyBackup };
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async moveDatabaseToRoot(row: ProjectRow, newRoot: string): Promise<string | null> {
    const source = row.storage_layout === PROJECT_STORAGE_LAYOUT
      ? this.projectDatabasePathForRoot(row.root_path)
      : this.legacyProjectDatabasePath(row.id);
    const destination = this.projectDatabasePathForRoot(newRoot);
    if (normalize(resolve(source)) === normalize(resolve(destination))) return null;

    const sourceExists = await pathExists(source);
    const destinationExists = await pathExists(destination);
    if (destinationExists) {
      validateProjectDatabaseFile(destination);
      if (sourceExists) {
        throw new ProjectContextError(
          "PROJECT_DATABASE_DESTINATION_EXISTS",
          `The new project root already contains a Project Context database: ${destination}`,
        );
      }
      return null;
    }
    if (!sourceExists) {
      throw new ProjectContextError("PROJECT_DATABASE_NOT_FOUND", `Project database does not exist: ${source}`);
    }

    await mkdir(dirname(destination), { recursive: true });
    const temporary = join(dirname(destination), `.project-db-relocate-${fileTimestamp()}.tmp`);
    try {
      await snapshotProjectDatabase(source, temporary);
      await rename(temporary, destination);
      validateProjectDatabaseFile(destination);
      return source;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async restoreExisting(
    source: string,
    projectId: string,
    confirmProjectId?: string,
  ): Promise<Record<string, unknown>> {
    const project = this.get(projectId);
    if (confirmProjectId !== projectId) {
      throw new ProjectContextError("PROJECT_RESTORE_CONFIRMATION_MISMATCH", "confirmProjectId must exactly match projectId.");
    }
    if (!project.archivedAt) {
      throw new ProjectContextError("PROJECT_NOT_ARCHIVED", "Archive the project before restoring over it.");
    }
    const directory = dirname(this.projectDatabasePath(projectId));
    await mkdir(directory, { recursive: true });
    const target = this.projectDatabasePath(projectId);
    const timestamp = fileTimestamp();
    const temporary = join(directory, `.restore-${timestamp}.db`);
    const previous = join(directory, `.pre-restore-${timestamp}.db`);
    const recoveryDirectory = join(this.storageRoot, "recovery");
    const safetyBackup = join(recoveryDirectory, `${projectId}-${timestamp}.db`);
    await copyAndMigrateBackup(source, temporary);
    await mkdir(recoveryDirectory, { recursive: true });
    const current = this.projectDatabase(projectId);
    try {
      await current.backup(safetyBackup);
    } finally {
      current.close();
    }
    try {
      await rename(target, previous);
      await removeSqliteSidecars(target);
      try {
        await rename(temporary, target);
      } catch (error) {
        await rename(previous, target);
        throw error;
      }
      await rm(previous, { force: true });
    } finally {
      await rm(temporary, { force: true });
    }
    const db = this.projectDatabase(projectId);
    try {
      validateOpenDatabase(db);
    } finally {
      db.close();
    }
    const now = nowIso();
    this.registry.prepare("UPDATE projects SET archived_at = NULL, updated_at = ?, last_opened_at = ? WHERE id = ?")
      .run(now, now, projectId);
    return { project: this.get(projectId), restored: true, replacedExisting: true, safetyBackup };
  }

  private async restoreNew(source: string, rootInput: string, nameInput?: string): Promise<Record<string, unknown>> {
    const rootPath = await authorizeExistingPath(
      normalize(resolve(rootInput)),
      this.allowedProjectRoots,
      "PROJECT_ROOT_NOT_AUTHORIZED",
      "Project root",
    );
    const conflict = this.registry.prepare("SELECT id FROM projects WHERE root_path = ?").get(rootPath);
    if (conflict) throw new ProjectContextError("PROJECT_ROOT_ALREADY_REGISTERED", `Project root is already registered: ${rootPath}`);
    const timestamp = nowIso();
    const project: ProjectRecord = {
      id: createId("prj"),
      name: nameInput?.trim() || basename(rootPath),
      rootPath,
      remoteUrl: await detectVersionControlRemote(rootPath),
      createdAt: timestamp,
      updatedAt: timestamp,
      lastOpenedAt: timestamp,
      archivedAt: null,
    };
    if (!project.name) throw new ProjectContextError("INVALID_PROJECT_NAME", "Project name cannot be empty.");
    const directory = dirname(this.projectDatabasePathForRoot(project.rootPath));
    const target = this.projectDatabasePathForRoot(project.rootPath);
    try {
      await mkdir(directory, { recursive: true });
      await copyAndMigrateBackup(source, target);
      this.registry.prepare(`
        INSERT INTO projects (
          id, name, root_path, remote_url, created_at, updated_at, last_opened_at, archived_at, storage_layout
        ) VALUES (
          @id, @name, @rootPath, @remoteUrl, @createdAt, @updatedAt, @lastOpenedAt, @archivedAt,
          '${PROJECT_STORAGE_LAYOUT}'
        )
      `).run(project);
      this.ensureProjectIdentity(project.id, project.rootPath, true);
      return { project, restored: true, replacedExisting: false };
    } catch (error) {
      this.registry.prepare("DELETE FROM projects WHERE id = ?").run(project.id);
      await removeDatabaseFile(target);
      await removeEmptyDirectory(directory);
      throw error;
    }
  }

  private backfillProjectIdentities(): void {
    const rows = this.registry.prepare("SELECT * FROM projects WHERE storage_layout = ?")
      .all(PROJECT_STORAGE_LAYOUT) as ProjectRow[];
    for (const row of rows) {
      if (!existsSync(this.projectDatabasePathForRoot(row.root_path))) continue;
      this.ensureProjectIdentity(row.id, row.root_path);
    }
  }

  private ensureProjectIdentity(projectId: string, rootPath: string, overwrite = false): void {
    const databasePath = this.projectDatabasePathForRoot(rootPath);
    if (!overwrite) {
      const identity = readProjectIdentity(databasePath);
      if (identity === projectId) return;
      if (identity !== null) {
        throw new ProjectContextError(
          "PROJECT_DATABASE_IDENTITY_MISMATCH",
          "Project database identity does not match its registry entry.",
        );
      }
    }
    const db = openDatabase(databasePath);
    try {
      migrateProject(db);
      validateOpenDatabase(db);
      if (overwrite) {
        db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)")
          .run(PROJECT_ID_METADATA_KEY, projectId);
      } else {
        db.prepare("INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)")
          .run(PROJECT_ID_METADATA_KEY, projectId);
        const identity = db.prepare("SELECT value FROM metadata WHERE key = ?")
          .get(PROJECT_ID_METADATA_KEY) as { value: string } | undefined;
        if (identity?.value !== projectId) {
          throw new ProjectContextError(
            "PROJECT_DATABASE_IDENTITY_MISMATCH",
            "Project database identity does not match its registry entry.",
          );
        }
      }
    } finally {
      db.close();
    }
  }
}

function mapProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    remoteUrl: row.remote_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOpenedAt: row.last_opened_at,
    archivedAt: row.archived_at,
  };
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch(() => false);
}

async function discoverProjectDatabases(allowedRoots: string[]): Promise<Array<{ projectId: string; rootPath: string }>> {
  const candidates: Array<{ projectId: string; rootPath: string }> = [];
  const visited = new Set<string>();
  for (const configuredRoot of allowedRoots) {
    const allowedRoot = await realpath(resolve(configuredRoot)).catch(() => null);
    if (!allowedRoot || visited.has(normalize(allowedRoot))) continue;
    await scanDirectory(allowedRoot, allowedRoots, candidates, visited);
  }
  return candidates;
}

async function scanDirectory(
  directory: string,
  allowedRoots: string[],
  candidates: Array<{ projectId: string; rootPath: string }>,
  visited: Set<string>,
): Promise<void> {
  const normalizedDirectory = normalize(directory);
  if (visited.has(normalizedDirectory)) return;
  visited.add(normalizedDirectory);

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  const contextDirectory = entries.find((entry) => entry.isDirectory() && entry.name === PROJECT_DATA_DIRECTORY);
  if (contextDirectory) {
    const databasePath = join(directory, PROJECT_DATA_DIRECTORY, "project.db");
    if (await pathExists(databasePath)) {
      const authorizedRoot = await authorizeExistingPath(
        directory,
        allowedRoots,
        "PROJECT_ROOT_NOT_AUTHORIZED",
        "Project root",
      ).catch(() => null);
      const projectId = authorizedRoot ? readProjectIdentity(databasePath) : null;
      if (authorizedRoot && projectId) candidates.push({ projectId, rootPath: authorizedRoot });
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === PROJECT_DATA_DIRECTORY || DISCOVERY_IGNORED_DIRECTORIES.has(entry.name)) continue;
    await scanDirectory(join(directory, entry.name), allowedRoots, candidates, visited);
  }
}

function readProjectIdentity(databasePath: string): string | null {
  try {
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      const version = db.pragma("user_version", { simple: true }) as number;
      if (version < 1 || version > PROJECT_SCHEMA_VERSION) return null;
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'metadata'").get()) return null;
      const row = db.prepare("SELECT value FROM metadata WHERE key = ?")
        .get(PROJECT_ID_METADATA_KEY) as { value: string } | undefined;
      return row?.value ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function validateBackupSource(path: string): void {
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const integrity = String(db.pragma("quick_check", { simple: true }));
    if (integrity !== "ok") throw new ProjectContextError("INVALID_BACKUP", `Backup integrity check failed: ${integrity}`);
    const version = db.pragma("user_version", { simple: true }) as number;
    if (version < 1 || version > PROJECT_SCHEMA_VERSION) {
      throw new ProjectContextError("UNSUPPORTED_BACKUP_SCHEMA", `Unsupported backup schema version: ${version}`);
    }
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memories'").get()) {
      throw new ProjectContextError("INVALID_BACKUP", "Backup is not a Project Context project database.");
    }
  } catch (error) {
    if (error instanceof ProjectContextError) throw error;
    throw new ProjectContextError("INVALID_BACKUP", `Unable to read project backup: ${path}`);
  } finally {
    db?.close();
  }
}

async function copyAndMigrateBackup(source: string, destination: string): Promise<void> {
  await ensureAbsent(destination, "RESTORE_DESTINATION_EXISTS");
  await copyFile(source, destination);
  const db = openDatabase(destination);
  try {
    migrateProject(db);
    validateOpenDatabase(db);
  } catch (error) {
    db.close();
    await rm(destination, { force: true });
    throw error;
  }
  db.close();
}

async function snapshotProjectDatabase(source: string, destination: string): Promise<void> {
  await ensureAbsent(destination, "PROJECT_DATABASE_SNAPSHOT_EXISTS");
  await mkdir(dirname(destination), { recursive: true });
  const sourceDb = openDatabase(source);
  try {
    migrateProject(sourceDb);
    validateOpenDatabase(sourceDb);
    await sourceDb.backup(destination);
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  } finally {
    sourceDb.close();
  }
  validateProjectDatabaseFile(destination);
  await removeSqliteSidecars(destination);
}

function validateProjectDatabaseFile(path: string): void {
  validateBackupSource(path);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const foreignKeys = db.pragma("foreign_key_check") as unknown[];
    if (foreignKeys.length > 0) {
      throw new ProjectContextError("INVALID_BACKUP", "Project database contains foreign-key violations.");
    }
  } finally {
    db.close();
  }
}

function validateOpenDatabase(db: SqliteDatabase): void {
  const integrity = String(db.pragma("quick_check", { simple: true }));
  if (integrity !== "ok") throw new ProjectContextError("INVALID_BACKUP", `Restored database failed integrity check: ${integrity}`);
  const foreignKeys = db.pragma("foreign_key_check") as unknown[];
  if (foreignKeys.length > 0) {
    throw new ProjectContextError("INVALID_BACKUP", "Restored database contains foreign-key violations.");
  }
}

async function ensureAbsent(path: string, code: string): Promise<void> {
  try {
    await access(path);
    throw new ProjectContextError(code, `Destination already exists: ${path}`);
  } catch (error) {
    if (error instanceof ProjectContextError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function removeSqliteSidecars(databasePath: string): Promise<void> {
  await Promise.all([
    rm(`${databasePath}-wal`, { force: true }),
    rm(`${databasePath}-shm`, { force: true }),
  ]);
}

async function removeDatabaseFile(databasePath: string): Promise<void> {
  await removeSqliteSidecars(databasePath);
  await rm(databasePath, { force: true });
}

async function removeEmptyDirectory(directory: string): Promise<void> {
  try {
    await rmdir(directory);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

function fileTimestamp(): string {
  return new Date().toISOString().replace(/[^0-9]/g, "");
}

function scalar(db: SqliteDatabase, sql: string): number {
  return (db.prepare(sql).pluck().get() as number | undefined) ?? 0;
}
