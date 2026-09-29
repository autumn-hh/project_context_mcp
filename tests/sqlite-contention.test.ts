import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { openDatabase, type SqliteDatabase } from "../src/storage/database.js";
import { migrateProject } from "../src/storage/schema.js";
import { indexProject } from "../src/indexing/indexer.js";
import type { ProjectRecord } from "../src/projects/project-service.js";

const require = createRequire(import.meta.url);

describe("SQLite concurrent indexing", () => {
  let root: string;
  let db: SqliteDatabase;
  let writer: Worker | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await writer?.terminate();
    db?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("removes excluded sources while a separate worker writes without promoting a stale WAL snapshot", async () => {
    root = await mkdtemp(join(tmpdir(), "context-sqlite-contention-"));
    const projectRoot = join(root, "project");
    await mkdir(join(projectRoot, "references"), { recursive: true });
    await writeFile(join(projectRoot, "references", "helper.ts"), "export function legacyHelper() { return 42; }");
    await writeFile(join(projectRoot, "main.ts"), "export function retainedBusiness() { return 7; }");
    const dbPath = join(root, "project.db");
    db = openDatabase(dbPath);
    migrateProject(db);
    db.exec("CREATE TABLE contention_probe (value INTEGER); INSERT INTO contention_probe VALUES (0)");
    const project: ProjectRecord = {
      id: "prj_contention", name: "contention", rootPath: projectRoot, remoteUrl: null,
      createdAt: "", updatedAt: "", lastOpenedAt: "", archivedAt: null,
    };
    await indexProject(db, project);
    await writeFile(join(projectRoot, ".project-context-ignore"), "references/**\n");

    const state = new Int32Array(new SharedArrayBuffer(4));
    writer = new Worker(`
      const { workerData, parentPort } = require('node:worker_threads');
      const Database = require(workerData.module);
      const db = new Database(workerData.path, { timeout: 5000 });
      const state = new Int32Array(workerData.state);
      parentPort.postMessage('ready');
      Atomics.wait(state, 0, 0);
      try {
        db.prepare('UPDATE contention_probe SET value = value + 1').run();
        Atomics.store(state, 0, 2);
        Atomics.notify(state, 0);
        parentPort.postMessage('committed');
      } catch (error) { parentPort.postMessage({ error: error.message }); }
      finally { db.close(); }
    `, { eval: true, workerData: { module: require.resolve("better-sqlite3"), path: dbPath, state: state.buffer } });
    await new Promise<void>((resolve, reject) => {
      writer!.once("message", () => resolve());
      writer!.once("error", reject);
    });
    const committed = new Promise<unknown>((resolve, reject) => {
      writer!.once("message", resolve);
      writer!.once("error", reject);
    });

    // Trigger a real second connection immediately after the removal batch's
    // first SELECT. Deferred transactions fail with SQLITE_BUSY_SNAPSHOT here;
    // an immediate transaction holds the writer until the batch commits.
    const prepare = db.prepare.bind(db);
    let raced = false;
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      const statement = prepare(sql);
      if (!raced && sql.startsWith("SELECT id FROM chunks WHERE source_id IN (")) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...args: unknown[]) => {
          const rows = all(...args);
          raced = true;
          Atomics.store(state, 0, 1);
          Atomics.notify(state, 0);
          Atomics.wait(state, 0, 1, 300);
          return rows;
        });
      }
      return statement;
    }) as typeof db.prepare);

    const result = await indexProject(db, project);
    expect(raced).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.removed).toBe(1);
    expect(await committed).toBe("committed");
    expect(db.prepare("SELECT value FROM contention_probe").pluck().get()).toBe(1);
    expect(db.prepare("SELECT COUNT(*) FROM sources WHERE path LIKE 'references/%'").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM sources WHERE path = 'main.ts'").pluck().get()).toBe(1);
    expect(db.pragma("quick_check", { simple: true })).toBe("ok");
  }, 15_000);
});
