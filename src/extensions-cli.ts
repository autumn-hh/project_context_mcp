import { Command } from "commander";
import { ProjectContextApp } from "./core/app.js";
import { configureEmbeddings,disableEmbeddings,rebuildEmbeddings,searchWithEmbeddings } from "./search/embeddings.js";
import { configureLsp,lspDefinition } from "./lsp/bridge.js";

export function registerExtensionsCli(program:Command){
  const run=<T extends unknown[]>(work:(app:ProjectContextApp,...args:T)=>unknown|Promise<unknown>)=>async(...args:T)=>{
    const app=await ProjectContextApp.create();try{console.log(JSON.stringify(await work(app,...args),null,2));}finally{app.close();}
  };
  const embeddings=program.command("embeddings").description("Opt-in trusted embedding plugins for active project memories");
  embeddings.command("configure").argument("<project-id>").requiredOption("--module <absolute-path>","trusted JS module exporting embed")
    .requiredOption("--model <name>").requiredOption("--dimensions <count>","vector dimensions",Number)
    .option("--remote","plugin sends text to a remote provider",false).option("--allow-remote","explicitly consent to sending active memories and queries",false)
    .action(run((app,id:string,options:{module:string;model:string;dimensions:number;remote:boolean;allowRemote:boolean})=>configureEmbeddings(app,id,{enabled:true,modulePath:options.module,model:options.model,dimensions:options.dimensions,exposure:options.remote?"remote":"local",allowRemote:options.allowRemote})));
  embeddings.command("disable").argument("<project-id>").action(run(disableEmbeddings));
  embeddings.command("rebuild").argument("<project-id>").action(run(rebuildEmbeddings));
  embeddings.command("search").argument("<project-id>").argument("<query>").action(run((app,id:string,query:string)=>searchWithEmbeddings(app,id,query)));
  const lsp=program.command("lsp").description("Opt-in read-only bridge to a trusted local language server");
  lsp.command("configure").argument("<project-id>").requiredOption("--command <absolute-executable>")
    .option("--args-json <json>","executable argument array","[]").requiredOption("--language <id>")
    .action(run((app,id:string,options:{command:string;argsJson:string;language:string})=>configureLsp(app,id,{command:options.command,args:JSON.parse(options.argsJson),languageId:options.language,timeoutMs:10000})));
  lsp.command("definition").argument("<project-id>").argument("<relative-path>")
    .requiredOption("--line <number>","zero-based line",Number).requiredOption("--character <number>","zero-based UTF-16 character",Number)
    .action(run((app,id:string,path:string,options:{line:number;character:number})=>lspDefinition(app,id,path,options.line,options.character)));
}
