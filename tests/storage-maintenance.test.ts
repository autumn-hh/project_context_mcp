import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type SqliteDatabase } from "../src/storage/database.js";
import { migrateProject } from "../src/storage/schema.js";
import {
  cleanupDatabase, cleanupHistory, recentIndexRuns, listIndexRuns, databaseUsage, maintenanceSettings, runAutomaticMaintenance, setMaintenancePolicy,
} from "../src/maintenance/storage-maintenance.js";
import { createRunLogger } from "../src/indexing/run-log.js";
import { remember } from "../src/memory/memory-service.js";
import { startTask } from "../src/tasks/task-service.js";
import { searchProject } from "../src/search/search-service.js";

const directories: string[] = [];
const databases: SqliteDatabase[] = [];
const now = new Date("2026-09-18T00:00:00.000Z");

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pcm-maintenance-"));
  directories.push(directory);
  const db = openDatabase(join(directory, "project.db"));
  databases.push(db);
  migrateProject(db);
  const insert = db.prepare("INSERT INTO index_runs (id, started_at, completed_at, status, errors_json) VALUES (?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (let i = 0; i < 30; i++) {
      const day = String(i + 1).padStart(2, "0");
      insert.run(`old-${day}`, `2026-01-${day}T00:00:00.000Z`, `2026-01-${day}T00:01:00.000Z`, i % 2 ? "failed" : "completed", JSON.stringify(["x".repeat(100_000)]));
    }
    insert.run("running", "2020-01-01T00:00:00.000Z", null, "running", "[]");
    insert.run("boundary", "2026-08-18T00:00:00.000Z", "2026-08-19T00:00:00.000Z", "completed", "[]");
    insert.run("recent", "2026-09-17T00:00:00.000Z", "2026-09-17T00:01:00.000Z", "completed", "[]");
  })();
  db.pragma("wal_checkpoint(TRUNCATE)");
  return db;
}

