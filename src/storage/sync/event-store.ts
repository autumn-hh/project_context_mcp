import { createHash, randomUUID } from "node:crypto";
import { z } from "zod/v4";
import type { SqliteDatabase } from "../database.js";
import { parseRow, rowSchemas, type PackTable, type PackRow } from "../remote-pack/schema.js";
import { ProjectContextError } from "../../shared/errors.js";
import { rebuildNgramIndex } from "../../search/ngram-index.js";
import { containsLikelySecret } from "../../indexing/file-policy.js";

export const SYNC_TABLES = ["memories", "memory_sources", "memory_candidates", "tasks", "task_events", "task_checkpoint_requests", "user_memories"] as const;
type SyncTable = typeof SYNC_TABLES[number];
const identifier = z.string().regex(/^[a-zA-Z0-9_.:-]{1,256}$/);
export const syncEventSchema = z.object({
  id: identifier, device: identifier, table: z.enum(SYNC_TABLES), entity: z.string().min(1).max(1024),
  parents: z.array(identifier).max(256), version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  operation: z.enum(["put", "delete"]), payload: z.unknown(),
}).strict();
export type SyncEvent = z.infer<typeof syncEventSchema>;
interface EventRow { id: string; device: string; entity_table: SyncTable; entity_id: string; parents_json: string;
  revision: number; operation: "put" | "delete"; payload_json: string | null; applied: number; pushed: number; }

