import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { ProjectContextError } from "../shared/errors.js";
import type { TeamPrincipal } from "./team-service.js";
import { TeamKnowledgeService, sharedCheckpointSchema } from "./knowledge-service.js";

export function registerKnowledgeTools(server: McpServer, service: TeamKnowledgeService, principal: TeamPrincipal, roles: string[]) {
  const share = { shareId: z.string().min(1).max(256) };
  const task = { ...share, taskId: z.string().min(1).max(256) };
  const page = { limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().min(0).max(100000).default(0) };
  const version = { expectedVersion: z.number().int().min(1) };
  const outputSchema = { result: z.unknown() };
  const readOnly = { readOnlyHint: true };
  function invoke(work: () => unknown) {
    try { return { content: [{ type: "text" as const, text: "See structured result." }], structuredContent: { result: work() } }; }
    catch (error) { return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ code: error instanceof ProjectContextError ? error.code : "TEAM_OPERATION_FAILED", message: error instanceof ProjectContextError ? error.message : "Team operation failed." }) }] }; }
  }
  server.registerTool("team_context", { description: "Read shared memories, active project rules and plans from the server. Source code and personal rules remain on each developer's computer; no sync is required.", outputSchema, inputSchema: { ...share, query: z.string().max(500).default("") }, annotations: readOnly },
    ({ shareId, query }) => invoke(() => service.context(principal, shareId, query)));
  server.registerTool("team_task_list", { description: "Page through explicitly shared plans/tasks. Existing private local tasks are excluded.", outputSchema, inputSchema: { ...share, ...page, status: z.enum(["in_progress", "completed", "cancelled"]).default("in_progress") }, annotations: readOnly },
    ({ shareId, status, limit, offset }) => invoke(() => service.tasks(principal, shareId, status, limit, offset)));
  server.registerTool("team_task_get", { description: "Read a shared task and its current version before editing.", outputSchema, inputSchema: task, annotations: readOnly },
    ({ shareId, taskId }) => invoke(() => service.task(principal, shareId, taskId)));
  server.registerTool("team_task_history", { description: "Read paged shared task checkpoint history.", outputSchema, inputSchema: { ...task, ...page }, annotations: readOnly },
    ({ shareId, taskId, limit, offset }) => invoke(() => service.taskHistory(principal, shareId, taskId, limit, offset)));
  server.registerTool("team_rule_list", { description: "Read server-side shared project rules. These are separate from each developer's personal rules.", outputSchema, inputSchema: { ...share, ...page, status: z.enum(["active", "deleted"]).default("active") }, annotations: readOnly },
    ({ shareId, status, limit, offset }) => invoke(() => service.rules(principal, shareId, status, limit, offset)));
  server.registerTool("team_rule_history", { description: "Read shared rule versions, including superseded text and disabled state.", outputSchema, inputSchema: { ...share, ...page, ruleId: z.string().min(1).max(256) }, annotations: readOnly },
    ({ shareId, ruleId, limit, offset }) => invoke(() => service.ruleHistory(principal, shareId, ruleId, limit, offset)));
  if (roles.some(role => ["owner", "reviewer", "editor"].includes(role))) {
    server.registerTool("team_task_start", { description: "Create a shared plan/task on the server, immediately visible to other members of this shared project.", outputSchema, inputSchema: { ...share, goal: z.string().min(1).max(8000) } },
      ({ shareId, goal }) => invoke(() => service.startTask(principal, shareId, goal)));
    server.registerTool("team_task_checkpoint", { description: "Save shared progress with optimistic concurrency. Use the latest version and a requestId; repeat the same requestId only for an identical retry. TEAM_VERSION_CONFLICT requires rereading and merging.", outputSchema, inputSchema: { ...task, ...version, requestId: z.string().min(1).max(128), checkpoint: sharedCheckpointSchema } },
      ({ shareId, taskId, expectedVersion, requestId, checkpoint }) => invoke(() => service.checkpoint(principal, shareId, taskId, expectedVersion, requestId, checkpoint)));
    server.registerTool("team_task_finish", { description: "Complete or cancel a shared plan using the latest version. Retains checkpoint history.", outputSchema, inputSchema: { ...task, ...version, status: z.enum(["completed", "cancelled"]) } },
      ({ shareId, taskId, expectedVersion, status }) => invoke(() => service.finishTask(principal, shareId, taskId, expectedVersion, status)));
  }
  if (roles.some(role => role === "owner" || role === "reviewer")) {
    server.registerTool("team_rule_put", { description: "Create a shared project rule, or update ruleId with its expectedVersion. Old versions are retained; version conflicts never silently overwrite another member's edit.", outputSchema, inputSchema: { ...share, title: z.string().min(1).max(500), content: z.string().min(1).max(16000), ruleId: z.string().min(1).max(256).optional(), expectedVersion: z.number().int().min(1).optional() } },
      ({ shareId, title, content, ruleId, expectedVersion }) => invoke(() => service.putRule(principal, shareId, { title, content, ...(ruleId ? { ruleId } : {}), ...(expectedVersion !== undefined ? { expectedVersion } : {}) })));
    server.registerTool("team_rule_disable", { description: "Disable a shared rule using its current version, preserving history.", outputSchema, inputSchema: { ...share, ...version, ruleId: z.string().min(1).max(256) } },
      ({ shareId, ruleId, expectedVersion }) => invoke(() => service.disableRule(principal, shareId, ruleId, expectedVersion)));
  }
}
