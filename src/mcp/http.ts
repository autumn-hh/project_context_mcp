import { createServer, type IncomingMessage } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod/v4";
import { ProjectContextApp } from "../core/app.js";
import { TeamService, type TeamPrincipal } from "../team/team-service.js";
import { ProjectContextError } from "../shared/errors.js";
import { PACKAGE_VERSION } from "../shared/version.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

function teamMcp(service: TeamService, principal: TeamPrincipal) {
  const server = new McpServer({ name: "project-context-team", version: PACKAGE_VERSION });
  const share = { shareId: z.string().min(1).max(256) }; const outputSchema = { result: z.unknown() };
  const invoke = async (work: () => unknown) => {
    try { const result = await work(); return { content: [{ type: "text" as const, text: "See structured result." }], structuredContent: { result } }; }
    catch (error) { return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ code: error instanceof ProjectContextError ? error.code : "TEAM_OPERATION_FAILED",
      message: error instanceof ProjectContextError ? error.message : "Team operation failed." }) }] }; }
  };
  server.registerTool("team_projects", { description: "List only projects explicitly shared with this principal.", outputSchema, annotations: { readOnlyHint: true } }, () => invoke(() => service.listShares(principal)));
  server.registerTool("team_search", { description: "Search shared active knowledge within permitted memory types.", outputSchema,
    inputSchema: { ...share, query: z.string().max(500).default(""), limit: z.number().int().min(1).max(100).default(50) }, annotations: { readOnlyHint: true } },
  ({ shareId, query, limit }) => invoke(() => service.memories(principal, shareId, query, limit)));
  server.registerTool("team_presence_list", { description: "List unexpired task presence hints; these do not provide mutual exclusion.", outputSchema, inputSchema: share, annotations: { readOnlyHint: true } },
    ({ shareId }) => invoke(() => service.presence(principal, shareId)));
  server.registerTool("team_code_graph", { description: "Export a bounded read-only graph of explicitly shared code metadata; no source text, signatures or evidence.",outputSchema,inputSchema:share,annotations:{readOnlyHint:true}},
    ({shareId}) => invoke(() => service.codeGraph(principal,shareId)));
  const roles = service.db.prepare("SELECT role FROM team_members WHERE user_id=?").pluck().all(principal.userId) as string[];
  if (roles.some(role => role !== "viewer")) {
    server.registerTool("team_candidate_list", { description: "List review candidates in permitted shared scopes.", outputSchema, inputSchema: share, annotations: { readOnlyHint: true } },
      ({ shareId }) => invoke(() => service.candidates(principal, shareId)));
    server.registerTool("team_propose", { description: "Propose shared knowledge for review using the authenticated principal identity.", outputSchema,
      inputSchema: { ...share, type: z.string().min(1), title: z.string().min(1).max(500), content: z.string().min(1).max(32000) } },
    ({ shareId, ...input }) => invoke(() => service.propose(principal, shareId, input)));
    server.registerTool("team_candidate_accept", { description: "Accept a candidate if the current role meets this share's review policy.", outputSchema,
      inputSchema: { ...share, candidateId: z.string().min(1) } }, ({ shareId, candidateId }) => invoke(() => service.accept(principal, shareId, candidateId)));
    server.registerTool("team_presence", { description: "Claim or renew a task hint for up to 300 seconds; ttlSeconds=0 releases it.", outputSchema,
      inputSchema: { ...share, taskId: z.string().min(1), ttlSeconds: z.number().int().min(0).max(300).default(120) } },
    ({ shareId, taskId, ttlSeconds }) => invoke(() => service.presence(principal, shareId, taskId, ttlSeconds)));
  }
  if (roles.some(role => role === "owner" || role === "reviewer")) {
    server.registerTool("team_conflict_list", { description: "List shared memory conflicts available to reviewers.", outputSchema, inputSchema: share, annotations: { readOnlyHint: true } },
      ({ shareId }) => invoke(() => service.conflicts(principal, shareId)));
    server.registerTool("team_conflict_resolve", { description: "Select a competing shared memory event and audit the resolution.", outputSchema,
      inputSchema: { ...share, entity: z.string().min(1), eventId: z.string().min(1) } }, ({ shareId, entity, eventId }) => invoke(() => service.resolve(principal, shareId, entity, eventId)));
    server.registerTool("team_audit_export", { description: "Page through project/workspace audit entries, 1000 per page; repeat with offset + 1000 until empty.", outputSchema, inputSchema: {...share,offset:z.number().int().min(0).max(10000000).default(0)}, annotations: { readOnlyHint: true } },
      ({ shareId,offset }) => invoke(() => service.auditLog(principal, shareId,offset)));
  }
  return server;
}

async function jsonBody(request: IncomingMessage) {
  const parts: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) { bytes += chunk.length; if (bytes > 128 * 1024) throw new ProjectContextError("TEAM_REQUEST_TOO_LARGE", "Request exceeds 128 KiB."); parts.push(chunk); }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}

export async function startTeamHttp(options: { port?: number } = {}) {
  const app = await ProjectContextApp.create(); const service = new TeamService(app);
  const pending = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    const work = (async () => {
      response.setHeader("Cache-Control", "no-store"); response.setHeader("X-Content-Type-Options", "nosniff");
      try {
        if (request.url !== "/mcp" || request.method !== "POST") { response.writeHead(405).end(); return; }
        const host = request.headers.host ?? "";
        if (!/^127[.]0[.]0[.]1:[0-9]+$/.test(host) && !/^localhost:[0-9]+$/.test(host)) throw new ProjectContextError("TEAM_INVALID_HOST", "Unrecognized endpoint host.");
        if (request.headers.origin) throw new ProjectContextError("TEAM_ORIGIN_REJECTED", "Browser origins are not enabled for this MCP endpoint.");
        const header = request.headers.authorization ?? "";
        if (!header.startsWith("Bearer ")) throw new ProjectContextError("TEAM_UNAUTHENTICATED", "Bearer authentication is required.");
        service.authenticate(header.slice(7));
        const body = await jsonBody(request);
        const principal = service.authenticate(header.slice(7));
        const mcp = teamMcp(service, principal);
        const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
        // SDK optional callback declarations predate exactOptionalPropertyTypes.
        try { await mcp.connect(transport as Transport); await transport.handleRequest(request, response, body); }
        finally { await transport.close(); await mcp.close(); }
      } catch (error) {
        if (!response.headersSent) {
          const code = error instanceof ProjectContextError ? error.code : "TEAM_BAD_REQUEST";
          response.writeHead(code === "TEAM_UNAUTHENTICATED" ? 401 : 400, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ code, message: error instanceof ProjectContextError ? error.message : "Invalid request." }));
        } else response.end();
      }
    })();
    pending.add(work); void work.finally(() => pending.delete(work));
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 50;
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  } catch (error) { service.close(); app.close(); throw error; }
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/mcp`, port, close: async () => {
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections(); await Promise.allSettled([...pending]); await closed; service.close(); app.close();
  } };
}
