import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {ProjectContextApp} from '../dist/core/app.js';
import {S3RemoteStore,validateRemoteTarget,signS3Request} from '../dist/storage/remote/s3.js';
import {openDatabase} from '../dist/storage/database.js';

// Opt-in integration exercise: writes synthetic objects; use the documented restricted account.
const output=process.env.PCM_CLOUD_OUTPUT ?? 'output/cloud-acceptance';
await mkdir(output,{recursive:true});
const startedAt=new Date().toISOString();
const runId='run-'+randomUUID();const prefix='acceptance/'+runId;
const root=await mkdtemp(join(tmpdir(),'pcm-cloud-'));
const result={runId,startedAt,transport:'SSH direct-tcpip to cloud host loopback MinIO',version:JSON.parse(await readFile('package.json','utf8')).version,checks:[]};
const pass=name=>{result.checks.push({name,status:'passed'});console.log(JSON.stringify({check:name,status:'passed'}));};
const target=validateRemoteTarget({endpoint:process.env.PCM_CLOUD_ENDPOINT,region:process.env.PCM_CLOUD_REGION ?? 'us-east-1',bucket:process.env.PCM_CLOUD_BUCKET ?? 'project-context-acceptance',prefix,
  accessKeyEnv:'PCM_CLOUD_ACCESS',secretKeyEnv:'PCM_CLOUD_SECRET',passphraseEnv:'PCM_CLOUD_PASSPHRASE',allowLoopbackHttp:true});
