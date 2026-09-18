import type { SqliteDatabase } from "./database.js";

export const REGISTRY_SCHEMA_VERSION = 3;
export const PROJECT_SCHEMA_VERSION = 7;

export function migrateRegistry(db: SqliteDatabase): void {
  migrate(db, "projects", [{ version: 1, sql: `
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL UNIQUE,
      remote_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_opened_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS projects_remote_url_idx ON projects(remote_url);
  ` }, { version: 2, sql: `
    ALTER TABLE projects ADD COLUMN archived_at TEXT;
    CREATE INDEX IF NOT EXISTS projects_archived_at_idx ON projects(archived_at);

    CREATE TABLE IF NOT EXISTS user_memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      reason TEXT,
      status TEXT NOT NULL,
      confidence REAL NOT NULL,
      scope_level TEXT NOT NULL,
      project_id TEXT,
      scope_ref TEXT,
      source_kind TEXT NOT NULL,
      supersedes_id TEXT REFERENCES user_memories(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS user_memories_status_idx ON user_memories(status);
    CREATE INDEX IF NOT EXISTS user_memories_scope_idx
      ON user_memories(scope_level, project_id, scope_ref, status);
  ` }, { version: 3, sql: `
    ALTER TABLE projects ADD COLUMN storage_layout TEXT;
  ` }]);
}

export function migrateProject(db: SqliteDatabase): void {
  migrate(db, "sources", [
    { version: 1, sql: `
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      modified_ms REAL NOT NULL,
      indexed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      source_path TEXT NOT NULL,
      content TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      chunk_id UNINDEXED,
      source_path,
      content,
      tokenize = 'unicode61'
    );

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      reason TEXT,
      status TEXT NOT NULL,
      confidence REAL NOT NULL,
      scope_json TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_ref TEXT,
      supersedes_id TEXT REFERENCES memories(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      memory_id UNINDEXED,
      title,
      content,
      reason,
      tokenize = 'unicode61'
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      status TEXT NOT NULL,
      checkpoint_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS index_runs (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL,
      scanned INTEGER NOT NULL DEFAULT 0,
      indexed INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0,
      removed INTEGER NOT NULL DEFAULT 0,
      errors_json TEXT NOT NULL DEFAULT '[]'
    );
  ` },
    { version: 2, sql: `
    CREATE TABLE IF NOT EXISTS symbols (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      source_path TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      signature TEXT,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      content_hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS symbols_name_idx ON symbols(name);
    CREATE INDEX IF NOT EXISTS symbols_qualified_name_idx ON symbols(qualified_name);
    CREATE INDEX IF NOT EXISTS symbols_source_id_idx ON symbols(source_id);
    CREATE TABLE IF NOT EXISTS relations (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      source_path TEXT NOT NULL,
      from_symbol_id TEXT REFERENCES symbols(id) ON DELETE CASCADE,
      from_name TEXT NOT NULL,
      to_name TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      evidence TEXT
    );
    CREATE INDEX IF NOT EXISTS relations_from_name_idx ON relations(from_name);
    CREATE INDEX IF NOT EXISTS relations_to_name_idx ON relations(to_name);
    CREATE INDEX IF NOT EXISTS relations_source_id_idx ON relations(source_id);

    CREATE TABLE IF NOT EXISTS git_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      captured_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_sources (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      source_kind TEXT NOT NULL,
      source_ref TEXT,
      source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
      source_hash TEXT,
      start_line INTEGER,
      end_line INTEGER,
      git_commit TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memory_sources_memory_idx ON memory_sources(memory_id);
    CREATE INDEX IF NOT EXISTS memory_sources_source_idx ON memory_sources(source_id);

    CREATE TABLE IF NOT EXISTS memory_candidates (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      reason TEXT,
      confidence REAL NOT NULL,
      scope_json TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_ref TEXT,
      evidence_json TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memory_candidates_status_idx ON memory_candidates(status);
  ` },
    { version: 3, sql: `
    CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
      symbol_id UNINDEXED,
      name,
      qualified_name,
      signature,
      tokenize = 'unicode61'
    );
    ` },
    { version: 4, sql: `
    CREATE TABLE IF NOT EXISTS search_ngrams (
      term TEXT NOT NULL,
      item_kind TEXT NOT NULL,
      item_id TEXT NOT NULL,
      PRIMARY KEY (term, item_kind, item_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS search_ngrams_item_idx ON search_ngrams(item_kind, item_id);
    INSERT OR IGNORE INTO metadata (key, value)
    SELECT 'ngram_schema_version', '1'
    WHERE NOT EXISTS (SELECT 1 FROM sources);
    ` },
    { version: 5, sql: `
    CREATE INDEX IF NOT EXISTS chunks_source_id_idx ON chunks(source_id);
    ` },
    { version: 6, sql: `
    ALTER TABLE memory_sources ADD COLUMN source_excerpt TEXT;
    ALTER TABLE memory_sources ADD COLUMN source_excerpt_hash TEXT;
    ` },
    { version: 7, sql: `
    ALTER TABLE index_runs ADD COLUMN log_json TEXT;
    CREATE INDEX IF NOT EXISTS index_runs_started_idx ON index_runs(started_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS index_runs_status_started_idx ON index_runs(status, started_at DESC, id DESC);
    ` },
  ]);
}

interface Migration {
  version: number;
  sql: string;
}

function migrate(db: SqliteDatabase, legacyTable: string, migrations: Migration[]): void {
  let current = db.pragma("user_version", { simple: true }) as number;
  if (current === 0 && tableExists(db, legacyTable)) {
    current = 1;
    db.pragma("user_version = 1");
  }
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    })();
    current = migration.version;
  }
}

function tableExists(db: SqliteDatabase, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}
