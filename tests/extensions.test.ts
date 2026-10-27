import {afterEach,beforeEach,describe,expect,it} from "vitest";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {ProjectContextApp} from "../src/core/app.js";
import {configureEmbeddings,disableEmbeddings,rebuildEmbeddings,searchWithEmbeddings} from "../src/search/embeddings.js";
import {configureLsp,lspDefinition} from "../src/lsp/bridge.js";

describe("optional retrieval and definition extensions",()=>{
  let root:string,app:ProjectContextApp,id:string,env:Record<string,string|undefined>;
  beforeEach(async()=>{
    root=await mkdtemp(join(tmpdir(),"extensions-"));const values={PROJECT_CONTEXT_HOME:join(root,"store"),PROJECT_CONTEXT_ALLOWED_ROOTS:root,PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS:root};
    env=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));Object.assign(process.env,values);
    app=await ProjectContextApp.create();await mkdir(join(root,"project"));id=(await app.openProject(join(root,"project"))).id;
  });
  afterEach(async()=>{app.close();for(const[key,value]of Object.entries(env)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await rm(root,{recursive:true,force:true});});
  async function plugin(source:string){const path=join(root,"provider.mjs");await writeFile(path,source);return {enabled:true,modulePath:path,model:"fixture-v1",dimensions:2,exposure:"local" as const,allowRemote:false};}
  it("preserves disabled search exactly, recalls synonyms and rejects stale or deleted vectors",async()=>{
    const remembered=app.remember(id,{type:"fact",title:"交通",content:"汽车可以载客",sourceKind:"user"});
    expect((await searchWithEmbeddings(app,id,"轿车")).hits).toEqual(app.search(id,"轿车"));
    const config=await plugin('export async function embed(texts){return texts.map(text=>text.includes("汽车")||text.includes("轿车")?[1,0]:[0,1]);}');
    await configureEmbeddings(app,id,config);expect((await rebuildEmbeddings(app,id)).indexed).toBe(1);
    expect((await searchWithEmbeddings(app,id,"轿车")).hits.map(hit=>hit.id)).toContain(remembered.id);
    const db=app.projects.projectDatabase(id);db.prepare("UPDATE memories SET content='变化' WHERE id=?").run(remembered.id);db.close();
    expect((await searchWithEmbeddings(app,id,"轿车")).hits).toEqual([]);
    app.setMemoryStatus(id,remembered.id,"deleted");expect((await searchWithEmbeddings(app,id,"轿车")).hits).toEqual([]);
    await disableEmbeddings(app,id);expect((await searchWithEmbeddings(app,id,"交通")).mode).toBe("lexical");
  });
  it("requires remote consent and rejects invalid provider output without losing local search",async()=>{
    app.remember(id,{type:"fact",title:"durable",content:"local result",sourceKind:"user"});
    const config=await plugin('export async function embed(){return [[NaN,0]];}');
    await expect(configureEmbeddings(app,id,{...config,exposure:"remote"})).rejects.toThrow(/allow-remote/);
    await configureEmbeddings(app,id,config);await expect(rebuildEmbeddings(app,id)).rejects.toThrow();
    expect((await searchWithEmbeddings(app,id,"durable")).hits).toEqual(app.search(id,"durable"));
  });
  it("indexes Python Go Rust symbols and local call relationships into search",async()=>{
    const files={"a.py":"def helper():\n    return 1\ndef pythonEntry():\n    return helper()\n", "b.go":"package main\nfunc helper() {}\nfunc goEntry(){ helper() }\n", "c.rs":"fn helper(){}\nfn rustEntry(){helper();}\n"};
    for(const[path,content]of Object.entries(files))await writeFile(join(root,"project",path),content.replaceAll("\\n","\n"));
    const indexed=await app.index(id);expect(indexed.errors).toEqual([]);
    for(const name of ["pythonEntry","goEntry","rustEntry"]){const hits=app.search(id,name,20);expect(hits.some(hit=>hit.kind==="symbol"&&hit.title.includes(name))).toBe(true);expect(hits.some(hit=>hit.kind==="symbol"&&hit.title.includes("helper"))).toBe(true);}
  });
  it("falls back after provider failure even when a valid cache exists",async()=>{
    app.remember(id,{type:"fact",title:"durable",content:"local result",sourceKind:"user"});
    const config=await plugin('let calls=0; export async function embed(texts){if(++calls>1)throw new Error("provider unavailable");return texts.map(()=>[1,0]);}');
    await configureEmbeddings(app,id,config);await rebuildEmbeddings(app,id);
    const result=await searchWithEmbeddings(app,id,"durable");expect(result.mode).toBe("lexical");expect(result.warning).toContain("unavailable");expect(result.hits).toEqual(app.search(id,"durable"));
  });
  it("exchanges framed LSP messages, filters external definitions and rejects stale or excluded input",async()=>{
    await writeFile(join(root,"project","main.py"),["def helper():","    return 1","helper()", ""].join(String.fromCharCode(10)));await writeFile(join(root,"project",".env"),"INTERNAL=fixture");await app.index(id);
    await configureLsp(app,id,{command:process.execPath,args:[resolve("tests/helpers/lsp-fixture.mjs")],languageId:"python",timeoutMs:3000});
    const result=await lspDefinition(app,id,"main.py",2,2);expect(result.definitions).toEqual([{path:"main.py",range:{start:{line:0,character:0},end:{line:0,character:10}}}]);
    await expect(lspDefinition(app,id,".env",0,0)).rejects.toThrow(/Only indexed/);
    await writeFile(join(root,"outside.py"),"outside");await expect(lspDefinition(app,id,"../outside.py",0,0)).rejects.toThrow(/outside/);
    await writeFile(join(root,"project","main.py"),"changed");await expect(lspDefinition(app,id,"main.py",0,0)).rejects.toThrow(/index the project/);
  });
  it("times out unresponsive language servers and leaves indexed search usable",async()=>{
    await writeFile(join(root,"project","main.py"),"def alive(): pass");await app.index(id);
    await configureLsp(app,id,{command:process.execPath,args:["-e","setInterval(()=>{},1000)"],languageId:"python",timeoutMs:150});
    await expect(lspDefinition(app,id,"main.py",0,0)).rejects.toThrow(/timed out/);expect(app.search(id,"alive").length).toBeGreaterThan(0);
  });
});
