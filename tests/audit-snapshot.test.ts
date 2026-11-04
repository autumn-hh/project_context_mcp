import Database from 'better-sqlite3';
import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateProject } from '../src/storage/schema.js';
import { startTask } from '../src/tasks/task-service.js';
import { exportKnowledgePack } from '../src/storage/remote-pack/pack.js';
import { auditSnapshot } from '../scripts/audit-snapshot.js';

it('reports the restored snapshot even when a concurrent connection writes after export',async()=>{
  const root=await mkdtemp(join(tmpdir(),'audit-snapshot-'));
  const path=join(root,'source.db');const db=new Database(path);migrateProject(db);
  try {
    const original=startTask(db,'snapshot task');
    const destination=join(root,'knowledge.pack');
    const manifest=await exportKnowledgePack({db,project:{id:'fixture',name:'fixture'},destination,allowedRoots:[root]});
    const writer=new Database(path);
    try { startTask(writer,'later task'); } finally { writer.close(); }
    expect(db.prepare('SELECT COUNT(*) FROM tasks').pluck().get()).toBe(2);
    const report=await auditSnapshot(destination,join(root,'restore'),[root],manifest);
    expect(report.statistics.tasks).toEqual([{status:'in_progress',count:1}]);
    expect(report.statistics.unfinished).toHaveLength(1);
    expect(report.statistics.unfinished[0]).toMatchObject({id:original.id});
    expect(report.restored.counts.tasks).toBe(1);
  } finally {db.close();await rm(root,{recursive:true,force:true});}
});
