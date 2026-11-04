import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectContextApp } from "../src/core/app.js";
import { startUiServer } from "../src/ui/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";

const quote = "TeamService provides SharedMemory.";
const document = { entities: [
  { key: "team", name: "TeamService", type: "service", aliases: ["团队知识中心"], evidence: quote },
  { key: "shared", name: "SharedMemory", type: "concept", aliases: [], evidence: quote },
], relations: [{ from: "team", to: "shared", type: "provides", evidence: quote }] } as const;
describe("local knowledge API and MCP", () => {
  let temp: string, app: ProjectContextApp, ui: Awaited<ReturnType<typeof startUiServer>>;
  let previous: Record<string, string | undefined>, projectId: string, otherId: string, memoryId: string, cookie: string;
  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), "knowledge-api-"));
    const environment = { PROJECT_CONTEXT_HOME: join(temp, "store"), PROJECT_CONTEXT_ALLOWED_ROOTS: temp, PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS: temp };
    previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]])); Object.assign(process.env, environment);
    await mkdir(join(temp, "project")); await mkdir(join(temp, "other"));
    app = await ProjectContextApp.create(); projectId = (await app.openProject(join(temp, "project"))).id;
    otherId = (await app.openProject(join(temp, "other"))).id;
    memoryId = app.remember(projectId, { type: "fact", title: "Architecture", content: quote, sourceKind: "user" }).id;
    ui = await startUiServer({ openBrowser: false });
    const token = new URLSearchParams(new URL(ui.launchUrl).hash.slice(1)).get("token");
    const r = await fetch(ui.url + "/api/session", { method: "POST", headers: { "Content-Type": "application/json", Origin: ui.url, "X-Project-Context-UI": "1" }, body: JSON.stringify({ token }) });
    cookie = r.headers.get("set-cookie")!.split(";")[0]!;
  });
  afterEach(async () => {
    await ui?.close(); app?.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(temp, { recursive: true, force: true });
  });
  function request(path: string, body?: unknown, authenticated = true, origin?: string) {
    return fetch(ui.url + path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", Origin: origin ?? ui.url, "X-Project-Context-UI": "1", ...(authenticated ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  it("requires existing authentication and project ownership for proposal/list/review", async () => {
    const path = `/api/projects/${projectId}/memory-knowledge`;
    expect((await request(path, { memoryId, document }, false)).status).toBe(401);
    expect((await request(path, { memoryId, document }, true, "https://outside.invalid")).status).toBe(403);
    expect((await request(`/api/projects/${otherId}/memory-knowledge`, { memoryId, document })).status).toBe(404);
    const proposed = await (await request(path, { memoryId, document })).json();
    expect(proposed.status).toBe("pending");
    expect((await request(`/api/projects/${otherId}/memory-knowledge/${proposed.id}/review`, { action: "accept", expectedVersion: 1 })).status).toBe(404);
    expect((await (await request(path + "?status=pending")).json()).total).toBe(1);
    expect((await (await request(`/api/projects/${projectId}/memory-graph?view=entities`)).json()).nodes).toEqual([]);
    expect((await request(path + `/${proposed.id}/review`, { action: "accept", expectedVersion: 9 })).status).toBe(409);
    const accepted = await (await request(path + `/${proposed.id}/review`, { action: "accept", expectedVersion: 1 })).json();
    expect(accepted.effectiveStatus).toBe("accepted");
    const graph = await (await request(`/api/projects/${projectId}/memory-graph?view=entities`)).json();
    expect(graph.edges.some((edge: { relationType: string }) => edge.relationType === "PROVIDES")).toBe(true);
    const entity = graph.nodes.find((node: { nodeType: string }) => node.nodeType === "entity");
    expect((await request(`/api/projects/${otherId}/memory-graph/nodes/${encodeURIComponent(entity.id)}`)).status).toBe(404);
    expect((await request(path + `/${proposed.id}/review`, { action: "reject", expectedVersion: 1 })).status).toBe(409);
    expect((await request(path + `/${proposed.id}/review`, { action: "reject", expectedVersion: accepted.version })).status).toBe(200);
    expect((await (await request(`/api/projects/${projectId}/memory-graph?view=entities`)).json()).nodes).toEqual([]);
  });
  it("rejects stale evidence, malformed fields and invented quotations without changing memory", async () => {
    const path = `/api/projects/${projectId}/memory-knowledge`;
    expect((await request(path, { memoryId, document, expectedMemoryHash: "0".repeat(64) })).status).toBe(409);
    expect((await request(path, { memoryId, document, accept: true })).status).toBe(400);
    expect((await request(path, { memoryId, document: { ...document, entities: [{ ...document.entities[0], evidence: "Invented quote" }], relations: [] } })).status).toBe(400);
    for (const suffix of ["?status=bad", "?limit=101", "?offset=-1"]) expect((await request(path + suffix)).status).toBe(400);
    expect(app.memory(projectId, memoryId).content).toBe(quote);
    expect(app.memoryKnowledge(projectId).total).toBe(0);
  });
  it("uses one MCP management tool and atomically attaches pending knowledge to new memory", async () => {
    const server = createMcpServer(), client = new Client({ name: "knowledge-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(b), client.connect(a)]);
    const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    try {
      expect((await client.listTools()).tools).toHaveLength(53);
      const invalid = await call("memory_remember", { projectId, type: "fact", title: "Invalid", content: "Different content", sourceKind: "user", knowledge: document });
      expect(invalid.isError).toBe(true);
      expect(app.memories(projectId, "active", 100)).toHaveLength(1);
      const saved = await call("memory_remember", { projectId, type: "fact", title: "Valid", content: quote, sourceKind: "user", knowledge: document });
      expect(saved.isError).not.toBe(true);
      const memory = saved.structuredContent!.result as { id: string; knowledgeProposal: { id: string; version: number; status: string } };
      expect(memory.knowledgeProposal.status).toBe("pending");
      const pending = await call("memory_knowledge", { projectId, action: "list", status: "pending" });
      expect((pending.structuredContent!.result as { total: number }).total).toBe(1);
      expect((await call("memory_knowledge", { projectId, action: "accept", id: memory.knowledgeProposal.id, expectedVersion: 1 })).isError).not.toBe(true);
      const retry = await call("memory_knowledge", { projectId, action: "propose", memoryId: memory.id, document });
      expect((retry.structuredContent!.result as { status: string }).status).toBe("accepted");
      expect((await call("memory_knowledge", { projectId, action: "propose" })).isError).toBe(true);
    } finally { await client.close(); await server.close(); }
  });
});
