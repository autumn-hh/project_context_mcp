import Database from 'better-sqlite3';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { loadGlobalConfig } from '../src/config/paths.js';
import { exportKnowledgePack } from '../src/storage/remote-pack/pack.js';
import { auditSnapshot } from './audit-snapshot.js';

// Local, read-only audit of canonical data, including stored source excerpts.
// Packages may contain private knowledge; keep outputs local. Code indexes and
// machine configuration are excluded. Each project has its own snapshot time.
const config = await loadGlobalConfig();
const target = resolve(process.argv[2] ?? `output/audit-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(target, { recursive: false });
const registry = new Database(join(config.storageRoot, 'registry.db'), { readonly: true });
const registryStartedAt = new Date().toISOString();
try { await registry.backup(join(target, 'registry.db')); } finally { registry.close(); }
const registryCompletedAt = new Date().toISOString();
const registrySnapshot = new Database(join(target, 'registry.db'), {readonly:true,fileMustExist:true});
let projects: Array<{id:string;name:string;root_path:string;archived_at:string|null;storage_layout:string}>;
try { projects = registrySnapshot.prepare('SELECT id,name,root_path,archived_at,storage_layout FROM projects ORDER BY id').all() as typeof projects; }
finally { registrySnapshot.close(); }
const report: any = { startedAt: registryStartedAt, registrySnapshot: {startedAt:registryStartedAt,completedAt:registryCompletedAt}, scope: 'all registered projects, including archived; per-project snapshots', projects: [], failures: [] };
for (const p of projects) {
  let db: Database.Database | undefined;
  try {
    const path = p.storage_layout === 'project-root' ? join(p.root_path, '.project-context/project.db') : join(config.storageRoot, 'projects', p.id, 'project.db');
    db = new Database(path, { readonly: true, fileMustExist: true });
    const destination = join(target, `${p.id}.pack`);
    const manifest = await exportKnowledgePack({ db, project: p, destination, allowedRoots: [target], includeSourceExcerpts: true });
    const {statistics,restored} = await auditSnapshot(destination, join(target, `restore-${p.id}`), [target], manifest);
    const liveIndex = db.transaction(() => ({
      readAt: new Date().toISOString(), source: 'live database; excluded from knowledge package',
      indexStatus: db!.prepare('SELECT status,COUNT(*) AS count,MAX(started_at) AS latest FROM index_runs GROUP BY status').all(),
      latestIndex: db!.prepare('SELECT id,status,started_at,completed_at FROM index_runs ORDER BY started_at DESC LIMIT 1').get(),
    }))();
    report.projects.push({ ...p, snapshotAt: manifest.createdAt, statisticsSource: 'restored package', statistics, liveIndex, backup: destination, sha256: createHash('sha256').update(await readFile(destination)).digest('hex'), restored });
    console.log(JSON.stringify({ project: p.name, restored: true, counts:restored.counts }));
  } catch (error) { report.failures.push({ project: p.id, message: String(error) }); console.error(JSON.stringify(report.failures.at(-1))); }
  finally { db?.close(); }
}
report.completedAt = new Date().toISOString();
report.uniqueUnfinished = new Set(report.projects.flatMap((p:any) => p.statistics.unfinished.map((t:any) => t.id))).size;
await writeFile(join(target, 'manifest.json'), JSON.stringify(report,null,2));
// Verify the registry backup can be opened independently as well.
await copyFile(join(target, 'registry.db'), join(target, 'registry-restore.db'));
const restoredRegistry = new Database(join(target, 'registry-restore.db'), { readonly: true });
try { if (restoredRegistry.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('Registry restore failed'); }
finally { restoredRegistry.close(); }
console.log(JSON.stringify({ target, projects: report.projects.length, failures: report.failures.length, uniqueUnfinished: report.uniqueUnfinished }));
if (report.failures.length) process.exitCode = 1;