describe("database maintenance", () => {
  it("previews without writes and prunes only expired finished logs, preserving knowledge and search", () => {
    const db = fixture();
    const memory = remember(db, { type: "decision", title: "Durable knowledge", content: "Keep searchable maintenance knowledge", sourceKind: "user" });
    const task = startTask(db, "Unfinished task");
    const beforeRows = db.prepare("SELECT * FROM index_runs ORDER BY id").all();
    const changes = db.prepare("SELECT total_changes()").pluck().get();
    const preview = cleanupDatabase(db, {}, now);
    expect(preview.dryRun).toBe(true);
    expect(preview.eligibleIndexRuns).toBe(22);
    expect(preview.deletedIndexRuns).toBe(0);
    expect(preview.details).toHaveLength(22);
    expect(preview.details[0]).toMatchObject({ id: "old-01", status: "completed", indexed: 0 });
    expect(preview.detailsTruncated).toBe(false);
    expect(cleanupHistory(db)).toEqual([]);
    expect(db.prepare("SELECT total_changes()").pluck().get()).toBe(changes);
    expect(db.prepare("SELECT * FROM index_runs ORDER BY id").all()).toEqual(beforeRows);
    const searches = searchProject(db, "maintenance knowledge");
    const result = cleanupDatabase(db, { dryRun: false }, now);
    expect(result.deletedIndexRuns).toBe(22);
    expect(result.details).toEqual(preview.details);
    expect(cleanupHistory(db)[0]).toMatchObject({
      id: result.historyId, trigger: "manual", deletedIndexRuns: 22, details: result.details,
      phase: "finished", vacuumCompleted: true,
    });
    for (const detail of result.details) expect(db.prepare("SELECT id FROM index_runs WHERE id = ?").get(detail.id)).toBeUndefined();
    expect(result.recentIndexRuns?.some((row) => result.details.some((deleted) => deleted.id === row.id))).toBe(false);
    expect(result.vacuumCompleted).toBe(true);
    expect(result.after.databaseBytes).toBeLessThan(result.before.databaseBytes);
    expect(result.reclaimedBytes).toBeGreaterThan(1_000_000);
    expect(db.prepare("SELECT id FROM index_runs WHERE id IN ('running', 'boundary', 'recent')").all()).toHaveLength(3);
    expect(db.prepare("SELECT id FROM memories WHERE id = ?").pluck().get(memory.id)).toBe(memory.id);
    expect(db.prepare("SELECT id FROM tasks WHERE id = ?").pluck().get(task.id)).toBe(task.id);
    expect(searchProject(db, "maintenance knowledge")).toEqual(searches);
    expect(db.pragma("quick_check", { simple: true })).toBe("ok");
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(cleanupDatabase(db, { dryRun: false }, now).deletedIndexRuns).toBe(0);
  });

  it("keeps recent finished history even when every run is old and rejects invalid retention", () => {
    const db = fixture();
    db.prepare("DELETE FROM index_runs WHERE id IN ('boundary', 'recent')").run();
    expect(cleanupDatabase(db, { dryRun: false, vacuum: false }, now).deletedIndexRuns).toBe(20);
    expect(databaseUsage(db).counts.index_runs).toBe(11);
    for (const retentionDays of [0, -1, 1.5, 3651, NaN, Infinity]) {
      expect(() => cleanupDatabase(db, { dryRun: false, retentionDays }, now)).toThrow();
    }
    expect(databaseUsage(db).counts.index_runs).toBe(11);
  });

  it("reports committed deletion separately when a second reader blocks compaction", () => {
    const db = fixture();
    const reader = openDatabase(db.name);
    databases.push(reader);
    db.pragma("busy_timeout = 1");
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) FROM index_runs").get();
    const result = cleanupDatabase(db, { dryRun: false }, now);
    expect(result.deletedIndexRuns).toBe(22);
    expect(result.vacuumCompleted).toBe(false);
    expect(result.checkpointBusy).toBe(true);
    expect(result.warnings.join(" ")).toContain("committed");
    expect(cleanupHistory(db)[0]).toMatchObject({ deletedIndexRuns: 22, vacuumCompleted: false, checkpointBusy: true, phase: "finished" });
    reader.exec("ROLLBACK");
    expect(cleanupDatabase(db, { dryRun: false }, now).vacuumCompleted).toBe(true);
    expect(db.pragma("quick_check", { simple: true })).toBe("ok");
  });

  it("defaults automation off, persists opt-in settings, throttles attempts, and can disable it", () => {
    const db = fixture();
    expect(maintenanceSettings(db)).toEqual({ enabled: false, retentionDays: 30, intervalHours: 24, lastRun: null });
    runAutomaticMaintenance(db, now);
    expect(databaseUsage(db).counts.index_runs).toBe(33);
    setMaintenancePolicy(db, { enabled: true, retentionDays: 30, intervalHours: 24 });
    runAutomaticMaintenance(db, now);
    const first = maintenanceSettings(db);
    expect(first.lastRun).toMatchObject({ attemptedAt: now.toISOString(), deletedIndexRuns: 22, vacuumCompleted: false, warnings: [] });
    expect(cleanupHistory(db)).toHaveLength(1);
    expect(cleanupHistory(db)[0]).toMatchObject({ trigger: "automatic", deletedIndexRuns: 22 });
    runAutomaticMaintenance(db, new Date(now.getTime() + 3600_000));
    expect(maintenanceSettings(db)).toEqual(first);
    expect(cleanupHistory(db)).toHaveLength(1);
    runAutomaticMaintenance(db, new Date(now.getTime() + 86_400_000));
    expect(maintenanceSettings(db).lastRun?.attemptedAt).not.toBe(first.lastRun?.attemptedAt);
    setMaintenancePolicy(db, { enabled: false });
    const stopped = maintenanceSettings(db);
    runAutomaticMaintenance(db, new Date("2027-01-01T00:00:00Z"));
    expect(maintenanceSettings(db)).toEqual(stopped);
    const reopened = openDatabase(db.name);
    databases.push(reopened);
    expect(maintenanceSettings(reopened)).toEqual(stopped);
    expect(() => setMaintenancePolicy(db, { enabled: true, retentionDays: 0 })).toThrow();
    expect(() => setMaintenancePolicy(db, { enabled: true, intervalHours: 0 })).toThrow();
  });

  it("automatically compacts only after enough free space has accumulated", () => {
    const db = fixture();
    db.exec("CREATE TABLE scratch (data BLOB); INSERT INTO scratch VALUES (zeroblob(20000000)); DELETE FROM scratch;");
    db.pragma("wal_checkpoint(TRUNCATE)");
    const before = databaseUsage(db);
    expect(before.reclaimableBytes).toBeGreaterThan(16 * 1024 * 1024);
    setMaintenancePolicy(db, { enabled: true });
    runAutomaticMaintenance(db, now);
    expect(maintenanceSettings(db).lastRun?.vacuumCompleted).toBe(true);
    expect(cleanupHistory(db)).toHaveLength(1);
    expect(cleanupHistory(db)[0]).toMatchObject({ trigger: "automatic", vacuumCompleted: true, deletedIndexRuns: 22 });
    expect(databaseUsage(db).databaseBytes).toBeLessThan(before.databaseBytes);
    expect(db.pragma("quick_check", { simple: true })).toBe("ok");
  });

  it("bounds stored history and details, masks secrets, and persists across connections", () => {
    const db = fixture();
    const insert = db.prepare("INSERT INTO index_runs (id, started_at, completed_at, status, errors_json) VALUES (?, ?, ?, 'failed', ?)");
    db.transaction(() => {
      for (let i = 0; i < 140; i++) insert.run(`extra-${i}`, "2025-01-01T00:00:00.000Z", "2025-01-01T00:01:00.000Z", '[{"path":"src/test.ts","message":"api_key=private-error-details-0123456789"}]');
    })();
    const preview = cleanupDatabase(db, {}, now);
    expect(preview.eligibleIndexRuns).toBe(162);
    expect(preview.details).toHaveLength(100);
    expect(preview.detailsTruncated).toBe(true);
    expect(preview.details[0]?.errors).toEqual([{ path: "src/test.ts", message: "[Sensitive content hidden]" }]);
    const result = cleanupDatabase(db, { dryRun: false, vacuum: false }, now);
    expect(result.details).toEqual(preview.details);
    expect(result.deletedIndexRuns).toBe(162);
    const originalId = result.historyId;
    expect(JSON.stringify(cleanupHistory(db))).not.toContain("private-error-details");
    for (let i = 0; i < 22; i++) cleanupDatabase(db, { dryRun: false, vacuum: false }, now);
    const history = cleanupHistory(db);
    expect(history).toHaveLength(20);
    expect(history.some((entry) => entry.id === originalId)).toBe(false);
    const reopened = openDatabase(db.name);
    databases.push(reopened);
    expect(cleanupHistory(reopened)).toEqual(history);
  });

  it("exposes bounded saved error content and handles malformed legacy logs", () => {
    const db = fixture();
    const errors = Array.from({ length: 8 }, (_, i) => ({ path: `src/file-${i}.ts`, message: i === 0 ? "Permission denied" : "long message ".repeat(80) }));
    db.prepare("UPDATE index_runs SET errors_json = ? WHERE id = 'old-01'").run(JSON.stringify(errors));
    db.prepare("UPDATE index_runs SET errors_json = 'malformed' WHERE id = 'old-02'").run();
    const preview = cleanupDatabase(db, {}, now);
    const detail = preview.details.find((row) => row.id === "old-01")!;
    expect(detail.errorCount).toBe(8);
    expect(detail.errors).toHaveLength(5);
    expect(detail.errors[0]).toEqual({ path: "src/file-0.ts", message: "Permission denied" });
    expect(detail.errors[1]?.message.length).toBe(501);
    expect(detail.errorsTruncated).toBe(true);
    expect(preview.details.find((row) => row.id === "old-02")?.logNote).toContain("could not be parsed");
    const applied = cleanupDatabase(db, { dryRun: false, vacuum: false }, now);
    expect(applied.history?.[0]?.details.find((row) => row.id === "old-01")).toEqual(detail);
  });

  it("rolls back deletion if its audit record cannot be saved", () => {
    const db = fixture();
    db.exec(`CREATE TRIGGER reject_history BEFORE INSERT ON metadata
      WHEN NEW.key = 'storage_cleanup_history'
      BEGIN SELECT RAISE(ABORT, 'audit storage unavailable'); END;`);
    expect(() => cleanupDatabase(db, { dryRun: false }, now)).toThrow("audit storage unavailable");
    expect(databaseUsage(db).counts.index_runs).toBe(33);
    expect(cleanupHistory(db)).toEqual([]);
    expect(db.pragma("quick_check", { simple: true })).toBe("ok");
  });

  it("reads recent logs without cleaning and includes currently running records", () => {
    const db = fixture();
    db.prepare("UPDATE index_runs SET started_at = '2026-09-18T00:00:00.000Z' WHERE id = 'running'").run();
    const changes = db.prepare("SELECT total_changes()").pluck().get();
    const recent = recentIndexRuns(db);
    expect(recent).toHaveLength(20);
    expect(recent[0]).toMatchObject({ id: "running", status: "running", completedAt: null, errors: [] });
    expect(recent[1]?.id).toBe("recent");
    expect(db.prepare("SELECT total_changes()").pluck().get()).toBe(changes);
    expect(databaseUsage(db).counts.index_runs).toBe(33);
    expect(cleanupHistory(db)).toEqual([]);
  });

  it("paginates filtered logs with stable ordering, exact totals and validated limits", () => {
    const db = fixture();
    const first = listIndexRuns(db, { limit: 10, status: "failed" });
    const second = listIndexRuns(db, { limit: 10, offset: 10, status: "failed" });
    expect(first).toMatchObject({ total: 15, limit: 10, offset: 0, status: "failed", hasMore: true });
    expect(second.items).toHaveLength(5);
    expect(second.hasMore).toBe(false);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(15);
    expect(first.items.every((item) => item.status === "failed" && item.processLog === null)).toBe(true);
    expect(listIndexRuns(db, { limit: 100 }).items).toHaveLength(33);
    expect(listIndexRuns(db, { offset: 100 }).items).toEqual([]);
    expect(listIndexRuns(db, { status: "running" }).items[0]?.id).toBe("running");
    for (const options of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 1.5 }, { status: "invalid" }]) {
      expect(() => listIndexRuns(db, options as never)).toThrow();
    }
  });

  it("bounds process logs, retains the final event, and stores a smaller history excerpt", () => {
    const db = fixture();
    const logger = createRunLogger(db, "old-01");
    logger.record("开始索引");
    logger.record("已跳过", "api_key=secret-path-content-0123456789");
    for (let i = 0; i < 300; i++) logger.record("已更新文件索引", `src/${i}-${"文".repeat(200)}.ts`);
    logger.record("索引完成", undefined, "info", true);
    const log = listIndexRuns(db, { limit: 100 }).items.find((item) => item.id === "old-01")!.processLog!;
    expect(log.totalEvents).toBe(303);
    expect(log.entries.length).toBeLessThanOrEqual(100);
    expect(log.truncated).toBe(true);
    expect(log.entries.at(-1)?.message).toBe("索引完成");
    expect(Buffer.byteLength(JSON.stringify(log))).toBeLessThan(32_000);
    expect(JSON.stringify(log)).not.toContain("secret-path-content");
    const cleaned = cleanupDatabase(db, { dryRun: false, vacuum: false }, now);
    const historical = cleaned.history![0]!.details.find((item) => item.id === "old-01")!.processLog!;
    expect(historical.entries).toHaveLength(10);
    expect(historical.entries.at(-1)?.message).toBe("索引完成");
    expect(historical.truncated).toBe(true);
    expect(historical.totalEvents).toBe(303);
  });
});
