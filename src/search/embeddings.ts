import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod/v4";
import type { ProjectContextApp } from "../core/app.js";
import { authorizeExistingPath } from "../security/path-policy.js";
import { sha256 } from "../shared/ids.js";
import { ProjectContextError } from "../shared/errors.js";
import type { SearchHit } from "./search-service.js";

export interface EmbeddingPlugin {
  embed(texts: string[], options: { model: string; signal: AbortSignal }): Promise<number[][]>;
}
const configSchema = z.object({ enabled:z.boolean(), modulePath:z.string(), model:z.string().min(1).max(200),
  dimensions:z.number().int().min(1).max(4096), exposure:z.enum(["local","remote"]), allowRemote:z.boolean() }).strict();
type Config=z.infer<typeof configSchema>;
function configPath(app:ProjectContextApp,id:string) {app.projects.get(id); return join(app.storageRoot,"embeddings",id+".json");}
async function readConfig(app:ProjectContextApp,id:string):Promise<Config|null> {
  try{return configSchema.parse(JSON.parse(await readFile(configPath(app,id),"utf8")));}
  catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null; throw error;}
}
/** CLI-only configuration: plugin modules are trusted executable code, never loaded from project config. */
export async function configureEmbeddings(app:ProjectContextApp,id:string,input:Config) {
  const config=configSchema.parse(input);
  if(config.exposure==="remote"&&!config.allowRemote)throw new ProjectContextError("EMBEDDING_CONSENT_REQUIRED","Remote plugins require explicit --allow-remote; active memory text will be sent to the provider.");
  config.modulePath=await authorizeExistingPath(config.modulePath,app.allowedOutputRoots,"EMBEDDING_MODULE_PATH","Trusted embedding plugin");
  const path=configPath(app,id);await mkdir(join(app.storageRoot,"embeddings"),{recursive:true});
  await writeFile(path,JSON.stringify(config),{mode:0o600}); return config;
}
export async function disableEmbeddings(app:ProjectContextApp,id:string) {
  const config=await readConfig(app,id);if(config){config.enabled=false;await writeFile(configPath(app,id),JSON.stringify(config),{mode:0o600});}
  return {enabled:false};
}
function fingerprint(config:Config) {return sha256(JSON.stringify([config.modulePath,config.model,config.dimensions,config.exposure]));}
function validateVector(value:unknown,dimensions:number):number[] {
  const vector=z.array(z.number().finite()).length(dimensions).parse(value);
  const norm=Math.hypot(...vector);if(!norm||!Number.isFinite(norm))throw new Error("Invalid embedding vector norm.");
  return vector.map(v=>v/norm);
}
async function vectors(config:Config,texts:string[]) {
  if(config.exposure==="remote"&&!config.allowRemote)throw new Error("Remote embedding consent is missing.");
  const module=await import(pathToFileURL(config.modulePath).href) as EmbeddingPlugin;
  if(typeof module.embed!=="function")throw new Error("Plugin must export embed(texts, options).");
  const controller=new AbortController();let timeout:ReturnType<typeof setTimeout>|undefined;
  try {
    const result=await Promise.race([module.embed(texts,{model:config.model,signal:controller.signal}),
      new Promise<never>((_,reject)=>{timeout=setTimeout(()=>{controller.abort();reject(new Error("Embedding provider timed out."));},15000);})]);
    if(!Array.isArray(result)||result.length!==texts.length)throw new Error("Embedding batch size mismatch.");
    return result.map(value=>validateVector(value,config.dimensions));
  } finally {if(timeout)clearTimeout(timeout);}
}
export async function rebuildEmbeddings(app:ProjectContextApp,id:string) {
  const config=await readConfig(app,id);if(!config?.enabled)throw new ProjectContextError("EMBEDDING_DISABLED","Configure and enable an embedding plugin first.");
  const db=app.projects.projectDatabase(id);
  try {
    const rows=db.prepare("SELECT id,title,content FROM memories WHERE status='active' ORDER BY id LIMIT 5001").all() as Array<{id:string;title:string;content:string}>;
    if(rows.length>5000)throw new ProjectContextError("EMBEDDING_LIMIT","This plugin cache supports up to 5000 active memories per project.");
    const entries:Array<{id:string;hash:string;vector:number[]}>=[];
    for(let offset=0;offset<rows.length;offset+=32){
      const batch=rows.slice(offset,offset+32);const texts=batch.map(row=>row.title+"\n"+row.content);
      if(texts.some(text=>text.length>64000))throw new ProjectContextError("EMBEDDING_TEXT_LIMIT","An active memory exceeds the 64000-character embedding limit.");
      const encoded=await vectors(config,texts); batch.forEach((row,index)=>entries.push({id:row.id,hash:sha256(texts[index]!),vector:encoded[index]!}));
    }
    db.exec("CREATE TABLE IF NOT EXISTS memory_embeddings(memory_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,content_hash TEXT NOT NULL,vector_json TEXT NOT NULL)");
    db.transaction(()=>{db.prepare("DELETE FROM memory_embeddings").run();const put=db.prepare("INSERT INTO memory_embeddings VALUES(?,?,?,?)");
      for(const entry of entries)put.run(entry.id,fingerprint(config),entry.hash,JSON.stringify(entry.vector));})();
    return {indexed:entries.length,model:config.model,dimensions:config.dimensions,scope:"active project memories only"};
  } finally {db.close();}
}
export async function searchWithEmbeddings(app:ProjectContextApp,id:string,query:string,limit=20):Promise<{hits:SearchHit[];mode:string;warning?:string}> {
  if(!Number.isInteger(limit)||limit<=0)return {hits:[],mode:"lexical"};
  limit=Math.min(100,limit);
  const lexical=app.search(id,query,limit);
  try {
    const config=await readConfig(app,id);if(!config?.enabled)return {hits:lexical,mode:"lexical"};
    if(!query.trim()||query.length>8000)return {hits:lexical,mode:"lexical",warning:"Embedding query is empty or exceeds 8000 characters."};
    const db=app.projects.projectDatabase(id);
    try {
      if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_embeddings'").get())return {hits:lexical,mode:"lexical",warning:"Build the embedding cache first."};
      const rows=db.prepare("SELECT m.id,m.title,m.content,m.source_ref,e.content_hash,e.vector_json FROM memory_embeddings e JOIN memories m ON m.id=e.memory_id WHERE e.fingerprint=? AND m.status='active' LIMIT 5001").all(fingerprint(config)) as Array<{id:string;title:string;content:string;source_ref:string|null;content_hash:string;vector_json:string}>;
      const fresh=rows.filter(row=>sha256(row.title+"\n"+row.content)===row.content_hash).slice(0,5000);
      if(!fresh.length)return {hits:lexical,mode:"lexical",warning:"Embedding cache is empty or stale; rebuild it."};
      const vector=(await vectors(config,[query]))[0]!;
      // Recheck after the provider await: status/content may have changed meanwhile.
      const semantic:SearchHit[]=[];
      for(const row of fresh){
        const current=db.prepare("SELECT title,content,status FROM memories WHERE id=?").get(row.id) as {title:string;content:string;status:string}|undefined;
        if(!current||current.status!=="active"||sha256(current.title+"\n"+current.content)!==row.content_hash)continue;
        const stored=validateVector(JSON.parse(row.vector_json),config.dimensions);const score=stored.reduce((sum,value,index)=>sum+value*vector[index]!,0);
        if(score>0.2)semantic.push({id:row.id,kind:"memory",title:row.title,content:row.content,source:row.source_ref,startLine:null,status:"active",score});
      }
      semantic.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
      const merged=new Map<string,{hit:SearchHit;score:number}>();
      for(const list of [lexical,semantic.slice(0,Math.max(limit,20))])list.forEach((hit,index)=>{const previous=merged.get(hit.id);merged.set(hit.id,{hit,score:(previous?.score??0)+1/(60+index+1)});});
      return {mode:"hybrid",hits:[...merged.values()].sort((a,b)=>b.score-a.score||a.hit.id.localeCompare(b.hit.id)).slice(0,limit).map(item=>({...item.hit,score:item.score}))};
    } finally {db.close();}
  } catch {return {hits:lexical,mode:"lexical",warning:"Embedding provider unavailable or cache invalid; local search remains available."};}
}
