import { z } from "zod/v4";
import { sharedCheckpointSchema, TeamKnowledgeService } from "./knowledge-service.js";
import type { TeamService, TeamPrincipal } from "./team-service.js";
import { memoryTypeSchema } from "../memory/memory-service.js";
import { ProjectContextError } from "../shared/errors.js";

const id = z.string().min(1).max(256);
const version = z.number().int().min(1);
const page = { limit: z.coerce.number().int().min(1).max(100).default(20), offset: z.coerce.number().int().min(0).max(100000).default(0) };
export const KNOWLEDGE_ACTIONS = ["memories", "tasks", "task", "task-history", "rules", "rule-history", "propose", "task-start", "task-checkpoint", "task-finish", "rule-put", "rule-disable"] as const;

/** A fixed allowlist: browser input can never choose arbitrary MCP tools or an actor. */
export function knowledgeAction(action: string, method: string, shareId: string, input: unknown) {
  id.parse(shareId);
  const read = ["memories", "tasks", "task", "task-history", "rules", "rule-history"].includes(action);
  if (method !== (read ? "GET" : "POST")) throw new ProjectContextError("TEAM_INVALID_ACTION", "Unsupported method for team operation.");
  function operation<T extends Record<string, unknown>>(name: string, args: T, run: (team: TeamService, principal: TeamPrincipal, knowledge: TeamKnowledgeService) => unknown) {
    return { name, args: { shareId, ...args }, run: (team: TeamService, principal: TeamPrincipal) => run(team, principal, new TeamKnowledgeService(team)) };
  }
  switch (action) {
    case "memories": {
      const a = z.object({ query: z.string().max(500).default(""), limit: page.limit }).strict().parse(input);
      return operation("team_search", a, (t,p) => t.memories(p,shareId,a.query,a.limit));
    }
    case "tasks": {
      const a = z.object({ ...page, status: z.enum(["in_progress","completed","cancelled"]).default("in_progress") }).strict().parse(input);
      return operation("team_task_list", a, (_t,p,k) => k.tasks(p,shareId,a.status,a.limit,a.offset));
    }
    case "task": {
      const a = z.object({ taskId: id }).strict().parse(input);
      return operation("team_task_get", a, (_t,p,k) => k.task(p,shareId,a.taskId));
    }
    case "task-history": {
      const a = z.object({ ...page, taskId: id }).strict().parse(input);
      return operation("team_task_history", a, (_t,p,k) => k.taskHistory(p,shareId,a.taskId,a.limit,a.offset));
    }
    case "rules": {
      const a = z.object({ ...page, status: z.enum(["active","deleted"]).default("active") }).strict().parse(input);
      return operation("team_rule_list", a, (_t,p,k) => k.rules(p,shareId,a.status,a.limit,a.offset));
    }
    case "rule-history": {
      const a = z.object({ ...page, ruleId: id }).strict().parse(input);
      return operation("team_rule_history", a, (_t,p,k) => k.ruleHistory(p,shareId,a.ruleId,a.limit,a.offset));
    }
    case "propose": {
      const a = z.object({ type: memoryTypeSchema, title: z.string().trim().min(1).max(500), content: z.string().trim().min(1).max(32000) }).strict().parse(input);
      return operation("team_propose", a, (t,p) => t.propose(p,shareId,a));
    }
    case "task-start": {
      const a = z.object({ goal: z.string().trim().min(1).max(8000) }).strict().parse(input);
      return operation("team_task_start", a, (_t,p,k) => k.startTask(p,shareId,a.goal));
    }
    case "task-checkpoint": {
      const a = z.object({ taskId: id, expectedVersion: version, requestId: z.string().min(1).max(128), checkpoint: sharedCheckpointSchema }).strict().parse(input);
      return operation("team_task_checkpoint", a, (_t,p,k) => k.checkpoint(p,shareId,a.taskId,a.expectedVersion,a.requestId,a.checkpoint));
    }
    case "task-finish": {
      const a = z.object({ taskId: id, expectedVersion: version, status: z.enum(["completed","cancelled"]) }).strict().parse(input);
      return operation("team_task_finish", a, (_t,p,k) => k.finishTask(p,shareId,a.taskId,a.expectedVersion,a.status));
    }
    case "rule-put": {
      const a = z.object({ title: z.string().trim().min(1).max(500), content: z.string().trim().min(1).max(16000), ruleId: id.optional(), expectedVersion: version.optional() }).strict().parse(input);
      const args = { title: a.title, content: a.content, ...(a.ruleId ? {ruleId:a.ruleId} : {}), ...(a.expectedVersion !== undefined ? {expectedVersion:a.expectedVersion} : {}) };
      return operation("team_rule_put", args, (_t,p,k) => k.putRule(p,shareId,args));
    }
    case "rule-disable": {
      const a = z.object({ ruleId: id, expectedVersion: version }).strict().parse(input);
      return operation("team_rule_disable", a, (_t,p,k) => k.disableRule(p,shareId,a.ruleId,a.expectedVersion));
    }
    default: throw new ProjectContextError("TEAM_INVALID_ACTION", "Unsupported team operation.");
  }
}
