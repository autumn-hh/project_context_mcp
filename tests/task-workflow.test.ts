import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { migrateProject } from '../src/storage/schema.js';
import { startTask, checkpointTask, completeTask, cancelTask, reopenTask, getTask, listTaskHistory, type TaskCheckpoint } from '../src/tasks/task-service.js';
import { queryTasks, queryTaskSummaries } from '../src/tasks/task-query.js';
import { rowSchemas } from '../src/storage/remote-pack/schema.js';
let db: Database.Database;
beforeEach(()=>{db=new Database(':memory:');migrateProject(db);});
afterEach(()=>db.close());
const ready=():TaskCheckpoint=>({summary:'Full download and startup verified',completed:['implemented'],next:[],changedFiles:[],verification:[],blockers:[],risks:[],stage:'acceptance',acceptance:[{criterion:'Full download and window startup',status:'passed',evidence:'tool:download-and-launch'}]});
it('preserves omitted checkpoint fields, clears explicit arrays and never replays an old patch',()=>{
  const task=startTask(db,'required checks');
  checkpointTask(db,task.id,{...ready(),next:['launch'],blockers:['device'],verification:[{command:'launch',status:'failed'}]});
  const note=checkpointTask(db,task.id,{summary:'implementation ready'},{requestId:'note'});
  expect(note.checkpoint.next).toEqual(['launch']);
  expect(note.checkpoint.blockers).toEqual(['device']);
  expect(note.checkpoint.verification).toHaveLength(1);
  expect(()=>completeTask(db,task.id)).toThrow();
  checkpointTask(db,task.id,{next:[],blockers:[],verification:[],summary:'verified later'});
  const retry=checkpointTask(db,task.id,{summary:'implementation ready'},{requestId:'note'});
  expect(retry.checkpoint).toMatchObject({summary:'verified later',next:[],blockers:[],verification:[]});
});
it('requires the latest result of each listed verification to pass',()=>{
  const task=startTask(db,'verify');
  for(const status of ['failed','pending','skipped','unknown']) {
    expect(()=>completeTask(db,task.id,{...ready(),verification:[{command:'npm test',status}]})).toThrow();
  }
  expect(completeTask(db,task.id,{...ready(),verification:[{command:'npm test',status:'failed'},{command:'npm test',status:'passed'}]}).status).toBe('completed');
});
it('rejects completion and cancellation from a stale task view without changing history',()=>{
  const task=startTask(db,'stale close');checkpointTask(db,task.id,ready());
  const expectedRevision=listTaskHistory(db,task.id).items[0]!.sequence;
  checkpointTask(db,task.id,{summary:'newer verification scope'});
  const before=listTaskHistory(db,task.id);
  expect(()=>completeTask(db,task.id,undefined,{expectedRevision})).toThrow(expect.objectContaining({code:'TASK_UPDATE_CONFLICT'}));
  expect(()=>cancelTask(db,task.id,{expectedRevision})).toThrow(expect.objectContaining({code:'TASK_UPDATE_CONFLICT'}));
  expect(listTaskHistory(db,task.id)).toEqual(before);
});
it('does not replay a reopen across lifecycle boundaries or accept stale first requests',()=>{
  const task=startTask(db,'lifecycle');completeTask(db,task.id,ready());
  const options={requestId:'retry-1',expectedRevision:listTaskHistory(db,task.id).items[0]!.sequence};
  reopenTask(db,task.id,'launch missing',options);completeTask(db,task.id,ready());
  const before=listTaskHistory(db,task.id);
  expect(reopenTask(db,task.id,'launch missing',options).status).toBe('completed');
  expect(listTaskHistory(db,task.id)).toEqual(before);
  expect(()=>reopenTask(db,task.id,'different reason',options)).toThrow();
  expect(()=>reopenTask(db,task.id,'launch missing',{...options,requestId:'new-but-stale'})).toThrow();
});
it('blocks premature completion atomically and retains pending acceptance',()=>{
  const task=startTask(db,'Download and launch');
  const checkpoint={...ready(),acceptance:[{criterion:'Full download',status:'pending' as const}]};
  checkpointTask(db,task.id,checkpoint);
  const before=listTaskHistory(db,task.id);
  expect(()=>completeTask(db,task.id)).toThrow(expect.objectContaining({code:'TASK_ACCEPTANCE_REQUIRED'}));
  expect(listTaskHistory(db,task.id)).toEqual(before);
  expect(getTask(db,task.id).status).toBe('in_progress');
  for(const partial of [{acceptance:[]},{next:['verify startup']},{blockers:['device missing']},{acceptance:[{criterion:'startup',status:'passed' as const}]},{summary:'',completed:[]},{stage:'waiting' as const,waitingReason:'device'}]){
    expect(()=>completeTask(db,task.id,{...ready(),...partial})).toThrow();
  }
  expect(completeTask(db,task.id,ready()).status).toBe('completed');
});
it('requires explicit reopening before post-completion verification and preserves old timestamps',()=>{
  const task=startTask(db,'Launch'); const done=completeTask(db,task.id,ready());
  const evidence={...ready(),verification:[{command:'new required validation',status:'passed'}]};
  expect(()=>checkpointTask(db,task.id,evidence)).toThrow(expect.objectContaining({code:'TASK_REOPEN_REQUIRED'}));
  expect(checkpointTask(db,task.id,{...done.checkpoint,summary:'Additional explanation'}).completedAt).toBe(done.completedAt);
  const options={source:'test',requestId:'reopen-test',expectedRevision:listTaskHistory(db,task.id).items[0]!.sequence};
  const reopened=reopenTask(db,task.id,'Required hardware validation omitted',options);
  expect(reopened.completedAt).toBeNull();
  expect(reopened.checkpoint.stage).toBe('acceptance');
  expect(()=>completeTask(db,task.id)).toThrow();
  expect(listTaskHistory(db,task.id).items.find(e=>e.kind==='completed')?.snapshot.completedAt).toBe(done.completedAt);
  expect(listTaskHistory(db,task.id).items[0]?.source).toBe('test:reopen');
  expect(reopenTask(db,task.id,'Required hardware validation omitted',options)).toEqual(reopened);
  expect(()=>reopenTask(db,task.id,'unguarded')).toThrow();
});
it('keeps omitted workflow fields across legacy checkpoints and rejects stale writes',()=>{
  const task=startTask(db,'waiting',{stage:'waiting',waitingReason:'permission',acceptance:[{criterion:'validate',status:'pending'}]});
  const {stage,acceptance,...legacy}=ready();
  const current=checkpointTask(db,task.id,legacy,{requestId:'first'});
  expect(current.checkpoint).toMatchObject({stage:'waiting',waitingReason:'permission',acceptance:task.checkpoint.acceptance});
  expect(()=>checkpointTask(db,task.id,ready(),{expectedUpdatedAt:'old'})).toThrow(expect.objectContaining({code:'TASK_UPDATE_CONFLICT'}));
  expect(()=>checkpointTask(db,task.id,{...ready(),stage:'waiting'})).not.toThrow();
  expect(()=>startTask(db,'pause',{stage:'paused'})).toThrow();
});
it('filters stages before pagination; legacy tasks remain untriaged without rewriting history',()=>{
  const legacy=startTask(db,'legacy');
  db.prepare("UPDATE tasks SET checkpoint_json=json_remove(checkpoint_json,'$.stage') WHERE id=?").run(legacy.id);
  for(let i=0;i<15;i++) startTask(db,`backlog${i}`,{stage:'backlog'});
  const waiting=startTask(db,'wait',{stage:'waiting',waitingReason:'device'});
  expect(queryTasks(db,{stage:'backlog',limit:10,offset:10}).items).toHaveLength(5);
  expect(queryTaskSummaries(db,{stage:'untriaged'}).items.map(t=>t.id)).toEqual([legacy.id]);
  expect(queryTaskSummaries(db,{stage:'waiting'}).items[0]).toMatchObject({id:waiting.id,waitingReason:'device'});
});
it('preserves new fields through strict backup/sync row validation',()=>{
  const task=startTask(db,'done');completeTask(db,task.id,ready());
  reopenTask(db,task.id,'omitted validation',{requestId:'backup-reopen',expectedRevision:listTaskHistory(db,task.id).items[0]!.sequence});
  expect(rowSchemas.tasks.safeParse(db.prepare('SELECT * FROM tasks').get()).success).toBe(true);
  for(const event of db.prepare('SELECT * FROM task_events').all()) expect(rowSchemas.task_events.safeParse(event).success).toBe(true);
});
it('rejects a stale revision even if two updates have the same timestamp',()=>{
  const task=startTask(db,'concurrent updates');const revision=listTaskHistory(db,task.id).items[0]!.sequence;
  const newer=checkpointTask(db,task.id,{...ready(),summary:'newer evidence'});
  db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(task.updatedAt,task.id);
  expect(()=>checkpointTask(db,task.id,ready(),{expectedUpdatedAt:task.updatedAt,expectedRevision:revision}))
    .toThrow(expect.objectContaining({code:'TASK_UPDATE_CONFLICT'}));
  expect(getTask(db,task.id).checkpoint).toEqual(newer.checkpoint);
});
