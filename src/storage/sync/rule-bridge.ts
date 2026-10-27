import type { SqliteDatabase } from "../database.js";
import { rowSchemas, parseRow, type PackRow } from "../remote-pack/schema.js";
import { ProjectContextError } from "../../shared/errors.js";
import { containsLikelySecret } from "../../indexing/file-policy.js";
import { applySyncEvents, type SyncEvent } from "./event-store.js";

/** Registry writes and queue entries commit together; project ingestion has replay receipts. */
export function initializeRuleBridge(registry: SqliteDatabase, project: SqliteDatabase, projectId: string, syncId: string) {
  registry.transaction(() => {
    registry.exec(`
      CREATE TABLE IF NOT EXISTS sync_rule_control(singleton INTEGER PRIMARY KEY CHECK(singleton=1),applying INTEGER NOT NULL DEFAULT 0,last_event TEXT);
      INSERT OR IGNORE INTO sync_rule_control(singleton,applying) VALUES(1,0);
      CREATE TABLE IF NOT EXISTS sync_rule_projects(project_id TEXT PRIMARY KEY,sync_id TEXT NOT NULL,device_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_rule_outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL,payload_json TEXT NOT NULL,event_id TEXT NOT NULL,parents_json TEXT NOT NULL,revision INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sync_rule_outbox_project ON sync_rule_outbox(project_id,sequence);
      CREATE TABLE IF NOT EXISTS sync_rule_heads(project_id TEXT NOT NULL,rule_id TEXT NOT NULL,event_id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(project_id,rule_id,event_id));
    `);
    const fields = Object.keys(rowSchemas.user_memories.shape);
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      const row = operation === "DELETE" ? "OLD" : "NEW";
      const json = `json_object(${fields.map(field => `'${field}',${operation === "DELETE" && field === "status" ? "'deleted'" : `${row}.${field}`}`).join(",")})`;
      registry.exec(`CREATE TRIGGER IF NOT EXISTS sync_rule_${operation.toLowerCase()} AFTER ${operation} ON user_memories
        WHEN (SELECT applying FROM sync_rule_control)=0 AND ${row}.project_id IN (SELECT project_id FROM sync_rule_projects) BEGIN
        UPDATE sync_rule_control SET last_event='rule_' || lower(hex(randomblob(16)));
        INSERT INTO sync_rule_outbox(project_id,payload_json,event_id,parents_json,revision)
          SELECT ${row}.project_id,${json},last_event,
            COALESCE((SELECT json_group_array(event_id) FROM (SELECT event_id FROM sync_rule_heads WHERE project_id=${row}.project_id AND rule_id=${row}.id ORDER BY event_id)),'[]'),
            1+COALESCE((SELECT MAX(revision) FROM sync_rule_heads WHERE project_id=${row}.project_id AND rule_id=${row}.id),0) FROM sync_rule_control;
        DELETE FROM sync_rule_heads WHERE project_id=${row}.project_id AND rule_id=${row}.id;
        INSERT INTO sync_rule_heads SELECT ${row}.project_id,${row}.id,event_id,revision FROM sync_rule_outbox WHERE event_id=(SELECT last_event FROM sync_rule_control);
        END;`);
    }
    const existing = registry.prepare("SELECT sync_id FROM sync_rule_projects WHERE project_id=?").pluck().get(projectId);
    if (existing && existing !== syncId) throw new ProjectContextError("SYNC_RULE_SPACE_CONFLICT", "Project rules already belong to another sync space.");
    if (!existing) {
      const device = project.prepare("SELECT device_id FROM sync_state WHERE singleton=1").pluck().get();
      registry.prepare("INSERT INTO sync_rule_projects VALUES (?,?,?)").run(projectId, syncId, device);
      for (const row of registry.prepare("SELECT id FROM user_memories WHERE project_id=? ORDER BY created_at,id").all(projectId)) {
        // A no-op update passes through the same atomic event/causal-head trigger.
        registry.prepare("UPDATE user_memories SET updated_at=updated_at WHERE id=?").run((row as PackRow).id);
      }
    }
  }).immediate();
  project.exec("CREATE TABLE IF NOT EXISTS sync_rule_receipts(registry_sequence INTEGER PRIMARY KEY);");
}

