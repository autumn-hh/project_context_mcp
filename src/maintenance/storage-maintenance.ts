import { statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import * as z from "zod/v4";
import type { SqliteDatabase } from "../storage/database.js";
import { containsLikelySecret } from "../indexing/file-policy.js";
import type { RunLog } from "../indexing/run-log.js";

const DAY_MS = 86_400_000;
const KEEP_RECENT_RUNS = 10;
const AUTO_VACUUM_MIN_BYTES = 16 * 1024 * 1024;
const POLICY_KEY = "storage_maintenance_policy";
const LAST_RUN_KEY = "storage_maintenance_last_run";
const HISTORY_KEY = "storage_cleanup_history";
const DETAIL_LIMIT = 100;
const HISTORY_LIMIT = 20;

export interface CleanupDetail {
  id: string;
  startedAt: string;
  completedAt: string | null;
  status: "completed" | "failed" | "running";
  scanned: number;
  indexed: number;
  skipped: number;
  removed: number;
  errors: Array<{ path: string; message: string }>;
  errorCount: number;
  errorsTruncated: boolean;
  logNote: string | null;
  processLog: RunLog | null;
}

export interface CleanupHistoryEntry {
  id: string;
  createdAt: string;
  trigger: "manual" | "automatic";
  retentionDays: number;
  cutoff: string;
  deletedIndexRuns: number;
  details: CleanupDetail[];
  detailsTruncated: boolean;
  vacuumRequested: boolean;
  vacuumCompleted: boolean;
  checkpointBusy: boolean;
  beforeBytes: number;
  afterBytes: number;
  reclaimedBytes: number;
  phase: "cleanup_committed" | "finished";
  warnings: string[];
}

export function cleanupHistory(db: SqliteDatabase): CleanupHistoryEntry[] {
  return (readMetadata(db, HISTORY_KEY) as CleanupHistoryEntry[] | null) ?? [];
}

const runDetailsColumns = `id, started_at AS startedAt, completed_at AS completedAt,
  status, scanned, indexed, skipped, removed, errors_json AS errorsJson, log_json AS logJson`;
type RunDetailRow = Omit<CleanupDetail, "errors" | "errorCount" | "errorsTruncated" | "logNote" | "processLog"> & { errorsJson: string; logJson: string | null };
const mapRunDetail = ({ errorsJson, logJson, ...row }: RunDetailRow): CleanupDetail => ({ ...row, ...summarizeErrors(errorsJson), processLog: parseProcessLog(logJson) });

export const indexLogQuerySchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).max(1_000_000).default(0),
  status: z.enum(["all", "completed", "failed", "running"]).default("all"),
}).strict();

