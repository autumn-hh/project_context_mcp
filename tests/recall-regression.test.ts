import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { migrateProject } from '../src/storage/schema.js';
import { remember } from '../src/memory/memory-service.js';
import { searchProject } from '../src/search/search-service.js';
import { buildProjectContext } from '../src/context/context-service.js';
import { replaceItemNgrams } from '../src/search/ngram-index.js';
import { recallMemories } from '../src/memory/recall-service.js';
import type { ProjectRecord } from '../src/projects/project-service.js';

const project: ProjectRecord = { id:'fixture', name:'fixture', rootPath:'/fixture', remoteUrl:null, createdAt:'',updatedAt:'',lastOpenedAt:'',archivedAt:null };
let db: Database.Database;
let expected: string;
beforeEach(() => {
  db = new Database(':memory:'); migrateProject(db);
  const old = remember(db,{type:'lesson',title:'比特下载400',content:'先尝试域名直连，完整下载尚未验证。',sourceKind:'tool',sourceRef:'task:old'});
  expected = remember(db,{type:'lesson', title:'比特7.2.0下载400通过NO_PROXY修复并完成156内核启动',
    content:'外部本机比特内核下载400已修复。仅NO_PROXY添加update.bitbrowser.cn即206。已备份HKCU/Environment/NO_PROXY并保留原条目追加update.bitbrowser.cn,.bitbrowser.cn。完整下载与窗口启动已验证。',
    scope:['external-local-app:BitBrowser-7.2.0','HKCU/Environment/NO_PROXY'],sourceKind:'tool',sourceRef:'task:verified',supersedesId:old.id}).id;
  remember(db,{type:'lesson',title:'OpenCode 代理',content:'OpenCode NO_PROXY 后端代理需分别确认。',sourceKind:'tool'});
  for(let i=0;i<40;i++){
    const path=`model-test/${i}.html`, id=`noise${i}`;
    db.prepare("INSERT INTO sources VALUES (?,?, 'file','hash',1,0,'')").run(path,path);
    const content='模型测试完成，宽度 400 高度 400，如何通过测试';
    db.prepare('INSERT INTO chunks VALUES (?,?,?,?,1,1)').run(id,path,path,content);
    db.prepare('INSERT INTO chunks_fts VALUES (?,?,?)').run(id,path,content);
    replaceItemNgrams(db,'chunk',id,content);
  }
});
afterEach(()=>db.close());
it('ranks technical title matches before truncating newer identifier distractors',()=>{
  const old=remember(db,{type:'lesson',title:'软件甲内核400通过NO_PROXY最终修复',content:'通过NO_PROXY追加更新域名，完整下载启动验证成功。',sourceKind:'tool',sourceRef:'task:older'});
  db.prepare('UPDATE memories SET updated_at=? WHERE id=?').run('2000-01-01',old.id);
  for(let i=0;i<140;i++) remember(db,{type:'lesson',title:`环境检查${i}`,content:'环境NO_PROXY曾被检查，当前问题无关。',sourceKind:'tool'});
  expect(recallMemories(db,'NO_PROXY',{limit:5}).map(h=>h.memory.id)).toContain(old.id);
  expect(searchProject(db,'NO_PROXY',5).map(h=>h.id)).toContain(old.id);
});
it('does not use generic error or kernel terms as another application identity',()=>{
  const wrong=remember(db,{type:'lesson',title:'软件甲内核400最终修复',content:'下载启动已经验证',scope:['external-local-app:AppA'],sourceKind:'tool'});
  expect(JSON.stringify(buildProjectContext(db,project,'软件乙内核400如何解决'))).not.toContain(wrong.id);
  expect(JSON.stringify(buildProjectContext(db,project,'软件乙内核400如何解决'))).not.toContain(expected);
});
it('does not let shared environment terms bypass an explicitly different application',()=>{
  const other=remember(db,{type:'lesson',title:'星河浏览器3.0代理修复',content:'NO_PROXY配置已验证',scope:['external-local-app:OrionBrowser-3.0','HKCU/Environment/NO_PROXY'],sourceKind:'tool'});
  for(const query of ['OrionBrowser NO_PROXY','星河浏览器NO_PROXY怎么配']) {
    const context=JSON.stringify(buildProjectContext(db,project,query));
    expect(context).toContain(other.id);expect(context).not.toContain(expected);
  }
  expect(JSON.stringify(buildProjectContext(db,project,'NO_PROXY'))).toContain(expected);
  expect(JSON.stringify(buildProjectContext(db,project,'比特 NO_PROXY'))).toContain(expected);
});
it('recognizes full application names with versions and rejects identifier prefix scopes',()=>{
  expect(JSON.stringify(buildProjectContext(db,project,'BitBrowser-7.2.0最终结论'))).toContain(expected);
  expect(JSON.stringify(buildProjectContext(db,project,'NO_PROXY_SUFFIX怎么配置'))).not.toContain(expected);
});
it('distinguishes historical indexing failure from the latest finished run',()=>{
  const insert=db.prepare('INSERT INTO index_runs(id,started_at,status) VALUES(?,?,?)');
  insert.run('old','2026-01-01','failed');insert.run('new','2026-02-01','completed');
  let warnings=buildProjectContext(db,project,'比特').warnings.join(' ');
  expect(warnings).toContain('latest finished run completed');
  expect(warnings).not.toContain('Project search may be incomplete');
  insert.run('new-failed','2026-03-01','failed');
  warnings=buildProjectContext(db,project,'比特').warnings.join(' ');
  expect(warnings).toContain('latest finished run failed');
});
it('filters identifier substrings before pagination, including dense title distractors',()=>{
  db.prepare('UPDATE memories SET updated_at=? WHERE id=?').run('2000-01-01',expected);
  for(let i=0;i<520;i++) remember(db,{type:'lesson',title:`NO_PROXY_SUFFIX环境${i}`,content:'NO_PROXY_SUFFIX环境配置',sourceKind:'tool'});
  expect(recallMemories(db,'NO_PROXY',{limit:5}).map(h=>h.memory.id)).toContain(expected);
  expect(recallMemories(db,'NO_PROXY',{limit:5}).every(h=>!h.memory.title.includes('SUFFIX'))).toBe(true);
});
const questions = ['比特','NO_PROXY','比特内核 400 最后如何通过 NO_PROXY 解决','比特更新为什么400？','NO_PROXY当时改了什么？','比特下载400的最终结论','比特内核下载失败怎么处理','比特下载器代理400','比特窗口最后启动了吗','update.bitbrowser.cn','比特浏览器的内核400问题','NO_PROXY追加域名','比特完整下载验证','比特400是不是安装损坏','BitBrowser NO_PROXY','HKCU/Environment/NO_PROXY','比特7.2.0下载失败','内核下载400修好了没有','比特通过代理请求返回400','比特NO_PROXY备份在哪里','比特追加.bitbrowser.cn','比特内核启动验证范围','比特修复保留原代理排除项','NO_PROXY 400 最后怎么修的'];
it.each(questions)('recalls the verified sourced conclusion: %s',query=>{
  const hits=searchProject(db,query,5);
  expect(hits.map(h=>h.id)).toContain(expected);
  expect(hits.find(h=>h.id===expected)?.source).toBe('task:verified');
  const context=buildProjectContext(db,project,query,3000);
  const ids=[...context.lessons,...context.relevant].map(h=>h.id);
  // Search can offer candidates; generic error terms alone do not establish app scope.
  if(query==='内核下载400修好了没有') expect(ids).not.toContain(expected);
  else expect(ids).toContain(expected);
  expect(context.budget.usedTokens).toBeLessThanOrEqual(3000);
  expect(JSON.stringify(context)).not.toContain('完整下载尚未验证');
});
it('does not infer code module scope from matching memory text',()=>{
  const wrong=remember(db,{type:'lesson',title:'比特 NO_PROXY',content:'比特 NO_PROXY',scope:['src/other.ts'],sourceKind:'user'});
  expect(JSON.stringify(buildProjectContext(db,project,'比特 NO_PROXY src/auth.ts'))).not.toContain(wrong.id);
});