export function drainRuleOutbox(registry: SqliteDatabase, project: SqliteDatabase, projectId: string, syncId: string) {
  const rows = registry.prepare("SELECT sequence,payload_json,event_id,parents_json,revision FROM sync_rule_outbox WHERE project_id=? ORDER BY sequence LIMIT 1000").all(projectId) as Array<{ sequence: number; payload_json: string; event_id: string; parents_json: string; revision: number }>;
  const device = registry.prepare("SELECT device_id FROM sync_rule_projects WHERE project_id=?").pluck().get(projectId) as string;
  project.transaction(() => {
    const events: SyncEvent[] = [];
    for (const entry of rows) {
      if (project.prepare("SELECT 1 FROM sync_rule_receipts WHERE registry_sequence=?").get(entry.sequence)) continue;
      const row = parseRow("user_memories", JSON.parse(entry.payload_json));
      row.project_id = syncId;
      events.push({ id: entry.event_id, device, table: "user_memories", entity: String(row.id), parents: JSON.parse(entry.parents_json), version: entry.revision, operation: "put", payload: row });
      project.prepare("INSERT INTO sync_rule_receipts VALUES(?)").run(entry.sequence);
    }
    applySyncEvents(project, events, { local: true });
  }).immediate();
  registry.transaction(() => {
    const remove = registry.prepare("DELETE FROM sync_rule_outbox WHERE sequence=? AND project_id=?");
    for (const entry of rows) remove.run(entry.sequence, projectId);
  }).immediate();
  return rows.length;
}

export function applyRuleProjection(registry: SqliteDatabase, project: SqliteDatabase, projectId: string, syncId: string) {
  return registry.transaction(() => {
    // Hold the registry write lock while ingesting its outbox and projecting remote state.
    // Edits capture their causal parents at write time, even if another process pulls meanwhile.
    while (drainRuleOutbox(registry, project, projectId, syncId) === 1000) { /* bounded ingestion batches */ }
    registry.pragma("defer_foreign_keys = ON"); registry.prepare("UPDATE sync_rule_control SET applying=1").run();
    let applied = 0;
    try {
      for (const value of project.prepare("SELECT * FROM user_memories ORDER BY id").iterate()) {
        const row = parseRow("user_memories", value);
        if (row.project_id !== syncId || !["project", "module", "task"].includes(String(row.scope_level))) {
          throw new ProjectContextError("SYNC_RULE_SCOPE_REJECTED", "This sync space only accepts its own project-scoped rules.");
        }
        if (containsLikelySecret(`${row.title}\n${row.content}\n${row.reason ?? ""}`)) throw new ProjectContextError("SENSITIVE_MEMORY_REJECTED", "Incoming rule contains a suspected credential.");
        const existing = registry.prepare("SELECT * FROM user_memories WHERE id=?").get(row.id) as PackRow | undefined;
        if (existing && existing.project_id !== projectId) throw new ProjectContextError("SYNC_RULE_ID_COLLISION", "Rule identity exists outside this local project; it was not overwritten.");
        row.project_id = projectId;
        registry.prepare("DELETE FROM sync_rule_heads WHERE project_id=? AND rule_id=?").run(projectId, row.id);
        for (const head of project.prepare("SELECT e.id,e.revision FROM sync_heads h JOIN sync_events e ON e.id=h.event_id WHERE h.entity_table='user_memories' AND h.entity_id=?").all(row.id) as Array<{ id: string; revision: number }>) {
          registry.prepare("INSERT INTO sync_rule_heads VALUES(?,?,?,?)").run(projectId, row.id, head.id, head.revision);
        }
        const keys = Object.keys(row);
        if (existing && keys.every(key => existing[key] === row[key])) continue;
        registry.prepare(`INSERT INTO user_memories(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})
          ON CONFLICT(id) DO UPDATE SET ${keys.filter(key => key !== "id").map(key => `${key}=excluded.${key}`).join(",")}`).run(...Object.values(row));
        applied++;
      }
    } finally { registry.prepare("UPDATE sync_rule_control SET applying=0").run(); }
    return applied;
  }).immediate();
}