export function listIndexRuns(db: SqliteDatabase, options: z.input<typeof indexLogQuerySchema> = {}) {
  const { limit, offset, status } = indexLogQuerySchema.parse(options);
  const where = status === "all" ? "" : "WHERE status = ?";
  const args = status === "all" ? [] : [status];
  return db.transaction(() => {
    const total = db.prepare(`SELECT COUNT(*) FROM index_runs ${where}`).pluck().get(...args) as number;
    const items = (db.prepare(`SELECT ${runDetailsColumns} FROM index_runs ${where} ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as RunDetailRow[]).map(mapRunDetail);
    return { items, total, limit, offset, status, hasMore: offset + items.length < total };
  })();
}

export function recentIndexRuns(db: SqliteDatabase): CleanupDetail[] {
  return listIndexRuns(db).items;
}

export const retentionDaysSchema = z.number().int().min(1).max(3650);
export const maintenancePolicySchema = z.object({
  enabled: z.boolean(),
  retentionDays: retentionDaysSchema.default(30),
  intervalHours: z.number().int().min(1).max(8760).default(24),
}).strict();

export interface CleanupOptions {
  dryRun?: boolean;
  retentionDays?: number;
  vacuum?: boolean;
}

export function databaseUsage(db: SqliteDatabase) {
  const pageSize = db.pragma("page_size", { simple: true }) as number;
  const pageCount = db.pragma("page_count", { simple: true }) as number;
  const freePages = db.pragma("freelist_count", { simple: true }) as number;
  const databaseBytes = fileBytes(db.name);
  const walBytes = fileBytes(`${db.name}-wal`);
  const shmBytes = fileBytes(`${db.name}-shm`);
  const counts = Object.fromEntries([
    "sources", "chunks", "symbols", "relations", "memories", "tasks", "memory_candidates", "index_runs",
  ].map((table) => [table, db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number]));
  return {
    databasePath: db.name, databaseBytes, walBytes, shmBytes,
    totalBytes: databaseBytes + walBytes + shmBytes,
    pageSize, pageCount, freePages, reclaimableBytes: freePages * pageSize, counts,
  };
}

export function maintenanceSettings(db: SqliteDatabase) {
  const stored = readMetadata(db, POLICY_KEY);
  const policy = maintenancePolicySchema.parse(stored ?? { enabled: false });
  const lastRun = readMetadata(db, LAST_RUN_KEY) as {
    attemptedAt: string; deletedIndexRuns: number; vacuumCompleted: boolean; warnings: string[];
  } | null;
  return { ...policy, lastRun };
}

export function setMaintenancePolicy(db: SqliteDatabase, input: z.input<typeof maintenancePolicySchema>) {
  const policy = maintenancePolicySchema.parse(input);
  writeMetadata(db, POLICY_KEY, policy);
  return maintenanceSettings(db);
}

// Keep the most recent finished runs even when all of them are older than the retention window.
const eligibleRuns = `status IN ('completed', 'failed') AND completed_at < ?
  AND id NOT IN (
    SELECT id FROM index_runs WHERE status IN ('completed', 'failed')
    ORDER BY started_at DESC, id DESC LIMIT ${KEEP_RECENT_RUNS}
  )`;

export function cleanupDatabase(
  db: SqliteDatabase, options: CleanupOptions = {}, now = new Date(), automatic = false,
) {
  const retentionDays = retentionDaysSchema.parse(options.retentionDays ?? 30);
  const dryRun = z.boolean().parse(options.dryRun ?? true);
  let vacuumRequested = z.boolean().parse(options.vacuum ?? true);
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS).toISOString();
  const before = databaseUsage(db);
  let eligibleIndexRuns = db.prepare(`SELECT COUNT(*) FROM index_runs WHERE ${eligibleRuns}`)
    .pluck().get(cutoff) as number;
  const readDetails = () => (db.prepare(`SELECT ${runDetailsColumns} FROM index_runs WHERE ${eligibleRuns}
    ORDER BY completed_at ASC, id ASC LIMIT ?`).all(cutoff, DETAIL_LIMIT) as RunDetailRow[]).map(mapRunDetail);
  let details = dryRun ? readDetails() : [];
  const historyId = dryRun ? null : randomUUID();
  const warnings: string[] = [];
  let deletedIndexRuns = 0;
  let vacuumCompleted = false;
  let checkpointBusy = false;
  if (!dryRun) {
    deletedIndexRuns = db.transaction(() => {
      // Capture the exact deleted rows under the same write lock as deletion.
      details = readDetails();
      const deleted = db.prepare(`DELETE FROM index_runs WHERE ${eligibleRuns}`).run(cutoff).changes;
      const entry: CleanupHistoryEntry = {
        id: historyId!, createdAt: now.toISOString(), trigger: automatic ? "automatic" : "manual",
        retentionDays, cutoff, deletedIndexRuns: deleted,
        details: details.map((detail) => ({ ...detail, processLog: trimHistoryLog(detail.processLog) })),
        detailsTruncated: deleted > details.length,
        vacuumRequested, vacuumCompleted: false, checkpointBusy: false,
        beforeBytes: before.totalBytes, afterBytes: before.totalBytes, reclaimedBytes: 0,
        phase: "cleanup_committed", warnings: [],
      };
      writeMetadata(db, HISTORY_KEY, [entry, ...cleanupHistory(db)].slice(0, HISTORY_LIMIT));
      return deleted;
    }).immediate();
    eligibleIndexRuns = deletedIndexRuns;
    if (automatic && vacuumRequested) {
      const usage = databaseUsage(db);
      vacuumRequested = usage.reclaimableBytes >= AUTO_VACUUM_MIN_BYTES && usage.freePages >= usage.pageCount * 0.2;
    }
    if (vacuumRequested) {
      // Deletion is already committed. Report compaction failures separately so retries are safe.
      try {
        const checkpoint = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number }>;
        checkpointBusy = checkpoint.some((row) => row.busy !== 0);
        if (checkpointBusy) {
          warnings.push("History cleanup committed, but another connection prevented WAL truncation; retry compaction when idle.");
        } else {
          db.exec("VACUUM");
          vacuumCompleted = true;
          const afterCheckpoint = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number }>;
          checkpointBusy = afterCheckpoint.some((row) => row.busy !== 0);
          if (checkpointBusy) warnings.push("Database compacted, but WAL truncation is pending because another connection is active.");
        }
      } catch (error) {
        warnings.push(`History cleanup committed; space reclamation did not finish: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (automatic) {
      db.pragma("wal_checkpoint(PASSIVE)");
    }
  }
  const after = dryRun ? before : databaseUsage(db);
  const reclaimedBytes = dryRun ? 0 : Math.max(0, before.totalBytes - after.totalBytes);
  if (!dryRun) {
    db.transaction(() => {
      writeMetadata(db, HISTORY_KEY, cleanupHistory(db).map((entry) => entry.id === historyId ? {
        ...entry, afterBytes: after.totalBytes, reclaimedBytes, vacuumRequested, vacuumCompleted,
        checkpointBusy, warnings, phase: "finished",
      } : entry));
    }).immediate();
  }
  return {
    dryRun, retentionDays, cutoff, keepRecentRuns: KEEP_RECENT_RUNS,
    eligibleIndexRuns, deletedIndexRuns, before, after,
    reclaimedBytes, details, detailsTruncated: eligibleIndexRuns > details.length, detailLimit: DETAIL_LIMIT,
    historyId,
    ...(!dryRun ? { history: cleanupHistory(db), recentIndexRuns: recentIndexRuns(db) } : {}),
    vacuumRequested, vacuumCompleted, checkpointBusy, warnings,
  };
}

// Invoked after a successful index. No timers, no work while the service is stopped,
// and no automatic maintenance until the user explicitly enables it for this project.
export function runAutomaticMaintenance(db: SqliteDatabase, now = new Date()): void {
  const policy = maintenanceSettings(db);
  if (!policy.enabled) return;
  const attemptedAt = now.toISOString();
  const previousAttempt = policy.lastRun ? Date.parse(policy.lastRun.attemptedAt) : 0;
  if (now.getTime() - previousAttempt < policy.intervalHours * 3_600_000) return;
  // Claim the interval under SQLite's write lock so separate MCP processes do not both run it.
  const claimed = db.transaction(() => {
    const current = maintenanceSettings(db);
    if (!current.enabled) return false;
    if (current.lastRun && now.getTime() - Date.parse(current.lastRun.attemptedAt) < current.intervalHours * 3_600_000) return false;
    writeMetadata(db, LAST_RUN_KEY, { attemptedAt, deletedIndexRuns: 0, vacuumCompleted: false, warnings: ["Maintenance started."] });
    return true;
  }).immediate();
  if (!claimed) return;
  let deletedIndexRuns = 0;
  let vacuumCompleted = false;
  let warnings: string[] = [];
  try {
    const result = cleanupDatabase(db, { dryRun: false, retentionDays: policy.retentionDays }, now, true);
    deletedIndexRuns = result.deletedIndexRuns;
    vacuumCompleted = result.vacuumCompleted;
    warnings = result.warnings;
  } catch (error) {
    warnings.push(`Automatic maintenance failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  writeMetadata(db, LAST_RUN_KEY, { attemptedAt, deletedIndexRuns, vacuumCompleted, warnings });
}

function fileBytes(path: string): number {
  try { return statSync(path).size; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

function parseProcessLog(raw: string | null): RunLog | null {
  if (!raw) return null;
  try {
    const schema = z.object({
      entries: z.array(z.object({ timestamp: z.string(), level: z.enum(["info", "warn", "error"]), message: z.string().max(300), path: z.string().max(200).optional() })).max(100),
      totalEvents: z.number().int().min(0), truncated: z.boolean(),
    });
    return schema.parse(JSON.parse(raw)) as RunLog;
  } catch { return null; }
}

function trimHistoryLog(log: RunLog | null): RunLog | null {
  if (!log || log.entries.length <= 10) return log;
  return { ...log, entries: [...log.entries.slice(0, 9), log.entries.at(-1)!], truncated: true };
}

function summarizeErrors(raw: string): Pick<CleanupDetail, "errors" | "errorCount" | "errorsTruncated" | "logNote"> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("Invalid error list");
    let shortened = false;
    const errors = parsed.slice(0, 5).map((value: unknown) => {
      const error = value && typeof value === "object" ? value as Record<string, unknown> : { message: String(value) };
      const bounded = (value: unknown, limit: number) => {
        const text = typeof value === "string" ? value : "";
        // Inspect the complete value before truncating so clipping cannot hide a secret marker.
        if (containsLikelySecret(text) || /(?:bearer\s+\S+|https?:\/\/[^\s/@]+:[^\s/@]+@)/i.test(text)) {
          return "[Sensitive content hidden]";
        }
        if (text.length > limit) { shortened = true; return `${text.slice(0, limit)}…`; }
        return text;
      };
      return { path: bounded(error.path, 200), message: bounded(error.message, 500) };
    });
    return { errors, errorCount: parsed.length, errorsTruncated: shortened || parsed.length > errors.length, logNote: null };
  } catch {
    return { errors: [], errorCount: 0, errorsTruncated: false, logNote: "Stored error content could not be parsed; the original payload is not displayed." };
  }
}

function readMetadata(db: SqliteDatabase, key: string): unknown {
  const value = db.prepare("SELECT value FROM metadata WHERE key = ?").pluck().get(key) as string | undefined;
  return value === undefined ? null : JSON.parse(value);
}

function writeMetadata(db: SqliteDatabase, key: string, value: unknown): void {
  db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, JSON.stringify(value));
}
