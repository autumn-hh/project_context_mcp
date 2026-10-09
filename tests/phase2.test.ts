import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeCode } from "../src/code-intelligence/tree-sitter-analyzer.js";
import { openDatabase } from "../src/storage/database.js";
import { migrateProject, migrateRegistry, PROJECT_SCHEMA_VERSION } from "../src/storage/schema.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Phase 2 foundations", () => {
  it("extracts TypeScript symbols and relationships", () => {
    const analysis = analyzeCode("src/service.ts", `
      import { Base } from './base';
      interface Runner { run(): void }
      class Service extends Base implements Runner {
        run() { helper(); }
      }
      const factory = () => new Service();
    `);
    expect(analysis?.symbols.map((symbol) => `${symbol.kind}:${symbol.name}`)).toEqual(expect.arrayContaining([
      "interface:Runner", "class:Service", "method:run", "function:factory",
    ]));
    expect(analysis?.relations.map((item) => `${item.relationType}:${item.toName}`)).toEqual(expect.arrayContaining([
      "IMPORTS:./base", "EXTENDS:Base", "IMPLEMENTS:Runner", "CALLS:helper",
    ]));
  });

  it("parses TypeScript sources larger than the direct parser input limit", () => {
    const content = `const fixture = "${"x".repeat(33_000)}";\nexport function largeSource() { return fixture.length; }`;
    const analysis = analyzeCode("src/large-source.ts", content);
    expect(analysis?.symbols.map((symbol) => symbol.name)).toContain("largeSource");
  });

  it("upgrades a legacy v1 project database to v7 without dropping v1 data", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-context-migration-"));
    temporaryDirectories.push(root);
    const db = openDatabase(join(root, "legacy.db"));
    try {
      migrateProject(db);
      db.prepare("INSERT INTO metadata (key, value) VALUES ('legacy', 'preserved')").run();
      db.exec("DROP TABLE symbols_fts; DROP TABLE relations; DROP TABLE symbols; DROP TABLE git_state; DROP TABLE memory_sources; DROP TABLE memory_candidates;");
      db.pragma("user_version = 1");
      db.exec("ALTER TABLE index_runs DROP COLUMN log_json; DROP INDEX index_runs_started_idx; DROP INDEX index_runs_status_started_idx;");
      migrateProject(db);
      expect(db.pragma("user_version", { simple: true })).toBe(PROJECT_SCHEMA_VERSION);
      expect(db.prepare("SELECT value FROM metadata WHERE key = 'legacy'").pluck().get()).toBe("preserved");
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'symbols'").get()).toBeTruthy();
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'chunks_source_id_idx'").get())
        .toBeTruthy();
    } finally {
      db.close();
    }
  });

  it("repairs an intermediate v2 database that is missing symbol FTS", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-context-migration-"));
    temporaryDirectories.push(root);
    const db = openDatabase(join(root, "intermediate.db"));
    try {
      migrateProject(db);
      db.exec("DROP TABLE symbols_fts");
      db.exec("ALTER TABLE memory_sources DROP COLUMN source_excerpt_hash; ALTER TABLE memory_sources DROP COLUMN source_excerpt;");
      db.pragma("user_version = 2");
      db.exec("ALTER TABLE index_runs DROP COLUMN log_json; DROP INDEX index_runs_started_idx; DROP INDEX index_runs_status_started_idx;");
      migrateProject(db);
      expect(db.pragma("user_version", { simple: true })).toBe(PROJECT_SCHEMA_VERSION);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'symbols_fts'").get()).toBeTruthy();
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'search_ngrams'").get()).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it("adds the chunk source foreign-key index when upgrading schema v4", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-context-migration-"));
    temporaryDirectories.push(root);
    const db = openDatabase(join(root, "v4.db"));
    try {
      migrateProject(db);
      db.exec("DROP INDEX chunks_source_id_idx");
      db.exec("ALTER TABLE memory_sources DROP COLUMN source_excerpt_hash; ALTER TABLE memory_sources DROP COLUMN source_excerpt;");
      db.pragma("user_version = 4");
      db.exec("ALTER TABLE index_runs DROP COLUMN log_json; DROP INDEX index_runs_started_idx; DROP INDEX index_runs_status_started_idx;");
      migrateProject(db);
      expect(db.pragma("user_version", { simple: true })).toBe(PROJECT_SCHEMA_VERSION);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'chunks_source_id_idx'").get())
        .toBeTruthy();
    } finally {
      db.close();
    }
  });

  it("upgrades v6 index logs without inventing historical process content", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-context-v6-"));
    temporaryDirectories.push(root);
    const db = openDatabase(join(root, "project.db"));
    try {
      migrateProject(db);
      db.exec("ALTER TABLE index_runs DROP COLUMN log_json; DROP INDEX index_runs_started_idx; DROP INDEX index_runs_status_started_idx;");
      db.pragma("user_version = 6");
      db.prepare("INSERT INTO index_runs (id, started_at, status, scanned) VALUES ('legacy-run', '2025-01-01', 'completed', 42)").run();
      migrateProject(db);
      expect(db.prepare("SELECT id, scanned, log_json FROM index_runs").get()).toEqual({ id: "legacy-run", scanned: 42, log_json: null });
      expect(db.pragma("user_version", { simple: true })).toBe(PROJECT_SCHEMA_VERSION);
      expect(db.pragma("quick_check", { simple: true })).toBe("ok");
    } finally { db.close(); }
  });

  it("upgrades a v1 registry with archived projects and user memories", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-context-registry-migration-"));
    temporaryDirectories.push(root);
    const db = openDatabase(join(root, "registry.db"));
    try {
      db.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          root_path TEXT NOT NULL UNIQUE,
          remote_url TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_opened_at TEXT NOT NULL
        );
        INSERT INTO projects VALUES ('prj_legacy', 'Legacy', 'C:/legacy', NULL, 'now', 'now', 'now');
      `);
      db.pragma("user_version = 1");
      migrateRegistry(db);
      expect(db.pragma("user_version", { simple: true })).toBe(3);
      expect(db.prepare("SELECT storage_layout FROM projects").pluck().get()).toBeNull();
      expect(db.prepare("SELECT name FROM projects WHERE id = 'prj_legacy'").pluck().get()).toBe("Legacy");
      expect(db.prepare("SELECT archived_at FROM projects WHERE id = 'prj_legacy'").pluck().get()).toBeNull();
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_memories'").get())
        .toBeTruthy();
    } finally {
      db.close();
    }
  });
});