export function initializeSync(db: SqliteDatabase, syncId: string, deviceId: string) {
  if (!identifier.safeParse(syncId).success || !identifier.safeParse(deviceId).success) throw new ProjectContextError("INVALID_SYNC_IDENTITY", "Invalid sync or device identity.");
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), sync_id TEXT NOT NULL, device_id TEXT NOT NULL, applying INTEGER NOT NULL DEFAULT 0, last_event TEXT);
      CREATE TABLE IF NOT EXISTS sync_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, device TEXT NOT NULL, entity_table TEXT NOT NULL, entity_id TEXT NOT NULL, parents_json TEXT NOT NULL, revision INTEGER NOT NULL, operation TEXT NOT NULL, payload_json TEXT, applied INTEGER NOT NULL DEFAULT 0, pushed INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS sync_events_pending_idx ON sync_events(applied, sequence);
      CREATE INDEX IF NOT EXISTS sync_events_outgoing_idx ON sync_events(pushed, sequence);
      CREATE INDEX IF NOT EXISTS sync_events_entity_idx ON sync_events(entity_table,entity_id);
      CREATE TABLE IF NOT EXISTS sync_heads (entity_table TEXT NOT NULL, entity_id TEXT NOT NULL, event_id TEXT NOT NULL REFERENCES sync_events(id), PRIMARY KEY(entity_table,entity_id,event_id));
      CREATE TABLE IF NOT EXISTS sync_history (entity_id TEXT PRIMARY KEY, local_sequence INTEGER NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS sync_received (object_key TEXT PRIMARY KEY, checksum TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS user_memories (id TEXT PRIMARY KEY,type TEXT NOT NULL,title TEXT NOT NULL,content TEXT NOT NULL,reason TEXT,status TEXT NOT NULL,confidence REAL NOT NULL,scope_level TEXT NOT NULL,project_id TEXT,scope_ref TEXT,source_kind TEXT NOT NULL,supersedes_id TEXT REFERENCES user_memories(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    `);
    const existing = db.prepare("SELECT sync_id,device_id FROM sync_state WHERE singleton=1").get() as { sync_id: string; device_id: string } | undefined;
    if (existing && (existing.sync_id !== syncId || existing.device_id !== deviceId)) throw new ProjectContextError("SYNC_IDENTITY_CONFLICT", "This database is already bound to another sync space or device. Use a knowledge snapshot to initialize a new replica.");
    if (existing) return;
    db.prepare("INSERT INTO sync_state(singleton,sync_id,device_id) VALUES(1,?,?)").run(syncId, deviceId);
    installTriggers(db);
    db.prepare("UPDATE sync_state SET applying=1").run();
    try {
      for (const table of SYNC_TABLES) {
        const order = table === "task_events" ? "sequence" : table === "task_checkpoint_requests" ? "task_id, request_id" : "id";
        for (const input of pagedRows(db, table, order)) {
          const row = sanitize(table, input as PackRow);
          const entity = entityKey(table, row, deviceId);
          // Identical restored records share the same baseline event, preventing false first-pair conflicts.
          const id = "base_" + hash(syncId + "/" + table + "/" + entity + "/" + canonical(row));
          const event: SyncEvent = { id, device: "baseline", table, entity, parents: [], version: 1, operation: "put", payload: row };
          insertEvent(db, event, 1, 0);
          db.prepare("INSERT INTO sync_heads VALUES (?,?,?)").run(table, entity, id);
          if (table === "task_events") db.prepare("INSERT INTO sync_history VALUES (?,?)").run(entity, row.sequence);
        }
      }
    } finally { db.prepare("UPDATE sync_state SET applying=0").run(); }
  }).immediate();
  return syncStatus(db);
}

function installTriggers(db: SqliteDatabase) {
  for (const table of SYNC_TABLES) {
    const fields = Object.keys(rowSchemas[table].shape);
    for (const operation of table === "task_events" ? ["INSERT"] : ["INSERT", "UPDATE", "DELETE"]) {
      const row = operation === "DELETE" ? "OLD" : "NEW";
      const entity = table === "task_events" ? `'history_' || lower(hex(randomblob(16)))`
        : table === "task_checkpoint_requests" ? `json_array(${row}.task_id,${row}.request_id)` : `${row}.id`;
      const payload = operation === "DELETE" ? "NULL" : `json_object(${fields.map(field => `'${field}',${table === "memory_sources" && ["source_id", "source_excerpt"].includes(field) ? "NULL" : `NEW.${field}`}`).join(",")})`;
      // History has one immutable entity per append. Its ID is reused from the just-inserted event.
      db.exec(`CREATE TRIGGER IF NOT EXISTS sync_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table}
        WHEN (SELECT applying FROM sync_state WHERE singleton=1)=0 BEGIN
          UPDATE sync_state SET last_event='evt_' || lower(hex(randomblob(16)));
          INSERT INTO sync_events(id,device,entity_table,entity_id,parents_json,revision,operation,payload_json,applied,pushed)
          SELECT last_event,device_id,'${table}',${entity},
            COALESCE((SELECT json_group_array(event_id) FROM (SELECT event_id FROM sync_heads WHERE entity_table='${table}' AND entity_id=${entity} ORDER BY event_id)),'[]'),
            1+COALESCE((SELECT MAX(e.revision) FROM sync_heads h JOIN sync_events e ON e.id=h.event_id WHERE h.entity_table='${table}' AND h.entity_id=${entity}),0),
            '${operation === "DELETE" ? "delete" : "put"}',${payload},1,0 FROM sync_state WHERE singleton=1;
          DELETE FROM sync_heads WHERE entity_table='${table}' AND entity_id=(SELECT entity_id FROM sync_events WHERE id=(SELECT last_event FROM sync_state));
          INSERT INTO sync_heads SELECT entity_table,entity_id,id FROM sync_events WHERE id=(SELECT last_event FROM sync_state);
          ${table === "task_events" ? `INSERT INTO sync_history SELECT entity_id,NEW.sequence FROM sync_events WHERE id=(SELECT last_event FROM sync_state);` : ""}
        END;`);
    }
  }
}

function* pagedRows(db: SqliteDatabase, table: SyncTable, order: string): Generator<PackRow> {
  let offset = 0;
  while (true) {
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${order} LIMIT 100 OFFSET ?`).all(offset) as PackRow[];
    if (!rows.length) return;
    yield* rows; offset += rows.length;
  }
}

