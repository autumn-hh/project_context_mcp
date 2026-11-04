import type { SqliteDatabase } from "../storage/database.js";
import type { MemoryRecord } from "../memory/memory-service.js";

type AppMemory = Pick<MemoryRecord,"title"|"scope">;
const prefix="external-local-app:";
const normalize=(value:string)=>value.normalize("NFKC").toLowerCase().trim();

export function applicationIdentities(memory: AppMemory) {
  return memory.scope.map(normalize).filter(scope=>scope.startsWith(prefix)).map(scope=>{
    const full=scope.slice(prefix.length), version=full.match(/-([0-9]+(?:[.][0-9]+)+)$/u)?.[1];
    const name=version ? full.slice(0,-version.length-1) : full;
    const title=normalize(memory.title), at=version ? title.indexOf(version) : -1;
    const label=at>0 ? title.slice(0,at).trim() : "";
    const localized=/^[\p{Script=Han}]{2,20}$/u.test(label)
      && !/^(?:内核|下载|更新|软件|版本|代理|修复|浏览器|启动|安装|最终|完成|通过|错误|失败|解决|本机|环境)+$/u.test(label) ? label : "";
    return {name,names:[name,full,...(localized?[localized]:[])]};
  });
}

function containsName(task:string,name:string):boolean {
  if(!name) return false;
  let start=0;
  while(start<=task.length){
    const at=task.indexOf(name,start);if(at<0)return false;
    const before=task[at-1]??"",after=task[at+name.length]??"";
    if((!/[a-z0-9_-]/u.test(name[0]!) || !/[a-z0-9_-]/u.test(before))
      && (!/[a-z0-9_-]/u.test(name.at(-1)!) || !/[a-z0-9_-]/u.test(after))) return true;
    start=at+1;
  }
  return false;
}

export function matchedApplications(memory:AppMemory,task:string):string[]{
  const query=normalize(task);
  return applicationIdentities(memory).filter(app=>app.names.some(name=>containsName(query,name))).map(app=>app.name);
}

/** Lightweight identity inventory; full content still obeys recall quotas. */
export function applicationTargets(db:SqliteDatabase,task:string){
  const rows=db.prepare("SELECT id,title,scope_json FROM memories WHERE status='active' AND type<>'task-summary' AND scope_json LIKE '%external-local-app:%' ORDER BY updated_at DESC,id LIMIT 2049")
    .all() as Array<{id:string;title:string;scope_json:string}>;
  const names=new Set<string>(), ids:string[]=[];
  for(const row of rows.slice(0,2048)){
    const matches=matchedApplications({title:row.title,scope:JSON.parse(row.scope_json) as string[]},task);
    if(matches.length){matches.forEach(name=>names.add(name));if(ids.length<8)ids.push(row.id);}
  }
  return {names,ids,truncated:rows.length>2048};
}
