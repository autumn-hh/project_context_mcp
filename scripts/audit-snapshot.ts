import Database from 'better-sqlite3';
import { restoreKnowledgePack } from '../src/storage/remote-pack/pack.js';
import type { PackManifest } from '../src/storage/remote-pack/schema.js';

/** Canonical statistics must describe exactly the restorable package. */
export async function auditSnapshot(destination: string, restoreDirectory: string, allowedRoots: string[], manifest: PackManifest) {
  const restored = await restoreKnowledgePack(destination, restoreDirectory, allowedRoots);
  const db = new Database(restored.projectDatabase, { readonly: true, fileMustExist: true });
  try {
    const counts = Object.fromEntries(manifest.shards.map(s => [s.table, Number(db.prepare(`SELECT COUNT(*) FROM ${s.table}`).pluck().get())]));
    for (const table of new Set(manifest.shards.map(s => s.table))) {
      if (counts[table] !== manifest.shards.filter(s => s.table === table).reduce((n,s) => n+s.rows,0)) throw new Error(`Restore count mismatch: ${table}`);
    }
    const integrity = db.pragma('quick_check', { simple: true });
    const foreignKeys = db.pragma('foreign_key_check');
    if (integrity !== 'ok' || (foreignKeys as unknown[]).length) throw new Error('Restore integrity failed');
    const statistics = db.transaction(() => ({
      tasks: db.prepare('SELECT status,COUNT(*) AS count FROM tasks GROUP BY status').all(),
      memories: db.prepare('SELECT type,status,COUNT(*) AS count FROM memories GROUP BY type,status').all(),
      candidates: db.prepare('SELECT status,COUNT(*) AS count FROM memory_candidates GROUP BY status').all(),
      unfinished: db.prepare("SELECT id,goal,updated_at,checkpoint_json FROM tasks WHERE status='in_progress' ORDER BY id").all(),
    }))();
    return { statistics, restored: { counts, integrity, foreignKeys } };
  } finally { db.close(); }
}