export function syncStatus(db: SqliteDatabase) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='sync_state'").get()) return { configured: false as const };
  const identity = db.prepare("SELECT sync_id AS syncId, device_id AS deviceId FROM sync_state WHERE singleton=1").get() as { syncId: string; deviceId: string } | undefined;
  if (!identity) return { configured: false as const };
  const pending = Number(db.prepare("SELECT COUNT(*) FROM sync_events WHERE pushed=0").pluck().get());
  const waiting = Number(db.prepare("SELECT COUNT(*) FROM sync_events WHERE applied=0").pluck().get());
  const conflicts = Number(db.prepare("SELECT COUNT(*) FROM (SELECT 1 FROM sync_heads GROUP BY entity_table,entity_id HAVING COUNT(*)>1)").pluck().get());
  return { configured: true as const, ...identity, pending, waiting, conflicts, state: conflicts ? "conflict" : pending ? "pending" : waiting ? "waiting" : "synced" };
}
export function outgoingEvents(db: SqliteDatabase, limit = 100): SyncEvent[] {
  assertConfigured(db);
  return (db.prepare("SELECT * FROM sync_events WHERE pushed=0 ORDER BY sequence LIMIT ?").all(Math.max(1, Math.min(1000, limit))) as EventRow[]).map(fromRow);
}
export function acknowledgeEvents(db: SqliteDatabase, ids: string[]) {
  db.transaction(() => { const update = db.prepare("UPDATE sync_events SET pushed=1 WHERE id=?"); for (const id of ids) update.run(id); })();
}
export function syncConflicts(db: SqliteDatabase) {
  assertConfigured(db);
  const groups = db.prepare("SELECT entity_table,entity_id FROM sync_heads GROUP BY entity_table,entity_id HAVING COUNT(*)>1 LIMIT 100").all() as Array<{ entity_table: SyncTable; entity_id: string }>;
  return groups.map(group => ({ table: group.entity_table, entity: group.entity_id, versions: heads(db, group.entity_table, group.entity_id).map(fromRow) }));
}

export async function receiveEvents(db: SqliteDatabase, input: unknown[], options: { local?: boolean } = {}) {
  const result = applySyncEvents(db, input, options);
  if (result.applied) {
    db.exec("DELETE FROM memories_fts; INSERT INTO memories_fts(memory_id,title,content,reason) SELECT id,title,content,COALESCE(reason,'') FROM memories");
    await rebuildNgramIndex(db);
  }
  return { ...result, status: syncStatus(db) };
}

export function applySyncEvents(db: SqliteDatabase, input: unknown[], options: { local?: boolean } = {}) {
  assertConfigured(db);
  if (input.length > 1000) throw new ProjectContextError("SYNC_BATCH_LIMIT", "At most 1000 events per batch.");
  const events = input.map(value => validateEvent(value));
  const space = assertConfigured(db).syncId;
  for (const event of events) {
    if (event.table === "user_memories" && event.operation === "put") {
      const row = event.payload as PackRow;
      if (row.project_id !== space || !["project", "module", "task"].includes(String(row.scope_level))) {
        throw new ProjectContextError("SYNC_RULE_SCOPE_REJECTED", "Incoming rules must belong to this sync space and use project, module or task scope.");
      }
    }
  }
  const result = db.transaction(() => {
    db.pragma("defer_foreign_keys = ON"); db.prepare("UPDATE sync_state SET applying=1").run();
    let inserted = 0; let applied = 0;
    try {
      for (const event of events) {
        const existing = db.prepare("SELECT * FROM sync_events WHERE id=?").get(event.id) as EventRow | undefined;
        if (existing) {
          if (canonical(fromRow(existing)) !== canonical(event)) throw new ProjectContextError("SYNC_EVENT_COLLISION", "An event ID was reused with different content.");
          continue;
        }
        if(event.table === "task_events") {
          const history = db.prepare("SELECT * FROM sync_events WHERE entity_table='task_events' AND entity_id=? LIMIT 1").get(event.entity) as EventRow | undefined;
          if(history && canonical(fromRow(history).payload) !== canonical(event.payload)) throw new ProjectContextError("SYNC_HISTORY_COLLISION", "An immutable history identity was reused with different content.");
        }
        insertEvent(db, event, 0, options.local ? 0 : 1); inserted++;
      }
      let progress = true;
      while (progress) {
        progress = false;
        const pending = db.prepare("SELECT * FROM sync_events WHERE applied=0 ORDER BY revision,id LIMIT 10000").all() as EventRow[];
        for (const row of pending) {
          const event = fromRow(row);
          if (!parentsReady(db, event) || !referencesReady(db, event)) continue;
          for (const parent of event.parents) db.prepare("DELETE FROM sync_heads WHERE entity_table=? AND entity_id=? AND event_id=?").run(event.table, event.entity, parent);
          db.prepare("INSERT INTO sync_heads VALUES (?,?,?)").run(event.table, event.entity, event.id);
          db.prepare("UPDATE sync_events SET applied=1 WHERE id=?").run(event.id);
          projectEntity(db, event.table, event.entity);
          applied++; progress = true;
        }
      }
    } finally { db.prepare("UPDATE sync_state SET applying=0").run(); }
    return { inserted, applied };
  }).immediate();
  return result;
}

