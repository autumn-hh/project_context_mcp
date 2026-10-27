import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectContextApp } from "../src/core/app.js";
import { TeamService, type TeamPrincipal, type TeamRole } from "../src/team/team-service.js";
import { startTeamHttp } from "../src/mcp/http.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {startUiServer} from "../src/ui/server.js";
import {initializeSync,outgoingEvents,receiveEvents} from "../src/storage/sync/event-store.js";

describe("team sharing and authenticated HTTP MCP", () => {
  let root: string; let app: ProjectContextApp; let team: TeamService; let projectId: string; let workspaceId: string; let shareId: string;
  let env: Record<string,string|undefined>; const owner: TeamPrincipal = { userId: "owner", clientId: "local" };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "team-test-"));
    const values = { PROJECT_CONTEXT_HOME: join(root, "store"), PROJECT_CONTEXT_ALLOWED_ROOTS: root, PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS: root, PROJECT_CONTEXT_TEAM_UI_TOKEN:"" };
    env = Object.fromEntries(Object.keys(values).map(key => [key,process.env[key]])); Object.assign(process.env, values);
    app = await ProjectContextApp.create(); await mkdir(join(root, "project")); projectId = (await app.openProject(join(root, "project"))).id;
    app.remember(projectId, { type: "constraint", title: "共享约束", content: "shared constraint", sourceKind: "user" });
    app.remember(projectId, { type: "preference", title: "私人偏好", content: "private preference", sourceKind: "user" });
    team = new TeamService(app); workspaceId = team.createWorkspace("Org", "Workspace", owner.userId).workspaceId;
    shareId = team.share(owner, workspaceId, projectId).shareId;
  });
  afterEach(async () => { team.close(); app.close(); for (const [key,value] of Object.entries(env)) { if (value===undefined) delete process.env[key]; else process.env[key]=value; } await rm(root,{recursive:true,force:true}); });
  function member(role: TeamRole) { const invitation = team.invite(owner, workspaceId, role, role); team.acceptInvite(invitation.inviteToken); return { userId: role, clientId: "fixture" }; }

  it("exports only opted-in metadata and enforces code sharing revocation",async()=>{
    const viewer=member("viewer"); await writeFile(join(root,"project","source.py"),'def helper():\n    return "private implementation body"\ndef entry():\n    return helper()\n');
    await app.index(projectId);
    expect(()=>team.codeGraph(viewer,shareId)).toThrow(/not been explicitly shared/);
    expect(()=>team.configureCodeGraph(viewer,shareId,true)).toThrow(/not permitted/);
    team.configureCodeGraph(owner,shareId,true);const graph=team.codeGraph(viewer,shareId);
    expect(graph.nodes).toHaveLength(2);expect(graph.edges).toHaveLength(1);
    expect(JSON.stringify(graph)).not.toContain("private implementation body");expect(JSON.stringify(graph)).not.toContain("signature");
    team.configureCodeGraph(owner,shareId,false);expect(()=>team.codeGraph(viewer,shareId)).toThrow(/not been explicitly shared/);
  });
  it("serves authenticated UI review, completes asynchronous conflict audits and rechecks revoked credentials",async()=>{
    const reviewer=member("reviewer");const credential=team.issueToken(reviewer.userId,"ui");process.env.PROJECT_CONTEXT_TEAM_UI_TOKEN=credential.token;
    const proposal=team.propose(owner,shareId,{type:"decision",title:"UI candidate",content:"accepted via authenticated local UI"});
    const db=app.projects.projectDatabase(projectId);initializeSync(db,"ui-space","ui-device");const baseline=outgoingEvents(db).find(event=>event.table==='memories'&&(event.payload as any).type==='constraint')!;
    db.prepare("UPDATE memories SET content='local version' WHERE id=?").run(baseline.entity);
    await receiveEvents(db,[{...baseline,id:'evt_ui_other',device:'other',parents:[baseline.id],version:2,payload:{...baseline.payload as object,content:'remote version'}}]);db.close();
    const conflict=team.conflicts(reviewer,shareId)[0]!;const ui=await startUiServer({openBrowser:false});let cookie="";
    const request=async(path:string,body?:unknown)=>{const response=await fetch(ui.url+path,{method:body?"POST":"GET",headers:{Origin:ui.url,"X-Project-Context-UI":"1","Content-Type":"application/json",Cookie:cookie},...(body?{body:JSON.stringify(body)}:{})});return {response,body:await response.json()};};
    try{
      expect((await request("/api/team")).response.status).toBe(401);
      const session=await request("/api/session",{token:new URLSearchParams(new URL(ui.launchUrl).hash.slice(1)).get("token")});cookie=session.response.headers.get("set-cookie")!.split(";")[0]!;
      expect(JSON.stringify((await request("/api/team")).body)).not.toContain(credential.token);
      expect((await request('/api/team/'+shareId+'/accept',{candidateId:proposal.id})).body.status).toBe("active");
      const resolved=await request('/api/team/'+shareId+'/resolve',{entity:conflict.entity,eventId:conflict.versions[0]!.id});expect(resolved.response.status).toBe(200);
      expect(team.conflicts(reviewer,shareId)).toEqual([]);expect(team.auditLog(reviewer,shareId)).toEqual(expect.arrayContaining([expect.objectContaining({action:'conflict.resolve',status:'completed'})]));
      expect((await request('/api/team/'+shareId+'/graph')).body.code).toBe('TEAM_CODE_NOT_SHARED');
      team.revokeToken(credential.id);expect((await request('/api/team')).body.code).toBe('TEAM_UNAUTHENTICATED');
    }finally{await ui.close();}
  });
  it("enforces roles, explicit memory scope and reviewer policy while recording the authenticated actor", () => {
    const viewer = member("viewer"), editor = member("editor"), reviewer = member("reviewer");
    expect(team.memories(viewer, shareId)).toHaveLength(1);
    expect(() => team.propose(viewer, shareId, {type:"decision",title:"x",content:"x"})).toThrow(/not permitted/);
    expect(() => team.propose(editor, shareId, {type:"preference",title:"x",content:"x"})).toThrow(/not shared/);
    const candidate = team.propose(editor, shareId, {type:"decision",title:"方案",content:"reviewed decision"});
    expect(() => team.accept(editor, shareId, candidate.id)).toThrow(/reviewer/);
    expect(team.accept(reviewer, shareId, candidate.id).status).toBe("active");
    const audit = team.auditLog(owner, shareId) as Array<{action:string;actor:string;status:string}>;
    expect(audit).toEqual(expect.arrayContaining([expect.objectContaining({action:"candidate.propose",actor:"editor",status:"completed"}),expect.objectContaining({action:"candidate.accept",actor:"reviewer",status:"completed"})]));
  });
  it("prevents cross-workspace access, last-owner removal and revoked sharing", () => {
    const outsider = {userId:"outsider",clientId:"fixture"}; team.createWorkspace("Other","Other",outsider.userId);
    expect(team.listShares(outsider)).toEqual([]); expect(() => team.memories(outsider,shareId)).toThrow(/membership/);
    expect(() => team.setMember(owner,workspaceId,owner.userId,null)).toThrow(/retain an owner/);
    team.revokeShare(owner,shareId); expect(() => team.memories(owner,shareId)).toThrow(/unavailable/);
  });
  it("expires/revokes credentials, makes invites single-use and revokes removed member access", () => {
    const invitation = team.invite(owner,workspaceId,"reader","viewer"); team.acceptInvite(invitation.inviteToken);
    expect(() => team.acceptInvite(invitation.inviteToken)).toThrow(/already accepted/);
    const credential=team.issueToken("reader","cursor"); const principal=team.authenticate(credential.token);
    expect(team.memories(principal,shareId)).toHaveLength(1);
    const oldInvite=team.invite(owner,workspaceId,"reader","owner");
    team.setMember(owner,workspaceId,"reader",null); expect(() => team.memories(principal,shareId)).toThrow(/membership/);
    expect(()=>team.acceptInvite(oldInvite.inviteToken)).toThrow(/expired/);
    team.revokeToken(credential.id); expect(() => team.authenticate(credential.token)).toThrow(/expired/);
    expect(JSON.stringify(team.db.prepare("SELECT * FROM team_tokens").all())).not.toContain(credential.token);
  });
  it("supports explicit relaxed review and expiring presence hints", () => {
    const editor=member("editor"); const relaxed=team.share(owner,workspaceId,projectId,{requireReviewer:false}).shareId;
    const proposal=team.propose(editor,relaxed,{type:"constraint",title:"规则",content:"direct review policy"});
    expect(team.accept(editor,relaxed,proposal.id).status).toBe("active");
    const task=app.startTask(projectId,"work"); expect(team.presence(editor,shareId,task.id,30)).toHaveLength(1);
    team.db.prepare("UPDATE team_presence SET expires_at='2000-01-01T00:00:00Z'").run(); expect(team.presence(editor,shareId)).toEqual([]);
  });
  it("negotiates real HTTP MCP, limits viewer tools and checks membership on every call", async () => {
    member("viewer"); const token=team.issueToken("viewer","client-a"); const endpoint=await startTeamHttp();
    const client=new Client({name:"fixture",version:"1"});
    try {
      const unauthorized=await fetch(endpoint.url,{method:"POST",headers:{"content-type":"application/json"},body:'{}'}); expect(unauthorized.status).toBe(401);
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url),{requestInit:{headers:{Authorization:'Bearer '+token.token}}}));
      const tools=await client.listTools(); expect(tools.tools.map(tool=>tool.name)).toEqual(["team_projects","team_search","team_presence_list","team_code_graph"]);
      const read=await client.callTool({name:"team_search",arguments:{shareId}}); expect(read.isError).not.toBe(true);
      expect(JSON.stringify(read)).toContain("shared constraint"); expect(JSON.stringify(read)).not.toContain("private preference");
      team.setMember(owner,workspaceId,"viewer",null);
      const denied=await client.callTool({name:"team_search",arguments:{shareId}}); expect(denied.isError).toBe(true); expect(JSON.stringify(denied.content)).toContain("TEAM_FORBIDDEN");
    } finally { await client.close(); await endpoint.close(); }
  });
});
