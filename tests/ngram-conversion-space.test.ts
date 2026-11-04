import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexProject, planNgramConversion } from "../src/indexing/indexer.js";
import type { SpaceProbe } from "../src/maintenance/migration-space.js";
import { openDatabase, type SqliteDatabase } from "../src/storage/database.js";
import { migrateProject } from "../src/storage/schema.js";
import type { ProjectRecord } from "../src/projects/project-service.js";
import { restoreSchema10Ngrams } from "./helpers/schema.js";

// planNgramConversion keeps a 64 MiB floor, so a probe reports one side of it or the other.
const ROOMY_BYTES = 512 * 1024 * 1024;
const TIGHT_BYTES = 4 * 1024 * 1024;

const probeReturning = (availableBytes: number) => async (): Promise<SpaceProbe> => ({
  volume: "test-volume",
  availableBytes,
});

describe("schema 11 n-gram conversion space", () => {
  let root: string;
  let db: SqliteDatabase;
  let project: ProjectRecord;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "context-ngram-space-"));
    await writeFile(join(root, "guide.md"), "这是用于验证中文子串检索的说明文档。\n", "utf8");
    // A file-backed database so the conversion planning runs the real stat() and probe path.
    db = openDatabase(join(root, "project.db"));
    project = { id: "prj_space", rootPath: root } as ProjectRecord;
    migrateProject(db);
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  /** Leave the database looking like an upgraded schema 10 project that still has legacy rows. */
  async function withLegacyRows(): Promise<number> {
    await indexProject(db, project);
    const rows = db.prepare("SELECT term, item_kind, item_id FROM search_ngrams").all() as Array<{
      term: string; item_kind: string; item_id: string;
    }>;
    restoreSchema10Ngrams(db);
    const insert = db.prepare("INSERT INTO search_ngrams (term, item_kind, item_id) VALUES (?, ?, ?)");
    for (const row of rows) insert.run(row.term, row.item_kind, row.item_id);
    db.pragma("user_version = 10");
    migrateProject(db);
    return rows.length;
  }

  const legacyRows = () => db.prepare("SELECT COUNT(*) FROM legacy_search_ngrams").pluck().get() as number;
  const latestStatus = () => db.prepare("SELECT status FROM index_runs ORDER BY started_at DESC, rowid DESC LIMIT 1").pluck().get() as string;
  const latestLog = () => db.prepare("SELECT log_json FROM index_runs ORDER BY started_at DESC, rowid DESC LIMIT 1").pluck().get() as string;

  it("has nothing to plan once the database is converted", async () => {
    await indexProject(db, project);
    expect(await planNgramConversion(db, probeReturning(TIGHT_BYTES))).toBeNull();
  });

  it("skips the conversion but still completes the run when the volume is too small", async () => {
    const expected = await withLegacyRows();
    expect(expected).toBeGreaterThan(0);
    expect(await planNgramConversion(db, probeReturning(TIGHT_BYTES)))
      .toMatchObject({ convert: false, availableBytes: TIGHT_BYTES });

    const result = await indexProject(db, project, { spaceProbe: probeReturning(TIGHT_BYTES) });

    expect(result.errors).toEqual([]);
    expect(latestStatus()).toBe("completed");
    // The rows stay searchable through the view, and the next run converts them.
    expect(legacyRows()).toBe(expected);
    expect(latestLog()).toContain("磁盘可用空间不足");
  });

  it("converts and records the conversion in the run log when there is room", async () => {
    await withLegacyRows();
    const result = await indexProject(db, project, { spaceProbe: probeReturning(ROOMY_BYTES) });

    expect(result.errors).toEqual([]);
    expect(legacyRows()).toBe(0);
    expect(latestLog()).toContain("旧版检索索引转换完成");
  });

  it("converts when free space cannot be read, because committed batches resume", async () => {
    await withLegacyRows();
    const unavailable = async (): Promise<SpaceProbe> => { throw new Error("statfs unavailable"); };

    expect(await planNgramConversion(db, unavailable)).toMatchObject({ convert: true, availableBytes: null });
    await indexProject(db, project, { spaceProbe: unavailable });
    expect(legacyRows()).toBe(0);
  });
});
