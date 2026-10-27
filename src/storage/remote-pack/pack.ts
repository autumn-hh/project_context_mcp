import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, linkSync, mkdirSync, mkdtempSync, openSync, readSync,
  rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { TextDecoder } from "node:util";
import type { Statement } from "better-sqlite3";
import { authorizeExistingPath, authorizeOutputPath } from "../../security/path-policy.js";
import { ProjectContextError } from "../../shared/errors.js";
import { openDatabase, type SqliteDatabase } from "../database.js";
import { migrateProject, migrateRegistry } from "../schema.js";
import { rebuildNgramIndex } from "../../search/ngram-index.js";
import { invalidPack, manifestSchema, PACK_LIMITS, PACK_MAGIC, parseRow, TABLES,
  type PackManifest, type PackRow, type PackTable } from "./schema.js";

export interface ExportPackOptions {
  db: SqliteDatabase; project: { id: string; name: string }; destination: string; allowedRoots: string[];
  registry?: SqliteDatabase; userMemoryIds?: string[]; includeSourceExcerpts?: boolean;
}

/** Each database snapshot is consistent; the two independent databases have no global snapshot. */
export async function exportKnowledgePack(options: ExportPackOptions): Promise<PackManifest> {
  const target = await authorizeOutputPath(options.destination, options.allowedRoots);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = mkdtempSync(join(dirname(target), ".remote-pack-"));
  try {
    const bodyPath = join(temporary, "body");
    const fd = openSync(bodyPath, "wx", 0o600);
    const manifest: PackManifest = { format: "project-context-knowledge-pack", version: 1, kind: "snapshot",
      schemaVersion: options.db.pragma("user_version", { simple: true }) as PackManifest["schemaVersion"],
      sourceProject: { id: options.project.id, name: options.project.name }, createdAt: new Date().toISOString(),
      policy: { codeIndex: false, sourceExcerpts: options.includeSourceExcerpts ?? false,
        userRules: "explicit-selection", registrySnapshotAt: null }, shards: [] };
    let total = 0;
    try {
      const writeTable = (table: PackTable, rows: Iterable<unknown>) => {
        let parts: Buffer[] = []; let bytes = 0; let count = 0;
        const flush = () => {
          if (!count) return;
          const shard = Buffer.concat(parts, bytes);
          total += bytes;
          if (total > PACK_LIMITS.total - PACK_LIMITS.manifest - 13 || manifest.shards.length >= PACK_LIMITS.shards) {
            invalidPack("Knowledge snapshot exceeds package limits.");
          }
          writeAll(fd, shard);
          manifest.shards.push({ table, rows: count, bytes, sha256: digest(shard) });
          parts = []; bytes = 0; count = 0;
        };
        for (const value of rows) {
          const row = { ...value as PackRow };
          if (table === "memory_sources") { row.source_id = null; if (!options.includeSourceExcerpts) row.source_excerpt = null; }
          const encoded = Buffer.from(JSON.stringify(parseRow(table, row)) + "\n");
          if (encoded.length > PACK_LIMITS.row) invalidPack("Knowledge record exceeds package limits.");
          if (bytes + encoded.length > PACK_LIMITS.shard) flush();
          parts.push(encoded); bytes += encoded.length; count++;
        }
        flush();
      };
      options.db.transaction(() => {
        for (const table of TABLES.filter(table => table !== "user_memories")) {
          const order = table === "task_events" ? "sequence" : table === "task_checkpoint_requests" ? "task_id, request_id" : "id";
          writeTable(table, options.db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).iterate());
        }
      })();
      if (options.userMemoryIds?.length) {
        if (!options.registry) invalidPack("A registry is required for selected user rules.");
        const registry = options.registry;
        registry.transaction(() => {
          writeTable("user_memories", selectedRules(registry, options.userMemoryIds!, options.project.id));
          manifest.policy.registrySnapshotAt = new Date().toISOString();
        })();
      }
    } finally { closeSync(fd); }
    const checked = parseManifest(manifest);
    const encoded = Buffer.from(JSON.stringify(checked));
    if (encoded.length > PACK_LIMITS.manifest) invalidPack("Manifest is too large.");
    const packPath = join(temporary, "pack");
    const output = openSync(packPath, "wx", 0o600);
    const body = openSync(bodyPath, "r");
    try {
      const length = Buffer.alloc(4); length.writeUInt32BE(encoded.length);
      writeAll(output, Buffer.concat([PACK_MAGIC, length, encoded]));
      const buffer = Buffer.alloc(1024 * 1024);
      let size: number; while ((size = readSync(body, buffer)) > 0) writeAll(output, buffer.subarray(0, size));
    } finally { closeSync(body); closeSync(output); }
    // Hard-link publication is atomic and never replaces an existing destination.
    linkSync(packPath, target);
    return checked;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

function* selectedRules(db: SqliteDatabase, ids: string[], projectId: string): Generator<PackRow> {
  const seen = new Set<string>();
  for (const id of ids) {
    let current: string | null = id;
    const chain = new Set<string>();
    while (current) {
      if (chain.has(current)) invalidPack("User rule replacement chain contains a cycle.");
      chain.add(current);
      if (seen.has(current)) break;
      const row = db.prepare("SELECT * FROM user_memories WHERE id = ?").get(current) as PackRow | undefined;
      if (!row) invalidPack("Selected user rule or its predecessor does not exist.");
      if (row.project_id !== null && row.project_id !== projectId) invalidPack("Selected user rule belongs to another project.");
      seen.add(current); yield row;
      current = row.supersedes_id as string | null;
    }
  }
}

export async function inspectKnowledgePack(source: string, allowedRoots: string[]): Promise<PackManifest> {
  const authorized = await authorizeExistingPath(source, allowedRoots, "PACK_SOURCE_NOT_AUTHORIZED", "Knowledge pack");
  return readPack(authorized, () => {});
}

/** Restores only into a new directory. Rules remain staged until explicit scope mapping by the caller. */
export async function restoreKnowledgePack(source: string, directory: string, allowedRoots: string[]) {
  const authorized = await authorizeExistingPath(source, allowedRoots, "PACK_SOURCE_NOT_AUTHORIZED", "Knowledge pack");
  const target = await authorizeOutputPath(directory, allowedRoots);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = mkdtempSync(join(dirname(target), ".remote-restore-"));
  let published = false; let owned = false;
  try {
    const db = openDatabase(join(temporary, "project.db"));
    const registry = openDatabase(join(temporary, "rules.db"));
    let manifest: PackManifest;
    try {
      migrateProject(db); migrateRegistry(registry);
      const inserts = new Map<PackTable, Statement<unknown[]>>();
      manifest = db.transaction(() => registry.transaction(() => {
        db.pragma("defer_foreign_keys = ON"); registry.pragma("defer_foreign_keys = ON");
        const result = readPack(authorized, (table, row) => {
          const connection = table === "user_memories" ? registry : db;
          const columns = Object.keys(row); // Keys already validated against the fixed table schema.
          let insert = inserts.get(table);
          if (!insert) {
            insert = connection.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
            inserts.set(table, insert);
          }
          insert.run(...Object.values(row));
        });
        db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_id', ?)").run(result.sourceProject.id);
        db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('knowledge_pack_rebind', '1')").run();
        db.exec("INSERT INTO memories_fts (memory_id,title,content,reason) SELECT id,title,content,COALESCE(reason,'') FROM memories");
        return result;
      })())();
      await rebuildNgramIndex(db);
      if (db.pragma("quick_check", { simple: true }) !== "ok" || registry.pragma("quick_check", { simple: true }) !== "ok") {
        invalidPack("Restored database integrity check failed.");
      }
      db.pragma("wal_checkpoint(TRUNCATE)"); registry.pragma("wal_checkpoint(TRUNCATE)");
    } finally { db.close(); registry.close(); }
    mkdirSync(target); owned = true;
    linkSync(join(temporary, "project.db"), join(target, "project.db"));
    linkSync(join(temporary, "rules.db"), join(target, "rules.db"));
    published = true;
    return { directory: target, projectDatabase: join(target, "project.db"), rulesDatabase: join(target, "rules.db"),
      rulesApplied: false as const, manifest };
  } catch (error) {
    if (error instanceof ProjectContextError) throw error;
    throw new ProjectContextError("PACK_RESTORE_FAILED", "Knowledge snapshot could not be restored; existing destinations are never replaced.");
  } finally {
    if (owned && !published) rmSync(target, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
}

function readPack(source: string, consume: (table: PackTable, row: PackRow) => void): PackManifest {
  const fd = openSync(source, constants.O_RDONLY);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > PACK_LIMITS.total) invalidPack("Invalid package size or file type.");
    const prefix = readExactly(fd, PACK_MAGIC.length + 4);
    if (!prefix.subarray(0, PACK_MAGIC.length).equals(PACK_MAGIC)) invalidPack("Unrecognized package format.");
    const length = prefix.readUInt32BE(PACK_MAGIC.length);
    if (length < 2 || length > PACK_LIMITS.manifest) invalidPack("Invalid manifest size.");
    const manifest = parseManifest(parseJson(readExactly(fd, length)));
    const expectedSize = prefix.length + length + manifest.shards.reduce((sum, shard) => sum + shard.bytes, 0);
    if (expectedSize !== stat.size) invalidPack("Package is truncated or has trailing data.");
    let previousTable = -1;
    for (const shard of manifest.shards) {
      const tableIndex = TABLES.indexOf(shard.table);
      if (tableIndex < previousTable) invalidPack("Package tables are out of order.");
      previousTable = tableIndex;
      const bytes = readExactly(fd, shard.bytes);
      if (digest(bytes) !== shard.sha256) invalidPack("Package checksum mismatch.");
      let count = 0; let offset = 0;
      for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, offset)) {
        const line = bytes.subarray(offset, end);
        if (line.length + 1 > PACK_LIMITS.row) invalidPack("Package record exceeds size limit.");
        const row = parseRow(shard.table, parseJson(line));
        if (shard.table === "memory_sources" && !manifest.policy.sourceExcerpts && row.source_excerpt !== null) {
          invalidPack("Package source excerpt contradicts its declared policy.");
        }
        if (shard.table === "user_memories" && (manifest.policy.registrySnapshotAt === null
          || (row.project_id !== null && row.project_id !== manifest.sourceProject.id))) invalidPack("Invalid rule provenance.");
        consume(shard.table, row); count++; offset = end + 1;
      }
      if (offset !== bytes.length || count !== shard.rows) invalidPack("Package record count or framing mismatch.");
    }
    return manifest;
  } finally { closeSync(fd); }
}

function parseManifest(input: unknown): PackManifest {
  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success) invalidPack("Unsupported package version, schema, or manifest.");
  return parsed.data;
}
function parseJson(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return invalidPack("Invalid UTF-8 JSON in package."); }
}
function readExactly(fd: number, length: number): Buffer {
  const buffer = Buffer.alloc(length); let offset = 0;
  while (offset < length) {
    const count = readSync(fd, buffer, offset, length - offset, null);
    if (!count) invalidPack("Truncated package.");
    offset += count;
  }
  return buffer;
}
function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset);
    if (!count) throw new ProjectContextError("PACK_WRITE_FAILED", "Package write made no progress.");
    offset += count;
  }
}
function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
