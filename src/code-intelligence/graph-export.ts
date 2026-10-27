import type { SqliteDatabase } from "../storage/database.js";
import { CODE_ANALYSIS_VERSION } from "./tree-sitter-analyzer.js";
import { PROJECT_SCHEMA_VERSION } from "../storage/schema.js";

/** A bounded read-only structural snapshot, never a replacement for local indexes. */
export function exportCodeGraph(db: SqliteDatabase) {
  return db.transaction(() => {
    const nodes = db.prepare(`SELECT id,name,qualified_name AS qualifiedName,kind,source_path AS path,
      start_line AS startLine,end_line AS endLine FROM symbols ORDER BY id LIMIT 5000`).all();
    const edges = db.prepare(`SELECT r.id,r.from_symbol_id AS fromId,t.to_symbol_id AS toId,
      r.relation_type AS type FROM relations r JOIN relation_targets t ON t.relation_id=r.id
      WHERE r.from_symbol_id IN (SELECT id FROM symbols ORDER BY id LIMIT 5000)
      AND t.to_symbol_id IN (SELECT id FROM symbols ORDER BY id LIMIT 5000) ORDER BY r.id LIMIT 10000`).all();
    const totalNodes = Number(db.prepare("SELECT COUNT(*) FROM symbols").pluck().get());
    const totalEdges = Number(db.prepare("SELECT COUNT(*) FROM relations r JOIN relation_targets t ON t.relation_id=r.id WHERE r.from_symbol_id IS NOT NULL AND t.to_symbol_id IS NOT NULL").pluck().get());
    const revision = db.prepare("SELECT value FROM git_state WHERE key='revision'").pluck().get() as string | undefined;
    const indexedAt = db.prepare("SELECT MAX(indexed_at) FROM sources").pluck().get() as string | null;
    return { manifest: { format: "project-context-code-graph", version: 1, schemaVersion: PROJECT_SCHEMA_VERSION,
      analysisVersion: CODE_ANALYSIS_VERSION, createdAt: new Date().toISOString(), readOnly: true,
      indexedRevision: revision || null, indexedAt,
      includesSource: false, totalNodes, totalEdges, truncated: totalNodes > nodes.length || totalEdges > edges.length,
      freshness: "Indexed state; run project index after checking out the required revision.",
    }, nodes, edges };
  })();
}
