import Database from 'better-sqlite3';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { searchProject } from '../src/search/search-service.js';
import { buildProjectContext, scopeMatches } from '../src/context/context-service.js';
import { getMemory } from '../src/memory/memory-service.js';
import { recallMemories } from '../src/memory/recall-service.js';
import type { ProjectRecord } from '../src/projects/project-service.js';

const [source,expected,output]=process.argv.slice(2);
if(!source || !expected || !output) throw new Error('Usage: tsx scripts/recall-audit.ts <database snapshot> <expected memory id> <report.json>');
const db=new Database(source,{readonly:true,fileMustExist:true});
const project:ProjectRecord={id:'audit',name:'audit snapshot',rootPath:'/audit',remoteUrl:null,createdAt:'',updatedAt:'',lastOpenedAt:'',archivedAt:null};
const queries=['比特','NO_PROXY','比特内核 400 最后如何通过 NO_PROXY 解决','比特更新为什么 400？','NO_PROXY 当时改了什么？','比特内核完整下载和窗口启动验证','比特NO_PROXY备份','比特400最后修好了吗'];
try {
  const memory=getMemory(db,expected);
  const cases=queries.map(query=>{
    const start=performance.now(); const search=searchProject(db,query,5); const searchMs=performance.now()-start;
    const contextStart=performance.now(); const context=buildProjectContext(db,project,query,3000); const contextMs=performance.now()-contextStart;
    const selected=[...context.constraints,...context.decisions,...context.lessons,...context.relevant];
    const candidates=recallMemories(db,query);
    const scopeAccepted=scopeMatches(memory,query,searchProject(db,query,24).filter(hit=>hit.kind!=='memory'));
    const candidate=candidates.find(hit=>hit.memory.id===expected);
    return {query,searchMs,contextMs,rank:search.findIndex(hit=>hit.id===expected)+1,contextHit:selected.some(hit=>hit.id===expected),
      search:search.map(({id,title,source,score,recall})=>({id,title,source,score,recall})),
      candidateRank:candidates.findIndex(hit=>hit.memory.id===expected)+1,scope:memory.scope,scopeAccepted,
      explanation:{matchedTerms:candidate?.matchedTerms??[],channels:candidate?.channels??[],
        excludedAt:memory.status!=='active'?'lifecycle':!candidate?'candidate-channels':!scopeAccepted?'scope':!selected.some(hit=>hit.id===expected)?'ranking-or-budget':null},
      budget:context.budget,contextBytes:Buffer.byteLength(JSON.stringify(context))};
  });
  const report={recordedAt:new Date().toISOString(),source,expected,sourceRef:memory.sourceRef,integrity:db.pragma('quick_check',{simple:true}),
    recallAt5:cases.filter(c=>c.rank>0).length/cases.length,contextRecall:cases.filter(c=>c.contextHit).length/cases.length,cases};
  await writeFile(output,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  if(report.recallAt5<0.9 || report.contextRecall!==1) process.exitCode=1;
} finally { db.close(); }
