import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod/v4";
import type { ProjectContextApp } from "../core/app.js";
import { authorizeExistingPath } from "../security/path-policy.js";
import { ProjectContextError } from "../shared/errors.js";
import { sha256 } from "../shared/ids.js";

const configSchema=z.object({command:z.string().min(1),args:z.array(z.string()).max(100),languageId:z.string().min(1).max(100),
  timeoutMs:z.number().int().min(100).max(30000).default(10000)}).strict();
type Config=z.infer<typeof configSchema>;
function configPath(app:ProjectContextApp,id:string){app.projects.get(id);return join(app.storageRoot,"lsp",id+".json");}
export async function configureLsp(app:ProjectContextApp,id:string,input:Config){
  const config=configSchema.parse(input);
  if(!isAbsolute(config.command))throw new ProjectContextError("LSP_COMMAND_PATH","Provide an absolute executable path for the explicitly trusted language server.");
  config.command=await realpath(config.command);await mkdir(join(app.storageRoot,"lsp"),{recursive:true});
  await writeFile(configPath(app,id),JSON.stringify(config),{mode:0o600});return config;
}
const position=z.object({line:z.number().int().min(0),character:z.number().int().min(0)});
const range=z.object({start:position,end:position});

export async function lspDefinition(app:ProjectContextApp,id:string,path:string,line:number,character:number){
  const config=configSchema.parse(JSON.parse(await readFile(configPath(app,id),"utf8").catch(()=>{throw new ProjectContextError("LSP_NOT_CONFIGURED","Configure a trusted local language server with lsp configure first.");})));
  position.parse({line,character});const project=app.projects.get(id);
  const root=await realpath(project.rootPath);const file=await authorizeExistingPath(join(root,path),[root],"LSP_FILE_PATH","Source file");
  const db=app.projects.projectDatabase(id);let content:string;
  try{
    const source=db.prepare("SELECT content_hash FROM sources WHERE path=?").get(relative(root,file).replaceAll("\\","/")) as {content_hash:string}|undefined;
    if(!source)throw new ProjectContextError("LSP_FILE_NOT_INDEXED","Only indexed, permitted source files may be opened by the bridge.");
    const bytes=await readFile(file);if(bytes.length>2*1024*1024)throw new ProjectContextError("LSP_FILE_TOO_LARGE","Source exceeds 2 MiB.");
    content=bytes.toString("utf8");if(sha256(content)!==source.content_hash)throw new ProjectContextError("LSP_INDEX_STALE","Source changed; index the project before requesting definitions.");
    const lines=content.split("\n");if(line>=lines.length||character>lines[line]!.length)throw new ProjectContextError("LSP_POSITION","Position is outside the source (zero-based UTF-16 coordinates).");
  }finally{db.close();}
  const environment:NodeJS.ProcessEnv={};
  for(const key of ["PATH","Path","SystemRoot","WINDIR","TEMP","TMP","HOME","USERPROFILE"])if(process.env[key])environment[key]=process.env[key];
  const child=spawn(config.command,config.args,{cwd:root,env:environment,shell:false,windowsHide:true,stdio:["pipe","pipe","pipe"]});
  const closed=new Promise<void>(resolve=>child.once("close",()=>resolve()));
  const pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void}>();let next=0;let buffer=Buffer.alloc(0);let total=0;let failed:Error|undefined;
  const fail=(error:Error)=>{failed=error;for(const value of pending.values())value.reject(error);pending.clear();};
  const send=(value:unknown)=>{const json=JSON.stringify(value);child.stdin.write("Content-Length: "+Buffer.byteLength(json)+"\r\n\r\n"+json);};
  child.stdin.on("error",()=>fail(new Error("Language server input closed.")));
  child.on("error",()=>fail(new Error("Unable to start the configured language server.")));
  child.on("exit",()=>fail(new Error("Language server exited.")));
  child.stderr.resume(); // Never forward language-server logs, which may contain source or credentials.
  child.stdout.on("data",(chunk:Buffer)=>{
    try{
      total+=chunk.length;if(total>8*1024*1024)throw new Error("Language server response limit exceeded.");
      buffer=Buffer.concat([buffer,chunk]);
      while(true){
        const end=buffer.indexOf("\r\n\r\n");if(end<0){if(buffer.length>8192)throw new Error("Invalid LSP frame header.");break;}
        const match=/^Content-Length: *([0-9]+)$/im.exec(buffer.subarray(0,end).toString("ascii"));const size=match?Number(match[1]):-1;
        if(size<0||size>4*1024*1024)throw new Error("Invalid LSP frame length.");if(buffer.length<end+4+size)break;
        const message=JSON.parse(buffer.subarray(end+4,end+4+size).toString("utf8"));buffer=buffer.subarray(end+4+size);
        if(message.method&&message.id!==undefined)send({jsonrpc:"2.0",id:message.id,error:{code:-32601,message:"Client requests are not supported by this read-only bridge."}});
        else if(typeof message.id==="number"){const request=pending.get(message.id);if(request){pending.delete(message.id);if(message.error)request.reject(new Error("Language server rejected the request."));else request.resolve(message.result);}}
      }
    }catch{fail(new Error("Invalid or excessive language server response."));child.kill();}
  });
  const request=(method:string,params:unknown)=>new Promise<unknown>((resolve,reject)=>{if(failed){reject(failed);return;}const id=++next;pending.set(id,{resolve,reject});send({jsonrpc:"2.0",id,method,params});});
  const timer=setTimeout(()=>{fail(new Error("Language server timed out."));child.kill();},config.timeoutMs);
  try{
    await request("initialize",{processId:null,rootUri:pathToFileURL(root).href,capabilities:{textDocument:{definition:{linkSupport:true}}}});
    send({jsonrpc:"2.0",method:"initialized",params:{}});
    const uri=pathToFileURL(file).href;send({jsonrpc:"2.0",method:"textDocument/didOpen",params:{textDocument:{uri,languageId:config.languageId,version:1,text:content}}});
    const response=await request("textDocument/definition",{textDocument:{uri},position:{line,character}});
    const locations=response===null?[]:Array.isArray(response)?response:[response];if(locations.length>1000)throw new Error("Too many definition results.");
    const definitions:Array<{path:string;range:z.infer<typeof range>}>=[];
    for(const item of locations){
      const record=z.object({uri:z.string().optional(),range:range.optional(),targetUri:z.string().optional(),targetSelectionRange:range.optional()}).parse(item);
      const uri=record.targetUri??record.uri;const targetRange=record.targetSelectionRange??record.range;if(!uri||!targetRange||!uri.startsWith("file:"))continue;
      try{const target=await authorizeExistingPath(fileURLToPath(uri),[root],"LSP_TARGET_PATH","Definition");const path=relative(root,target).replaceAll("\\","/");
        const db=app.projects.projectDatabase(id);try{if(db.prepare("SELECT 1 FROM sources WHERE path=?").get(path))definitions.push({path,range:targetRange});}finally{db.close();}
      }catch{/* External or unavailable definitions are intentionally excluded. */}
    }
    await request("shutdown",null);send({jsonrpc:"2.0",method:"exit"});return {definitions,coordinates:"zero-based UTF-16",scope:"indexed files inside this project"};
  }catch{throw new ProjectContextError("LSP_UNAVAILABLE","Language server failed, timed out or returned invalid data. Indexed local search remains available.");}
  finally{
    clearTimeout(timer);child.stdin.end();child.kill();
    // Windows can retain the working-directory handle until the process and pipes close.
    let forceTimer:ReturnType<typeof setTimeout>|undefined,closeTimer:ReturnType<typeof setTimeout>|undefined;
    try {
      forceTimer=setTimeout(()=>child.kill("SIGKILL"),1000);
      await Promise.race([closed,new Promise<never>((_,reject)=>{closeTimer=setTimeout(()=>reject(new ProjectContextError("LSP_CLEANUP_FAILED","Language server did not exit after termination.")),5000);})]);
    } finally {if(forceTimer)clearTimeout(forceTimer);if(closeTimer)clearTimeout(closeTimer);}
  }
}
