import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { SqliteDatabase } from "../database.js";
import { parseRow, type PackRow } from "./schema.js";
import { authorizeExistingPath } from "../../security/path-policy.js";
import { containsLikelySecret } from "../../indexing/file-policy.js";
import { ProjectContextError } from "../../shared/errors.js";

export interface ImportRuleOptions { apply?: boolean; allowGlobal?: boolean; workspaceRoot?: string; }

/** Explicit, independently atomic registry import; project restore itself never changes personal rules. */
export async function importPackRules(registry: SqliteDatabase, project: SqliteDatabase, projectId: string,
  source: string, allowedRoots: string[], options: ImportRuleOptions) {
  const path = await authorizeExistingPath(source, allowedRoots, "PACK_SOURCE_NOT_AUTHORIZED", "Staged rules database");
  const input = new Database(path, { readonly: true, fileMustExist: true });
  let rows: PackRow[];
  try {
    input.pragma("query_only = ON");
    rows = (input.prepare("SELECT * FROM user_memories ORDER BY id LIMIT 10001").all() as unknown[])
      .map(row => parseRow("user_memories", row));
  } finally { input.close(); }
  if (rows.length > 10000) throw new ProjectContextError("PACK_RULE_LIMIT", "Import supports at most 10000 selected rules at once.");
  const idMap = new Map(rows.map(row => [String(row.id), "umem_" + createHash("sha256").update(projectId + "/" + row.id).digest("hex").slice(0, 32)]));
  const mapped = rows.map(row => {
    if (containsLikelySecret(`${row.title}\n${row.content}\n${row.reason ?? ""}`)) {
      throw new ProjectContextError("SENSITIVE_MEMORY_REJECTED", "Staged rule contains a suspected credential or private key.");
    }
    if (row.scope_level === "user" && !options.allowGlobal) {
      throw new ProjectContextError("PACK_GLOBAL_RULE_CONFIRMATION_REQUIRED", "Global rules require explicit allowGlobal before preview or import.");
    }
    if (row.scope_level === "workspace" && (!options.workspaceRoot || !isAbsolute(options.workspaceRoot))) {
      throw new ProjectContextError("PACK_WORKSPACE_MAPPING_REQUIRED", "Workspace rules require an explicit absolute target workspace path.");
    }
    if (row.scope_level === "task" && !project.prepare("SELECT 1 FROM tasks WHERE id = ?").get(row.scope_ref)) {
      throw new ProjectContextError("PACK_RULE_TASK_MISSING", "A selected task rule refers to a task missing from the destination project.");
    }
    if (row.supersedes_id && !idMap.has(String(row.supersedes_id))) {
      throw new ProjectContextError("PACK_RULE_REFERENCE_MISSING", "Rule replacement predecessor is missing.");
    }
    const personal = row.scope_level === "user" || row.scope_level === "workspace";
    return { ...row, id: idMap.get(String(row.id))!, project_id: personal ? null : projectId,
      scope_ref: row.scope_level === "workspace" ? resolve(options.workspaceRoot!) : row.scope_ref,
      supersedes_id: row.supersedes_id ? idMap.get(String(row.supersedes_id))! : null };
  });
  return registry.transaction(() => {
    registry.pragma("defer_foreign_keys = ON");
    let added = 0; let unchanged = 0;
    for (const row of mapped) {
      const existing = registry.prepare("SELECT * FROM user_memories WHERE id = ?").get(row.id) as PackRow | undefined;
      const fields = Object.keys(row) as Array<keyof typeof row>;
      if (existing) {
        if (fields.some(field => existing[field] !== row[field])) throw new ProjectContextError("PACK_RULE_CONFLICT", "A previously imported rule has changed; existing rules were not overwritten.");
        unchanged++; continue;
      }
      added++;
      if (options.apply) registry.prepare(`INSERT INTO user_memories (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`).run(...Object.values(row));
    }
    return { applied: options.apply ?? false, added, unchanged, projectId,
      mappings: rows.map(row => ({ sourceId: row.id, targetId: idMap.get(String(row.id)), scope: row.scope_level })) };
  }).immediate();
}