export async function resolveSyncConflict(db: SqliteDatabase, table: SyncTable, entity: string, chosenEventId: string) {
  const state = assertConfigured(db);
  const versions = heads(db, table, entity);
  if (versions.length < 2 || !versions.some(row => row.id === chosenEventId)) throw new ProjectContextError("SYNC_CONFLICT_CHANGED", "Conflict changed or selected version is unavailable.");
  const chosen = fromRow(versions.find(row => row.id === chosenEventId)!);
  const event = { ...chosen, id: "evt_" + randomUUID(), device: state.deviceId,
    parents: versions.map(row => row.id).sort(), version: Math.max(...versions.map(row => row.revision)) + 1 };
  return receiveEvents(db, [event], { local: true });
}

function validateEvent(input: unknown): SyncEvent {
  const parsed = syncEventSchema.safeParse(input);
  if (!parsed.success) throw new ProjectContextError("INVALID_SYNC_EVENT", "Invalid event envelope.");
  const event = parsed.data;
  if(event.table === "task_events" && (event.parents.length || event.version !== 1)) throw new ProjectContextError("INVALID_SYNC_EVENT", "Task history is append-only and cannot have revisions.");
  if (new Set(event.parents).size !== event.parents.length || event.parents.includes(event.id)) throw new ProjectContextError("INVALID_SYNC_EVENT", "Invalid event ancestry.");
  if (event.operation === "delete") {
    if (event.payload !== null || event.table === "task_events") throw new ProjectContextError("INVALID_SYNC_EVENT", "Invalid history deletion or tombstone.");
  } else {
    const row = parseRow(event.table, event.payload);
    if ((event.table === "memories" || event.table === "user_memories") && containsLikelySecret(`${row.title}\n${row.content}\n${row.reason ?? ""}`)) {
      throw new ProjectContextError("SENSITIVE_MEMORY_REJECTED", "Incoming memory contains a suspected credential or private key.");
    }
    if (event.table !== "task_events" && entityKey(event.table, row, event.device) !== event.entity) throw new ProjectContextError("INVALID_SYNC_EVENT", "Event entity and payload identity disagree.");
    event.payload = sanitize(event.table, row);
  }
  return event;
}
function parentsReady(db: SqliteDatabase, event: SyncEvent): boolean {
  let revision = 0;
  for (const parent of event.parents) {
    const row = db.prepare("SELECT * FROM sync_events WHERE id=?").get(parent) as EventRow | undefined;
    if (!row) return false;
    if (row.entity_table !== event.table || row.entity_id !== event.entity) throw new ProjectContextError("INVALID_SYNC_ANCESTRY", "Event parent belongs to another entity.");
    if(row.revision >= event.version) throw new ProjectContextError("INVALID_SYNC_REVISION", "Cyclic or non-increasing event revision.");
    if(!row.applied) return false;
    revision = Math.max(revision, row.revision);
  }
  if (event.version !== revision + 1) throw new ProjectContextError("INVALID_SYNC_REVISION", "Event revision does not follow its parents.");
  return true;
}
function referencesReady(db: SqliteDatabase, event: SyncEvent): boolean {
  if (event.operation === "delete") return true;
  const row = event.payload as PackRow;
  if (["memories", "user_memories"].includes(event.table) && row.supersedes_id && !db.prepare(`SELECT 1 FROM ${event.table} WHERE id=?`).get(row.supersedes_id)) return false;
  if (event.table === "memory_sources" && !db.prepare("SELECT 1 FROM memories WHERE id=?").get(row.memory_id)) return false;
  if (["task_events", "task_checkpoint_requests"].includes(event.table) && !db.prepare("SELECT 1 FROM tasks WHERE id=?").get(row.task_id)) return false;
  return true;
}
function projectEntity(db: SqliteDatabase, table: SyncTable, entity: string) {
  const versions = heads(db, table, entity).sort((a, b) => {
    const deleted = (row: EventRow) => row.operation === "delete" || JSON.parse(row.payload_json ?? "null")?.status === "deleted";
    return Number(deleted(b)) - Number(deleted(a)) || b.revision - a.revision || (a.id < b.id ? 1 : -1);
  });
  const winner = versions[0]!;
  if (winner.operation === "delete") {
    if (table === "memories" || table === "user_memories") { db.prepare(`UPDATE ${table} SET status='deleted' WHERE id=?`).run(entity); return; }
    if (table === "task_checkpoint_requests") { const key = JSON.parse(entity) as string[]; db.prepare("DELETE FROM task_checkpoint_requests WHERE task_id=? AND request_id=?").run(...key); return; }
    // Tasks/history are durable records. Public APIs never physically delete tasks.
    if (table === "tasks") { db.prepare("UPDATE tasks SET status='cancelled' WHERE id=?").run(entity); return; }
    db.prepare(`DELETE FROM ${table} WHERE id=?`).run(entity); return;
  }
  const row = JSON.parse(winner.payload_json!) as PackRow;
  if ((table === "memories" || table === "user_memories") && versions.length > 1 && row.status !== "deleted") row.status = "conflicted";
  if (table === "task_events") {
    if (db.prepare("SELECT 1 FROM sync_history WHERE entity_id=?").get(entity)) return;
    delete row.sequence;
    const keys = Object.keys(row);
    const result = db.prepare(`INSERT INTO task_events(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`).run(...Object.values(row));
    db.prepare("INSERT INTO sync_history VALUES (?,?)").run(entity, result.lastInsertRowid); return;
  }
  const keys = Object.keys(row); const primary = table === "task_checkpoint_requests" ? ["task_id", "request_id"] : ["id"];
  db.prepare(`INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})
    ON CONFLICT(${primary.join(",")}) DO UPDATE SET ${keys.filter(key => !primary.includes(key)).map(key => `${key}=excluded.${key}`).join(",")}`).run(...Object.values(row));
  if (table === "memory_sources") db.prepare("INSERT OR REPLACE INTO metadata VALUES('knowledge_pack_rebind','1')").run();
}
function heads(db: SqliteDatabase, table: SyncTable, entity: string): EventRow[] {
  return db.prepare("SELECT e.* FROM sync_heads h JOIN sync_events e ON e.id=h.event_id WHERE h.entity_table=? AND h.entity_id=?").all(table, entity) as EventRow[];
}
function insertEvent(db: SqliteDatabase, event: SyncEvent, applied: number, pushed: number) {
  db.prepare("INSERT INTO sync_events(id,device,entity_table,entity_id,parents_json,revision,operation,payload_json,applied,pushed) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(event.id, event.device, event.table, event.entity, JSON.stringify(event.parents), event.version, event.operation, event.payload === null ? null : JSON.stringify(event.payload), applied, pushed);
}
function fromRow(row: EventRow): SyncEvent {
  return { id: row.id, device: row.device, table: row.entity_table, entity: row.entity_id, parents: JSON.parse(row.parents_json),
    version: row.revision, operation: row.operation, payload: row.payload_json === null ? null : JSON.parse(row.payload_json) };
}
function entityKey(table: SyncTable, row: PackRow, _device: string): string {
  if (table === "task_events") return "history_base_" + hash(canonical(row));
  return table === "task_checkpoint_requests" ? JSON.stringify([row.task_id, row.request_id]) : String(row.id);
}
function sanitize(table: PackTable, row: PackRow): PackRow {
  return table === "memory_sources" ? { ...row, source_id: null, source_excerpt: null } : row;
}
function assertConfigured(db: SqliteDatabase) {
  const state = syncStatus(db);
  if (!state.configured) throw new ProjectContextError("SYNC_NOT_CONFIGURED", "Configure this project sync space first.");
  return state;
}
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort) : item && typeof item === "object"
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, sort(value)])) : item;
  return JSON.stringify(sort(value));
}
