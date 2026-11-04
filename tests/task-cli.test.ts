import { it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

it('CLI partial checkpoints preserve required work and only explicit clears remove it',async()=>{
  const root=await mkdtemp(join(tmpdir(),'task-cli-'));
  const env={...process.env,PROJECT_CONTEXT_HOME:join(root,'memory'),PROJECT_CONTEXT_ALLOWED_ROOTS:root};
  const run=async(...args:string[])=>JSON.parse((await promisify(execFile)(process.execPath,['--import','tsx',resolve('src/cli.ts'),...args],{env})).stdout);
  try {
    const project=join(root,'project');await mkdir(project);
    const opened=await run('project','open',project);
    const task=await run('task','start',opened.id,'CLI required work');
    await expect(run('task','start',opened.id,'Missing waiting reason','--stage','waiting')).rejects.toThrow();
    for (const stage of ['waiting','paused']) {
      const waiting=await run('task','start',opened.id,`CLI ${stage}`,'--stage',stage,'--waiting-reason','Explicit fixture condition');
      expect(waiting.checkpoint).toMatchObject({stage,waitingReason:'Explicit fixture condition'});
      const filtered=await run('task','query','--project',opened.id,'--stage',stage);
      expect(filtered.items.map((item:{id:string})=>item.id)).toEqual([waiting.id]);
    }
    await run('task','checkpoint',opened.id,task.id,'--next','launch','--blocker','device');
    const note=await run('task','checkpoint',opened.id,task.id,'--summary','implemented');
    expect(note.checkpoint).toMatchObject({next:['launch'],blockers:['device']});
    const cleared=await run('task','checkpoint',opened.id,task.id,'--clear','next','blockers');
    expect(cleared.checkpoint).toMatchObject({next:[],blockers:[],summary:'implemented'});
    await expect(run('task','cancel',opened.id,task.id,'--expected-revision','0')).rejects.toThrow();
    const history=await run('task','history',opened.id,task.id);
    expect((await run('task','cancel',opened.id,task.id,'--expected-revision',String(history.items[0].sequence))).status).toBe('cancelled');
  } finally {await rm(root,{recursive:true,force:true});}
},30000);
