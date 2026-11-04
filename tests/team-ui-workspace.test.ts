import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectContextApp } from "../src/core/app.js";
import { TeamService } from "../src/team/team-service.js";
import { TeamKnowledgeService } from "../src/team/knowledge-service.js";
import { startTeamHttp } from "../src/mcp/http.js";
import { startUiServer } from "../src/ui/server.js";
import { saveConnectionConfig } from "../src/config/connection.js";
import { UI_JS } from "../src/ui/assets.js";

describe.each(["local", "remote-team"] as const)("team web workspace through %s", mode => {
  let root:string, app:ProjectContextApp, team:TeamService, shareId:string, ws:string;
  let ui:Awaited<ReturnType<typeof startUiServer>>, endpoint:Awaited<ReturnType<typeof startTeamHttp>>, cookie:string, connectionId:string;
  let saved:Record<string,string|undefined>;
  const owner={userId:"owner",clientId:"setup"};
  beforeEach(async()=>{
    root=await mkdtemp(join(tmpdir(),"team-web-"));
    const env={APPDATA:join(root,"config"),PROJECT_CONTEXT_HOME:join(root,"store"),PROJECT_CONTEXT_ALLOWED_ROOTS:root,PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS:root,PROJECT_CONTEXT_TEAM_UI_TOKEN:"",PROJECT_CONTEXT_TEAM_TOKEN:""};
    saved=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));Object.assign(process.env,env);
    app=await ProjectContextApp.create();await mkdir(join(root,"project"));const p=await app.openProject(join(root,"project"));
    team=new TeamService(app);ws=team.createWorkspace("Org","Workspace","owner").workspaceId;shareId=team.share(owner,ws,p.id).shareId;
    for(const role of ["reviewer","editor","viewer"] as const){const i=team.invite(owner,ws,role,role);team.acceptInvite(i.inviteToken);}
    useRole("reviewer");endpoint=await startTeamHttp();
    connectionId=(await saveConnectionConfig({mode,...(mode==="remote-team"?{remoteTeamUrl:endpoint.url}:{})})).connectionId;
    ui=await startUiServer({openBrowser:false});cookie="";
    const session=await request("/api/session",{token:new URLSearchParams(new URL(ui.launchUrl).hash.slice(1)).get("token")});cookie=session.response.headers.get("set-cookie")!.split(";")[0]!;
  });
  afterEach(async()=>{await ui?.close();await endpoint?.close();team?.close();app?.close();for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}await rm(root,{recursive:true,force:true});});
  function useRole(role:string){const t=team.issueToken(role,"web-"+role).token;process.env.PROJECT_CONTEXT_TEAM_UI_TOKEN=t;process.env.PROJECT_CONTEXT_TEAM_TOKEN=t;}
  async function request(path:string,body?:unknown){const response=await fetch(ui.url+path,{method:body?"POST":"GET",headers:{Origin:ui.url,"X-Project-Context-UI":"1","Content-Type":"application/json",Cookie:cookie},...(body?{body:JSON.stringify(body)}:{})});return {response,body:await response.json()};}
  function call(action:string,body?:unknown,query=""){return request("/api/team/"+shareId+"/"+action+"?connectionId="+connectionId+query,body);}
  it("completes memory, task and rule lifecycles with version conflicts, history and pagination",async()=>{
    expect(()=>new Function(UI_JS)).not.toThrow();
    const proposal=await call("propose",{type:"decision",title:"Web decision",content:"shared from web"});expect(proposal.response.status).toBe(200);
    expect((await call("accept",{candidateId:proposal.body.id})).response.status).toBe(200);
    expect((await call("memories",undefined,"&query=shared%20from%20web")).body).toHaveLength(1);
    const created=(await call("task-start",{goal:"Shared plan"})).body;
    const checkpoint={summary:"work done",completed:["first"],changedFiles:["local.ts"],verification:[{command:"typecheck",status:"passed"}],acceptance:[{criterion:'Shared fixture',status:'passed',evidence:'test:fixture'}]};
    const updated=await call("task-checkpoint",{taskId:created.id,expectedVersion:created.version,requestId:"one",checkpoint});expect(updated.response.status).toBe(200);
    expect((await call("task-checkpoint",{taskId:created.id,expectedVersion:1,requestId:"stale",checkpoint:{summary:"old"}})).response.status).toBe(409);
    expect((await call("task",undefined,"&taskId="+created.id)).body.checkpoint).toMatchObject(checkpoint);
    expect((await call("task-finish",{taskId:created.id,expectedVersion:updated.body.version,status:"completed"})).body.status).toBe("completed");
    expect((await call("tasks",undefined,"&status=completed")).body.total).toBe(1);
    expect((await call("task-history",undefined,"&taskId="+created.id+"&limit=1&offset=1")).body).toMatchObject({total:3,offset:1});
    const rule=(await call("rule-put",{title:"Rule",content:"First"})).body;
    expect((await call("rule-put",{ruleId:rule.id,expectedVersion:1,title:"Rule",content:"Second"})).body.version).toBe(2);
    expect((await call("rule-put",{ruleId:rule.id,expectedVersion:1,title:"Rule",content:"Stale"})).response.status).toBe(409);
    expect((await call("rule-disable",{ruleId:rule.id,expectedVersion:2})).body.status).toBe("deleted");
    expect((await call("rules",undefined,"&status=deleted")).body.total).toBe(1);
    expect((await call("rule-put",{ruleId:rule.id,expectedVersion:3,title:"Rule",content:"Restored"})).body.version).toBe(4);
    expect((await call("rule-history",undefined,"&ruleId="+rule.id)).body.items.map((r:any)=>r.version)).toEqual([4,3,2,1]);
    const knowledge=new TeamKnowledgeService(team);for(let i=0;i<21;i++)knowledge.startTask(owner,shareId,"Page "+i);
    expect((await call("tasks",undefined,"&limit=20&offset=20")).body.items).toHaveLength(1);
  });
  it("enforces roles and input validation, rejects stale connections and keeps tokens off the page",async()=>{
    expect((await call("task-start",{goal:"x",actor:"owner"})).response.status).toBe(400);
    expect((await call("tasks",undefined,"&limit=1000")).response.status).toBe(400);
    expect((await call("rule-disable",{ruleId:"x",expectedVersion:0})).response.status).toBe(400);
    useRole("viewer");expect((await call("tasks")).response.status).toBe(200);
    expect((await call("task-start",{goal:"blocked"})).response.status).not.toBe(200);
    useRole("editor");expect((await call("task-start",{goal:"editor plan"})).response.status).toBe(200);
    expect((await call("rule-put",{title:"blocked",content:"blocked"})).response.status).not.toBe(200);
    useRole("reviewer");const data=await call("rules");expect(JSON.stringify(data.body)).not.toContain(process.env.PROJECT_CONTEXT_TEAM_TOKEN);
    const otherWs=team.createWorkspace("Other","Other","other").workspaceId;
    const other=team.share({userId:"other",clientId:"setup"},otherWs,app.projects.list()[0]!.id).shareId;
    expect((await request("/api/team/"+other+"/tasks?connectionId="+connectionId)).response.status).toBe(403);
    const old=connectionId;await saveConnectionConfig({mode:mode==="local"?"remote-team":"local",...(mode==="local"?{remoteTeamUrl:endpoint.url}:{})});
    expect((await call("task-start",{goal:"wrong target"})).response.status).toBe(409);expect(connectionId).toBe(old);
  });
});