let a,b;
try {
  Object.assign(process.env,{PROJECT_CONTEXT_HOME:join(root,'a'),PROJECT_CONTEXT_ALLOWED_ROOTS:root,PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS:root});
  a=await ProjectContextApp.create();process.env.PROJECT_CONTEXT_HOME=join(root,'b');b=await ProjectContextApp.create();
  await mkdir(join(root,'project-a'));await mkdir(join(root,'project-b'));
  const pa=(await a.openProject(join(root,'project-a'))).id,pb=(await b.openProject(join(root,'project-b'))).id;
  await a.configureRemote('cloud',target);await b.configureRemote('cloud',target);
  const marker='SYNTHETIC_CLOUD_SENTINEL_'+runId;
  const memory=a.remember(pa,{type:'decision',title:'Cloud acceptance decision',content:marker,sourceKind:'user'});
  const task=a.startTask(pa,'Synthetic cloud task');a.checkpoint(pa,task.id,{...task.checkpoint,summary:'Synthetic persisted progress'},{requestId:'acceptance:1'});
  const backup=await a.backupRemote(pa,'cloud');assert.equal(backup.historySaved,true);pass('encrypted backup upload and local receipt');
  const store=new S3RemoteStore(target);const ciphertext=join(root,'download.pcmb');
  await store.download(backup.key,ciphertext,[root]);const bytes=await readFile(ciphertext);assert.ok(!bytes.includes(Buffer.from(marker)));assert.equal(createHash('sha256').update(bytes).digest('hex'),backup.sha256);pass('remote ciphertext checksum and absence of plaintext sentinel');
  const restored=await b.restoreRemote('cloud',backup.key,join(root,'restored'));const db=openDatabase(restored.projectDatabase);
  try{assert.equal(db.prepare('SELECT content FROM memories WHERE id=?').pluck().get(memory.id),marker);assert.equal(db.prepare('SELECT COUNT(*) FROM task_events').pluck().get(),2);}finally{db.close();}pass('download decrypt and restore knowledge plus task history');
  await mkdir(join(root,'registered'));const registered=await b.restoreProject({source:restored.projectDatabase,root:join(root,'registered')});assert.ok(b.search(registered.project.id,'SYNTHETIC_CLOUD_SENTINEL').length);pass('restore registration and searchable context');
  assert.equal((await store.upload(backup.key,ciphertext,[root])).recoveredResponse,true);pass('conditional duplicate upload confirms existing immutable object');
  const changed=join(root,'different.pcmb');await writeFile(changed,Buffer.concat([bytes,Buffer.from('different')]));await assert.rejects(store.upload(backup.key,changed,[root]),{code:'REMOTE_OBJECT_CONFLICT'});pass('different bytes cannot overwrite immutable object');
  await assert.rejects(store.download(backup.key,ciphertext,[root]),{code:'REMOTE_DOWNLOAD_FAILED'});assert.deepEqual(await readFile(ciphertext),bytes);pass('existing destination preserved');
  const phrase=process.env.PCM_CLOUD_PASSPHRASE;process.env.PCM_CLOUD_PASSPHRASE='deliberately-wrong-acceptance-passphrase';
  try{await assert.rejects(b.restoreRemote('cloud',backup.key,join(root,'wrong-key')),{code:'ENCRYPTED_BACKUP_DECRYPT_FAILED'});assert.equal(await stat(join(root,'wrong-key')).then(()=>true,()=>false),false);}finally{process.env.PCM_CLOUD_PASSPHRASE=phrase;}pass('wrong passphrase rejected without destination pollution');
  const secret=process.env.PCM_CLOUD_SECRET;process.env.PCM_CLOUD_SECRET='invalid-acceptance-credential';
  try{await assert.rejects(store.list(''),{code:'REMOTE_LIST_FAILED'});}finally{process.env.PCM_CLOUD_SECRET=secret;}pass('server rejects incorrect request signature');
  const outside=new S3RemoteStore({...target,prefix:'not-authorized'});await assert.rejects(outside.upload('blocked.pcmb',ciphertext,[root]),{code:'REMOTE_HTTP_ERROR'});pass('restricted account denies outside-prefix writes');
  const noAuth=await fetch(target.endpoint+'/'+target.bucket+'/'+prefix+'/'+backup.key);assert.equal(noAuth.status,403);await noAuth.body?.cancel();pass('anonymous read rejected');
  const deleteRequest=signS3Request(target,'DELETE',backup.key,createHash('sha256').update('').digest('hex'));
  const deleteResponse=await fetch(deleteRequest.url,{method:'DELETE',headers:deleteRequest.headers});assert.equal(deleteResponse.status,403);await deleteResponse.body?.cancel();pass('restricted account cannot delete backup objects');
  await a.configureSync(pa,{syncId:runId,remoteName:'cloud'});await b.configureSync(pb,{syncId:runId,remoteName:'cloud'});
  await a.syncPush(pa);await b.syncPull(pb);assert.ok(b.memories(pb).some(row=>row.id===memory.id));assert.equal(b.taskHistory(pb,task.id).total,2);pass('two independent devices exchange knowledge and task history');
  assert.equal((await b.syncPull(pb)).batches,0);pass('repeat pull is idempotent');
  a.setMemoryStatus(pa,memory.id,'stale');b.setMemoryStatus(pb,memory.id,'deleted');
  await a.syncPush(pa);await b.syncPush(pb);await a.syncPull(pa);await b.syncPull(pb);
  assert.equal(a.syncStatus(pa).conflicts,1);assert.equal(b.syncStatus(pb).conflicts,1);
  const conflict=a.syncConflicts(pa)[0];await a.resolveSyncConflict(pa,conflict.table,conflict.entity,conflict.versions.find(event=>event.payload.status==='deleted').id);
  await a.syncPush(pa);await b.syncPull(pb);assert.equal(b.syncStatus(pb).conflicts,0);assert.ok(b.memories(pb,'deleted').some(row=>row.id===memory.id));pass('concurrent deletion conflict resolves and converges');
  a.remember(pa,{type:'fact',title:'Offline queue',content:'Synthetic queued event',sourceKind:'user'});process.env.PCM_CLOUD_SECRET='invalid-acceptance-credential';
  try{await assert.rejects(a.syncPush(pa));assert.ok(a.syncStatus(pa).pending>0);}finally{process.env.PCM_CLOUD_SECRET=secret;}
  await a.syncPush(pa);await b.syncPull(pb);assert.ok(b.memories(pb).some(row=>row.title==='Offline queue'));pass('failed cloud push preserves local queue and retry succeeds');
  const keys=(await store.list('')).keys;assert.ok(keys.includes(backup.key));assert.ok(keys.some(key=>key.startsWith('sync/')));pass('ListObjectsV2 returns scoped backup and sync objects');
  b.close();b=await ProjectContextApp.create();assert.equal((await b.syncPull(pb)).batches,0);pass('device restart retains received-object receipts');
  result.backup={key:backup.key,sha256:backup.sha256,bytes:backup.bytes};result.prefix=prefix;result.objectCount=keys.length;result.localFixture=root;result.passed=true;
  await writeFile(join(output,'restart-check.json'),JSON.stringify({prefix,key:backup.key,sha256:backup.sha256}));
}catch(error){result.passed=false;result.error={name:error.name,code:error.code??null,message:error.message};console.error(JSON.stringify(result.error));process.exitCode=1;}
finally{a?.close();b?.close();result.completedAt=new Date().toISOString();await writeFile(join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({runId,passed:result.passed,checks:result.checks.length}));}
