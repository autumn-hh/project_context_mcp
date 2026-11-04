import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ProjectContextApp } from "../src/core/app.js";
import { TeamService } from "../src/team/team-service.js";
import { TeamKnowledgeService } from "../src/team/knowledge-service.js";
import { startTeamHttp } from "../src/mcp/http.js";

describe("shared knowledge infrastructure with independent developer clients", () => {
  let root: string, app: ProjectContextApp, team: TeamService, knowledge: TeamKnowledgeService;
  let endpoint: Awaited<ReturnType<typeof startTeamHttp>> | undefined;
  let shareId: string, otherShare: string, privateTask: string;
  let env: Record<string, string | undefined>;
  const clients: Client[] = [];
  const owner = { userId: "owner", clientId: "setup" };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "team-knowledge-"));
    const values = { PROJECT_CONTEXT_HOME: join(root, "store"), PROJECT_CONTEXT_ALLOWED_ROOTS: root, PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS: root };
    env = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
    app = await ProjectContextApp.create(); await mkdir(join(root, "knowledge-only"));
    const project = (await app.openProject(join(root, "knowledge-only"))).id;
    app.rememberUser({ type: "preference", title: "Private preference", content: "PERSONAL_ONLY", sourceKind: "user" });
    privateTask = app.startTask(project, "PRIVATE_LOCAL_TASK").id;
    team = new TeamService(app); knowledge = new TeamKnowledgeService(team);
    const ws = team.createWorkspace("Org", "Shared", "owner").workspaceId;
    shareId = team.share(owner, ws, project).shareId;
    const ws2 = team.createWorkspace("Org", "Other", "other").workspaceId;
    otherShare = team.share({ userId: "other", clientId: "setup" }, ws2, project).shareId;
    for (const [user, role] of [["alice", "reviewer"], ["bob", "editor"], ["viewer", "viewer"]] as const) {
      const invitation = team.invite(owner, ws, user, role); team.acceptInvite(invitation.inviteToken);
    }
    endpoint = await startTeamHttp();
  });
  afterEach(async () => {
    await Promise.all(clients.splice(0).map(client => client.close())); await endpoint?.close(); endpoint = undefined;
    team.close(); app.close();
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  });
  async function connect(user: string, name: string) {
    const credential = team.issueToken(user, name);
    const client = new Client({ name, version: "1" }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint!.url), { requestInit: { headers: { Authorization: "Bearer " + credential.token } } }));
    return { client, credential };
  }
  async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result.structuredContent!.result;
  }
  async function denied(client: Client, name: string, args: Record<string, unknown>, code?: string) {
    const result = await client.callTool({ name, arguments: args }); expect(result.isError).toBe(true);
    if (code) expect(JSON.stringify(result.content)).toContain(code);
  }

  it("shares memories, plans and rules immediately between two HTTP clients without source code", async () => {
    const a = (await connect("alice", "laptop-a")).client, b = (await connect("bob", "laptop-b")).client;
    const tools = (await a.listTools()).tools.map(t => t.name);
    expect(tools).toContain("team_context"); expect(tools).not.toContain("project_open"); expect(tools).not.toContain("project_index");
    const proposal = await call(b, "team_propose", { shareId, type: "decision", title: "Shared decision", content: "Central memory without syncing source" });
    await call(a, "team_candidate_accept", { shareId, candidateId: proposal.id });
    expect(await call(b, "team_search", { shareId, query: "Central memory" })).toHaveLength(1);
    const plan = await call(a, "team_task_start", { shareId, goal: "Implement local checkout independently" });
    expect((await call(b, "team_task_list", { shareId })).items.map((t: any) => t.id)).toEqual([plan.id]);
    const checkpoint = { summary: "Bob finished the first step", completed: ["First step"], next: [], acceptance:[{criterion:'Shared fixture',status:'passed',evidence:'test:fixture'}] };
    const updated = await call(b, "team_task_checkpoint", { shareId, taskId: plan.id, expectedVersion: plan.version, requestId: "checkpoint-1", checkpoint });
    const rule = await call(a, "team_rule_put", { shareId, title: "Review changes", content: "Run relevant local checks before sharing progress." });
    const context = await call(b, "team_context", { shareId });
    expect(context).toMatchObject({ dataLocation: "server", sourceCodeIncluded: false });
    expect(context.tasks.items[0].checkpoint.summary).toBe(checkpoint.summary); expect(context.rules.items[0].id).toBe(rule.id);
    expect(JSON.stringify(context)).not.toContain("PERSONAL_ONLY"); expect(JSON.stringify(context)).not.toContain("PRIVATE_LOCAL_TASK");
    const finished = await call(a, "team_task_finish", { shareId, taskId: plan.id, expectedVersion: updated.version, status: "completed" });
    expect(finished.status).toBe("completed"); expect((await call(b, "team_task_history", { shareId, taskId: plan.id })).total).toBe(3);
    await a.close(); expect((await call(b, "team_rule_list", { shareId })).items[0].id).toBe(rule.id);
    await endpoint!.close(); endpoint = await startTeamHttp();
    const c = (await connect("alice", "reconnected")).client;
    expect((await call(c, "team_task_get", { shareId, taskId: plan.id })).status).toBe("completed");
    expect((await call(c, "team_rule_list", { shareId })).items[0].id).toBe(rule.id);
  });

  it('preserves required work through summary-only shared checkpoints',async()=>{
    const a=(await connect('alice','patch-client')).client;
    const task=await call(a,'team_task_start',{shareId,goal:'verify required work'});
    const required=await call(a,'team_task_checkpoint',{shareId,taskId:task.id,expectedVersion:task.version,requestId:'required',checkpoint:{next:['launch'],blockers:['device'],verification:[{command:'launch',status:'failed'}],acceptance:[{criterion:'launch',status:'passed',evidence:'contradictory fixture'}]}});
    const note=await call(a,'team_task_checkpoint',{shareId,taskId:task.id,expectedVersion:required.version,requestId:'note',checkpoint:{summary:'implementation done'}});
    expect(note.checkpoint).toMatchObject({next:['launch'],blockers:['device'],verification:[{command:'launch',status:'failed'}]});
    await denied(a,'team_task_finish',{shareId,taskId:task.id,expectedVersion:note.version,status:'completed'},'TASK_ACCEPTANCE_REQUIRED');
  });

  it("rejects concurrent stale writes and keeps checkpoint retries and rule history consistent", async () => {
    const a = (await connect("alice", "a")).client, b = (await connect("alice", "b")).client;
    const task = await call(a, "team_task_start", { shareId, goal: "Concurrent plan" });
    const update = (client: Client, summary: string) => client.callTool({ name: "team_task_checkpoint", arguments: { shareId, taskId: task.id, expectedVersion: task.version, requestId: "same-id-different-client", checkpoint: { summary } } });
    const responses = await Promise.all([update(a, "from a"), update(b, "from b")]);
    expect(responses.filter(r => !r.isError)).toHaveLength(1); expect(JSON.stringify(responses.find(r => r.isError))).toContain("TEAM_VERSION_CONFLICT");
    const winner = responses[0]!.isError ? b : a, loser = winner === a ? b : a;
    const summary = winner === a ? "from a" : "from b";
    const current = await call(loser, "team_task_get", { shareId, taskId: task.id });
    const newer = await call(loser, "team_task_checkpoint", { shareId, taskId: task.id, expectedVersion: current.version, requestId: "second", checkpoint: { summary: "newest" } });
    const retry = await update(winner, summary); expect((retry.structuredContent!.result as any).version).toBe(newer.version);
    await denied(winner, "team_task_checkpoint", { shareId, taskId: task.id, expectedVersion: task.version, requestId: "same-id-different-client", checkpoint: { summary: "changed payload" } }, "TASK_REQUEST_CONFLICT");
    const rule = await call(a, "team_rule_put", { shareId, title: "Rule", content: "First" });
    const edits = await Promise.all([a,b].map((client,i) => client.callTool({name:"team_rule_put",arguments:{shareId,ruleId:rule.id,expectedVersion:1,title:"Rule",content:"Edit "+i}})));
    expect(edits.filter(r=>!r.isError)).toHaveLength(1); expect(JSON.stringify(edits.find(r=>r.isError))).toContain("TEAM_VERSION_CONFLICT");
    expect(team.auditLog(owner, shareId)).toEqual(expect.arrayContaining([expect.objectContaining({ action: "rule.put", entity_id: rule.id, status: "failed" })]));
    await call(a,"team_rule_disable",{shareId,ruleId:rule.id,expectedVersion:2});
    expect((await call(b,"team_rule_list",{shareId})).items).toHaveLength(0);
    expect((await call(b,"team_rule_history",{shareId,ruleId:rule.id})).items.map((r:any)=>r.version)).toEqual([3,2,1]);
  });

  it("enforces shared scopes, roles, revocation and secret rejection", async () => {
    const {client:a,credential} = await connect("alice","a"), b=(await connect("bob","b")).client, v=(await connect("viewer","v")).client;
    await denied(a,"team_context",{shareId:otherShare},"TEAM_FORBIDDEN");
    await denied(a,"team_task_get",{shareId,taskId:privateTask},"TEAM_TASK_NOT_FOUND");
    expect(()=>knowledge.startTask({userId:"viewer",clientId:"test"},shareId,"blocked")).toThrow(/not permitted/);
    expect(()=>knowledge.putRule({userId:"bob",clientId:"test"},shareId,{title:"blocked",content:"blocked"})).toThrow(/not permitted/);
    expect((await b.listTools()).tools.map(t=>t.name)).not.toContain("team_rule_put");
    expect((await v.listTools()).tools.map(t=>t.name)).not.toContain("team_task_start");
    await denied(a,"team_rule_put",{shareId,title:"Bad secret",content:"-----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY-----"},"SENSITIVE_MEMORY_REJECTED");
    const plan=await call(a,"team_task_start",{shareId,goal:"Revocation probe"});
    const second=knowledge.startTask({userId:"other",clientId:"test"},otherShare,"Other shared plan");
    await denied(a,"team_task_get",{shareId,taskId:second.id},"TEAM_TASK_NOT_FOUND");
    expect((await call(v,"team_task_list",{shareId})).items[0].id).toBe(plan.id);
    team.revokeToken(credential.id);
    await expect(a.callTool({name:"team_task_get",arguments:{shareId,taskId:plan.id}})).rejects.toThrow();
  });
});
