#!/usr/bin/env node
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { pathToFileURL } from "node:url";
import { ProjectContextApp, stopAllProjectWatches } from "../core/app.js";
import { loadGlobalConfig } from "../config/paths.js";
import { ProjectContextError, errorMessage } from "../shared/errors.js";
import { memoryStatusSchema, memoryTypeSchema } from "../memory/memory-service.js";
import { candidateReviewSchema } from "../memory/candidate-service.js";
import { PACKAGE_VERSION } from "../shared/version.js";
import { userMemoryScopeSchema, userMemorySourceKindSchema } from "../memory/user-memory-service.js";
import { DEFAULT_WATCH_DEBOUNCE_MS } from "../indexing/watch-service.js";
import { DEFAULT_CONTEXT_BUDGET_TOKENS } from "../context/context-service.js";
import { briefCleanupResult, maintenancePolicySchema, retentionDaysSchema } from "../maintenance/storage-maintenance.js";
import { withBriefProtection } from "../indexing/content-protection.js";
import { taskQuerySchema } from "../tasks/task-query.js";
import { taskWorkflowShape } from '../tasks/task-workflow.js';
import { SYNC_TABLES } from "../storage/sync/event-store.js";
import { searchWithEmbeddings } from "../search/embeddings.js";
import { lspDefinition } from "../lsp/bridge.js";
import { memoryGraphInputShape, memoryGraphNodeIdSchema } from "../memory/graph-input.js";
import { knowledgeDocumentSchema } from "../memory/knowledge-schema.js";
import { isOutdatedProcessError, reportStoppedServers } from "../shared/process-freshness.js";

const checkpointSchema = {
  ...taskWorkflowShape,
  summary: z.string().optional(),
  completed: z.array(z.string()).optional(),
  next: z.array(z.string()).optional(),
  changedFiles: z.array(z.string()).optional(),
  verification: z.array(z.object({
    command: z.string(),
    status: z.string(),
    summary: z.string().optional(),
  })).optional(),
  blockers: z.array(z.string()).optional(),
  risks: z.array(z.string()).optional(),
};
const outputSchema = { result: z.unknown() };
const MAX_TEXT_CONTENT_CHARS = 2_000;

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "project-context-mcp", version: PACKAGE_VERSION });
  server.registerTool("project_search_enhanced", {
    description:"Search with an explicitly configured embedding plugin; fall back to local search when unavailable.",outputSchema,
    inputSchema:{projectId:z.string(),query:z.string().max(8000),limit:z.number().int().min(1).max(100).default(20)},
  },({projectId,query,limit})=>withApp(async app=>{await app.watchFlush(projectId);return searchWithEmbeddings(app,projectId,query,limit);}));
  server.registerTool("project_definition", {
    description:"Use a CLI-configured trusted local LSP server to find definitions within indexed project files. Coordinates are zero-based UTF-16.",outputSchema,
    inputSchema:{projectId:z.string(),path:z.string().min(1).max(2000),line:z.number().int().min(0),character:z.number().int().min(0)},
  },({projectId,path,line,character})=>withApp(app=>lspDefinition(app,projectId,path,line,character)));

  server.registerTool("storage_status", {
    description: "Check whether persistent Project Context storage has been configured.",
    outputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async () => {
    try {
      const config = await loadGlobalConfig();
      return response({ configured: true, storageRoot: config.storageRoot });
    } catch (error) {
      if (error instanceof ProjectContextError && error.code === "STORAGE_NOT_CONFIGURED") {
        return response({ configured: false, suggestedCommand: "project-context init" });
      }
      return errorResponse(error);
    }
  });

  server.registerTool("project_open", {
    description: "Open a project, synchronize its index, and start managed process-lifetime change tracking.",
    outputSchema,
    inputSchema: { root: z.string().min(1) },
    annotations: { idempotentHint: true },
  }, ({ root }, extra) => withApp(async (app) => {
    const project = await app.openProject(root);
    try {
      const managedIndex = await app.index(project.id, {
        signal: extra.signal,
        ...((extra._meta?.progressToken !== undefined) ? {
          onProgress: (progress) => extra.sendNotification({
            method: "notifications/progress",
            params: {
              progressToken: extra._meta!.progressToken!,
              progress: progress.visited,
              message: `${progress.phase}: ${progress.path ?? `${progress.indexed} files indexed`}`,
            },
          }),
        } : {}),
      });
      const watch = app.watchStart(project.id, DEFAULT_WATCH_DEBOUNCE_MS, false);
      return { ...project, managedIndex, watch };
    } catch (error) {
      // An outdated process keeps serving reads from the existing index; only indexing pauses.
      if (!isOutdatedProcessError(error)) throw error;
      return { ...project, managedIndex: null, watch: null, warnings: [errorMessage(error)] };
    }
  }));

  server.registerTool("project_list", {
    description: "List projects already registered in persistent storage.",
    outputSchema,
    inputSchema: { includeArchived: z.boolean().default(false) },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, ({ includeArchived }) => withApp((app) => app.projects.list(includeArchived)));

  server.registerTool("project_update", {
    description: "Update mutable project metadata without changing its root path.",
    outputSchema,
    inputSchema: { projectId: z.string().min(1), name: z.string().min(1) },
    annotations: { idempotentHint: true },
  }, ({ projectId, name }) => withApp((app) => app.updateProject(projectId, name)));

  server.registerTool("project_archive", {
    description: "Archive a project while retaining its database, memories, tasks, and audit history.",
    outputSchema,
    inputSchema: { projectId: z.string().min(1) },
    annotations: { idempotentHint: true },
  }, ({ projectId }) => withApp((app) => app.archiveProject(projectId)));

  server.registerTool("project_unarchive", {
    description: "Return an archived project to the default active project list.",
    outputSchema,
    inputSchema: { projectId: z.string().min(1) },
    annotations: { idempotentHint: true },
  }, ({ projectId }) => withApp((app) => app.unarchiveProject(projectId)));

  server.registerTool("project_relocate", {
    description: "Update a registered project to an authorized existing root without moving project files.",
    outputSchema,
    inputSchema: { projectId: z.string().min(1), newRoot: z.string().min(1) },
    annotations: { idempotentHint: true, openWorldHint: true },
  }, ({ projectId, newRoot }) => withApp((app) => app.relocateProject(projectId, newRoot)));

  server.registerTool("project_delete", {
    description: "Preview or permanently purge an archived project with exact-ID confirmation and safety checks.",
    outputSchema,
    inputSchema: {
      projectId: z.string().min(1),
      confirmProjectId: z.string().min(1),
      purge: z.boolean().default(false),
      backupDestination: z.string().optional(),
    },
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, ({ projectId, confirmProjectId, purge, backupDestination }) => withApp((app) => app.deleteProject(projectId, {
    confirmProjectId,
    purge,
    ...(backupDestination ? { backupDestination } : {}),
  })));

  server.registerTool("project_restore", {
    description: "Restore a validated project backup into a new root or replace an explicitly confirmed archived project.",
    outputSchema,
    inputSchema: {
      source: z.string().min(1),
      root: z.string().optional(),
      name: z.string().optional(),
      projectId: z.string().optional(),
      confirmProjectId: z.string().optional(),
    },
    annotations: { idempotentHint: false, openWorldHint: true },
  }, (args) => withApp((app) => app.restoreProject({
    source: args.source,
    ...(args.root ? { root: args.root } : {}),
    ...(args.name ? { name: args.name } : {}),
    ...(args.projectId ? { projectId: args.projectId } : {}),
    ...(args.confirmProjectId ? { confirmProjectId: args.confirmProjectId } : {}),
  })));

  server.registerTool("project_restore_encrypted", {
    description: "Decrypt and restore an authenticated project backup using a passphrase from a named environment variable.",
    outputSchema,
    inputSchema: {
      source: z.string().min(1),
      passphraseEnv: z.string().min(1),
      root: z.string().optional(),
      name: z.string().optional(),
      projectId: z.string().optional(),
      confirmProjectId: z.string().optional(),
    },
    annotations: { idempotentHint: false, openWorldHint: true },
  }, (args) => withApp((app) => app.encryptedRestore({
    source: args.source,
    passphraseEnv: args.passphraseEnv,
    ...(args.root ? { root: args.root } : {}),
    ...(args.name ? { name: args.name } : {}),
    ...(args.projectId ? { projectId: args.projectId } : {}),
    ...(args.confirmProjectId ? { confirmProjectId: args.confirmProjectId } : {}),
  })));

  server.registerTool("project_watch_start", {
    description: "Start a debounced process-lifetime watcher that incrementally indexes changes without accepting candidates.",
    outputSchema,
    inputSchema: {
      projectId: z.string().min(1),
      debounceMs: z.number().int().min(100).max(60_000).default(DEFAULT_WATCH_DEBOUNCE_MS),
      initialIndex: z.boolean().default(true),
    },
    annotations: { idempotentHint: true },
  }, ({ projectId, debounceMs, initialIndex }) => withApp((app) => (
    app.watchStart(projectId, debounceMs, initialIndex)
  )));

  server.registerTool("project_watch_stop", {
    description: "Stop a process-lifetime project watcher.",
    outputSchema,
    inputSchema: { projectId: z.string().min(1) },
    annotations: { idempotentHint: false },
  }, ({ projectId }) => withApp((app) => app.watchStop(projectId)));

  server.registerTool("project_watch_list", {
    description: "List process-lifetime project watchers and their latest index status.",
    outputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, () => withApp((app) => app.watchList()));

  server.registerTool("project_index", {
    description: "Incrementally index allowed text, code, configuration, and documentation files for a project.",
    outputSchema,
    inputSchema: { projectId: z.string().min(1) },
    annotations: { idempotentHint: true },
  }, ({ projectId }, extra) => withApp((app) => app.index(projectId, {
    signal: extra.signal,
    ...((extra._meta?.progressToken !== undefined) ? {
      onProgress: (progress) => extra.sendNotification({
        method: "notifications/progress",
        params: {
          progressToken: extra._meta!.progressToken!,
          progress: progress.visited,
          message: `${progress.phase}: ${progress.path ?? `${progress.indexed} files indexed`}`,
        },
      }),
    } : {}),
  })));

  server.registerTool("project_search", {
    description: "Search indexed text, symbols and active memories using FTS5, n-grams and fused memory recall. Memory hits can include matched terms and channels; use project_context for task-scoped selection.",
    outputSchema,
    inputSchema: {
      projectId: z.string().min(1),
      query: z.string().min(1),
      limit: z.number().int().min(1).max(100).default(20),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, ({ projectId, query, limit }) => withApp(async (app) => {
    await app.watchFlush(projectId);
    return app.search(projectId, query, limit);
  }));

  server.registerTool("project_context", {
    description: "Assemble task-focused project context from active memories, task checkpoints, and indexed sources.",
    outputSchema,
    inputSchema: {
      projectId: z.string().min(1),
      task: z.string().min(1),
      budgetTokens: z.number().int().min(500).max(100_000).default(DEFAULT_CONTEXT_BUDGET_TOKENS),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, ({ projectId, task, budgetTokens }) => withApp(async (app) => {
    await app.watchFlush(projectId);
    return app.context(projectId, task, budgetTokens);
  }));

  server.registerTool("memory_graph", {
    description: "Explore local knowledge with sparse possible topic links and explicit supersession. Possible links show shared terms and excerpts, never dependency or agreement. Use view=evidence for sources/tasks/scopes; history and task summaries are opt-in.",
    outputSchema,
    inputSchema: { projectId: z.string().min(1), ...memoryGraphInputShape },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, ({ projectId, ...options }) => withApp(async (app) => {
    await app.watchFlush(projectId);
    return app.memoryGraph(projectId, options);
  }));

  server.registerTool("memory_graph_node", {
    description: "Read a local memory graph node and its stored source evidence. Does not read arbitrary files or accept candidates.",
    outputSchema,
    inputSchema: {
      projectId: z.string().min(1), nodeId: memoryGraphNodeIdSchema,
      includeInactive: z.boolean().default(false),
      includeSummaries: z.boolean().default(false),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, ({ projectId, nodeId, includeInactive, includeSummaries }) => withApp(async (app) => {
    await app.watchFlush(projectId);
    return app.memoryGraphNode(projectId, nodeId, { includeInactive, includeSummaries });
  }));

  server.registerTool("memory_remember", {
    description: "Persist sourced memory. Optional knowledge declares entities, aliases and exact-quote relationships as pending proposals; it never auto-accepts relationships.",
    outputSchema,
    inputSchema: {
      projectId: z.string().min(1),
      type: memoryTypeSchema,
      title: z.string().min(1),
      content: z.string().min(1),
      reason: z.string().optional(),
      status: memoryStatusSchema.default("active"),
      confidence: z.number().min(0).max(1).optional(),
      scope: z.array(z.string()).default([]),
      sourceKind: z.string().min(1),
      sourceRef: z.string().optional(),
      supersedesId: z.string().optional(),
      knowledge: knowledgeDocumentSchema.optional(),
    },
    annotations: { idempotentHint: false },
  }, (args) => withApp((app) => app.remember(args.projectId, {
    type: args.type,
    title: args.title,
    content: args.content,
    status: args.status,
    scope: args.scope,
    sourceKind: args.sourceKind,
    ...(args.reason ? { reason: args.reason } : {}),
    ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
    ...(args.sourceRef ? { sourceRef: args.sourceRef } : {}),
    ...(args.supersedesId ? { supersedesId: args.supersedesId } : {}),
    ...(args.knowledge ? { knowledge: args.knowledge } : {}),
  })));

  server.registerTool("memory_knowledge", {
    description: "List, propose or explicitly review local entity/alias/relationship annotations. Proposals need continuous memory quotations and remain pending until accept. Read original evidence and check negation, conditions and aliases before accepting; no automatic acceptance. Use expectedVersion for review and expectedMemoryHash for stale-write protection.",
    outputSchema,
    inputSchema: {
      projectId: z.string().min(1), action: z.enum(["list", "propose", "accept", "reject"]).default("list"),
      memoryId: z.string().min(1).max(200).optional(), id: z.string().regex(/^mknow_[a-f0-9]{64}$/u).optional(),
      document: knowledgeDocumentSchema.optional(), expectedMemoryHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
      expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
      status: z.enum(["all", "pending", "accepted", "rejected", "superseded", "stale"]).default("all"),
      query: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).max(1_000_000).default(0),
    },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, (args) => withApp(async (app) => {
    await app.watchFlush(args.projectId);
    if (args.action === "list") return app.memoryKnowledge(args.projectId, args);
    if (args.action === "propose") {
      if (!args.memoryId || !args.document) throw new ProjectContextError("INVALID_MEMORY_KNOWLEDGE", "Propose requires memoryId and document.");
      return app.proposeKnowledge(args.projectId, args.memoryId, args.document, args.expectedMemoryHash);
    }
    if (!args.id || args.expectedVersion === undefined) throw new ProjectContextError("INVALID_MEMORY_KNOWLEDGE", "Review requires id and expectedVersion.");
    return app.reviewKnowledge(args.projectId, { id: args.id, action: args.action, expectedVersion: args.expectedVersion });
  }));

  server.registerTool("user_memory_remember", {
    description: "Persist a reviewed user-level memory with explicit cross-project scope.",
    outputSchema,
    inputSchema: {
      type: memoryTypeSchema,
      title: z.string().min(1),
      content: z.string().min(1),
      reason: z.string().optional(),
      confidence: z.number().min(0).max(1).optional(),
      scopeLevel: userMemoryScopeSchema.default("user"),
      projectId: z.string().optional(),
      scopeRef: z.string().optional(),
      sourceKind: userMemorySourceKindSchema,
      supersedesId: z.string().optional(),
    },
    annotations: { idempotentHint: false },
  }, (args) => withApp((app) => app.rememberUser({
    type: args.type,
    title: args.title,
    content: args.content,
    scopeLevel: args.scopeLevel,
    sourceKind: args.sourceKind,
    ...(args.reason ? { reason: args.reason } : {}),
    ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
    ...(args.projectId ? { projectId: args.projectId } : {}),
    ...(args.scopeRef ? { scopeRef: args.scopeRef } : {}),
    ...(args.supersedesId ? { supersedesId: args.supersedesId } : {}),
  })));

  server.registerTool("user_memory_list", {
    description: "List user-level memories by lifecycle status.",
    outputSchema,
    inputSchema: {
      status: memoryStatusSchema.default("active"),
      limit: z.number().int().min(1).max(200).default(50),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, ({ status, limit }) => withApp((app) => app.userMemories(status, limit)));

  server.registerTool("user_memory_update_status", {
    description: "Move a user-level memory to another lifecycle status.",
    outputSchema,
    inputSchema: { memoryId: z.string().min(1), status: memoryStatusSchema },
    annotations: { destructiveHint: true, idempotentHint: true },
  }, ({ memoryId, status }) => withApp((app) => app.setUserMemoryStatus(memoryId, status)));

  server.registerTool("memory_list", {
    description: "List project memories by lifecycle status.",
    outputSchema,
    inputSchema: {
      projectId: z.string().min(1),
      status: memoryStatusSchema.default("active"),
      limit: z.number().int().min(1).max(200).default(50),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, ({ projectId, status, limit }) => withApp((app) => app.memories(projectId, status, limit)));

  server.registerTool("memory_update_status", {
    description: "Move a memory to another lifecycle status such as stale, conflicted, rejected, or deleted.",
    outputSchema,
    inputSchema: {
      projectId: z.string().min(1),
      memoryId: z.string().min(1),
      status: memoryStatusSchema,
    },
    annotations: { destructiveHint: true, idempotentHint: true },
  }, ({ projectId, memoryId, status }) => withApp((app) => app.setMemoryStatus(projectId, memoryId, status)));

  server.registerTool("memory_candidates", {
    description: "List sourced memory candidates that require explicit review before becoming long-term memory.",
    outputSchema,
    inputSchema: {
      projectId: z.string().min(1),
      status: z.enum(["pending", "accepted", "rejected", "superseded"]).default("pending"),
      limit: z.number().int().min(1).max(200).default(50),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, ({ projectId, status, limit }) => withApp((app) => app.candidates(projectId, status, limit)));

  server.registerTool("memory_candidate_accept", {
    description: "Accept a reviewed candidate as sourced active memory. Optionally provide a stable type, title, and conclusion in review; the original candidate remains in the audit record.",
    outputSchema,
    inputSchema: { projectId: z.string().min(1), candidateId: z.string().min(1), review: candidateReviewSchema.optional(), knowledge: knowledgeDocumentSchema.optional() },
    annotations: { idempotentHint: false },
  }, ({ projectId, candidateId, review, knowledge }) => withApp((app) => app.acceptCandidate(projectId, candidateId, review, knowledge)));

  server.registerTool("memory_candidate_reject", {
    description: "Reject a reviewed memory candidate without deleting its audit record.",
    outputSchema,
    inputSchema: { projectId: z.string().min(1), candidateId: z.string().min(1) },
    annotations: { destructiveHint: true, idempotentHint: true },
  }, ({ projectId, candidateId }) => withApp((app) => app.rejectCandidate(projectId, candidateId)));

  server.registerTool("task_start", {
    description: "Start a persistent task with an acceptance goal. Defaults to executing; use backlog for unscheduled work. Waiting/paused require waitingReason; pause only on explicit user instruction.",
    outputSchema,
    inputSchema: { projectId: z.string().min(1), goal: z.string().min(1), ...taskWorkflowShape },
    annotations: { idempotentHint: false },
  }, ({ projectId, goal, ...workflow }) => withApp((app) => app.startTask(projectId, goal, { source: "mcp", ...workflow })));

  server.registerTool("task_checkpoint", {
    description: "Patch a task checkpoint atomically: omitted fields are preserved; supplied arrays replace the whole field and [] clears it. Record stage, next actions and acceptance evidence. Reuse requestId only for an identical retry. Closed tasks require task_reopen before changing required work or verification.",
    outputSchema,
    inputSchema: { projectId: z.string().min(1), taskId: z.string().min(1), requestId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:/-]+$/).optional(), ...checkpointSchema },
    annotations: { idempotentHint: true },
  }, ({ projectId, taskId, requestId, verification, ...checkpoint }) => withApp((app) => app.checkpoint(
    projectId,
    taskId,
    { ...checkpoint, ...(verification !== undefined ? {verification:verification.map(item => ({command:item.command,status:item.status,...(item.summary !== undefined ? {summary:item.summary} : {})}))} : {}) },
    { source: "mcp", ...(requestId ? { requestId } : {}) },
  )));

  server.registerTool("task_list", {
    description: "List persistent tasks for a project by status.",
    outputSchema,
    inputSchema: {
      projectId: z.string().min(1),
      status: z.enum(["in_progress", "completed", "cancelled"]).default("in_progress"),
      limit: z.number().int().min(1).max(100).default(20),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, ({ projectId, status, limit }) => withApp((app) => app.tasks(projectId, status, limit)));

  server.registerTool("task_query", {
    description: "Page through tasks in one or all projects. Stage filters only unfinished tasks; missing legacy stages match untriaged. Returns project provenance and partial-read warnings; archived projects are excluded by default.",
    outputSchema,
    inputSchema: taskQuerySchema.shape,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, (input) => withApp((app) => app.queryTasks(input)));

  server.registerTool("task_history", {
    description: "Read task snapshots newest first with pagination. The newest event sequence is expectedRevision for reopen/complete/cancel. Legacy migration snapshots do not reconstruct earlier history.",
    outputSchema,
    inputSchema: {
      projectId: z.string().min(1), taskId: z.string().min(1),
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).max(100_000).default(0),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, ({ projectId, taskId, limit, offset }) => withApp((app) => app.taskHistory(projectId, taskId, { limit, offset })));

  server.registerTool("task_complete", {
    description: "Flush pending index changes, then complete only with a final conclusion, no next actions/blockers, passed acceptance criteria with evidence and passing latest results for each verification command. Supply expectedRevision to reject stale writes; otherwise keep the task unfinished.",
    outputSchema,
    inputSchema: { projectId: z.string().min(1), taskId: z.string().min(1), expectedRevision:z.number().int().min(0).optional() },
    annotations: { idempotentHint: true },
  }, ({ projectId, taskId, expectedRevision }) => withApp(async (app) => {
    await app.watchFlush(projectId);
    return app.completeTask(projectId, taskId, undefined, { source: "mcp", ...(expectedRevision !== undefined ? {expectedRevision} : {}) });
  }));

  server.registerTool('task_reopen', {
    description: 'Reopen a closed task into acceptance with a reason and a pending criterion, preserving original completion history. Read the newest task_history sequence as expectedRevision; reuse requestId and the identical payload for retries.',
    outputSchema, inputSchema: { projectId:z.string().min(1), taskId:z.string().min(1), reason:z.string().trim().min(1).max(2000),
      requestId:z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:/-]+$/), expectedRevision:z.number().int().min(0) },
    annotations: { idempotentHint:true },
  }, ({projectId,taskId,reason,requestId,expectedRevision}) => withApp(app => app.reopenTask(projectId,taskId,reason,{source:'mcp',requestId,expectedRevision})));

  server.registerTool("task_cancel", {
    description: "Flush managed project changes, then cancel an in-progress task while retaining its checkpoint.",
    outputSchema,
    inputSchema: { projectId: z.string().min(1), taskId: z.string().min(1), expectedRevision:z.number().int().min(0).optional() },
    annotations: { destructiveHint: true, idempotentHint: true },
  }, ({ projectId, taskId, expectedRevision }) => withApp(async (app) => {
    await app.watchFlush(projectId);
    return app.cancelTask(projectId, taskId, { source: "mcp", ...(expectedRevision !== undefined ? {expectedRevision} : {}) });
  }));

  server.registerTool("project_health", {
    description: "Report source, chunk, symbol-coverage, memory, task, and latest index-run health for a project.",
    outputSchema,
    inputSchema: { projectId: z.string().min(1) },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, ({ projectId }) => withApp((app) => app.healthOverview(projectId)));

  server.registerTool("project_doctor", {
    description: "Check database integrity, derived search indexes, source presence, stale memory, and pending candidates.",
    outputSchema,
    inputSchema: { projectId: z.string().min(1), repair: z.boolean().default(false) },
    annotations: { idempotentHint: true },
  }, ({ projectId, repair }) => withApp(async (app) => withBriefProtection(await app.doctor(projectId, repair))));

  server.registerTool("project_storage", {
    description: "Inspect project database, WAL, free-page space, row counts, and automatic maintenance settings. Recent cleanups and index runs are short summaries; saved process logs and error text are in the Web workbench.",
    outputSchema,
    inputSchema: { projectId: z.string() },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, ({ projectId }) => withApp((app) => app.storageOverview(projectId)));

  server.registerTool("project_cleanup", {
    description: "Preview by default; explicitly confirm to prune old index logs and compact SQLite. Preserves all memories, tasks, candidates and current indexes. The first compaction rewrites the file and may take time on large databases; afterwards free pages are reclaimed in short steps. Listed runs are short summaries without process logs or error text.",
    outputSchema,
    inputSchema: {
      projectId: z.string(), dryRun: z.boolean().default(true),
      retentionDays: retentionDaysSchema.default(30), vacuum: z.boolean().default(true),
      confirmProjectId: z.string().optional(),
    },
    annotations: { destructiveHint: true },
  }, ({ projectId, confirmProjectId, ...options }) => withApp((app) => briefCleanupResult(app.cleanupProject(projectId, {
    ...options, ...(confirmProjectId ? { confirmProjectId } : {}),
  }))));

  server.registerTool("project_maintenance_configure", {
    description: "Enable or disable per-project automatic database cleanup after indexing. Enabled by default; preserves memories, tasks, candidates and current indexes.",
    outputSchema,
    inputSchema: { projectId: z.string(), ...maintenancePolicySchema.shape },
    annotations: { idempotentHint: true },
  }, ({ projectId, ...policy }) => withApp((app) => app.setMaintenanceSettings(projectId, policy)));

  server.registerTool("project_backup", {
    description: "Create a consistent online SQLite backup at a new absolute destination path.",
    outputSchema,
    inputSchema: { projectId: z.string().min(1), destination: z.string().min(1) },
    annotations: { idempotentHint: false, openWorldHint: true },
  }, ({ projectId, destination }) => withApp((app) => app.backup(projectId, destination)));

  server.registerTool("project_backup_encrypted", {
    description: "Create an AES-256-GCM project backup using a passphrase from a named environment variable.",
    outputSchema,
    inputSchema: {
      projectId: z.string().min(1),
      destination: z.string().min(1),
      passphraseEnv: z.string().min(1),
    },
    annotations: { idempotentHint: false, openWorldHint: true },
  }, ({ projectId, destination, passphraseEnv }) => withApp((app) => (
    app.encryptedBackup(projectId, destination, passphraseEnv)
  )));

  server.registerTool("project_export", {
    description: "Export project memories, candidates, tasks, symbols, relations, and a manifest as JSONL files.",
    outputSchema,
    inputSchema: { projectId: z.string().min(1), outputDirectory: z.string().min(1) },
    annotations: { idempotentHint: false, openWorldHint: true },
  }, ({ projectId, outputDirectory }) => withApp((app) => app.export(projectId, outputDirectory)));

  registerResources(server);
  server.registerTool("sync_status", {
    description: "Inspect local sync identity, pending events, rule outbox and unresolved conflicts.", outputSchema,
    inputSchema: { projectId: z.string().min(1) }, annotations: { readOnlyHint: true, idempotentHint: true },
  }, ({ projectId }) => withApp(app => app.syncStatus(projectId)));
  server.registerTool("sync_push", {
    description: "Encrypt and push pending events to the configured sync space; local edits remain queued on failure.", outputSchema,
    inputSchema: { projectId: z.string().min(1) }, annotations: { openWorldHint: true, idempotentHint: true },
  }, ({ projectId }) => withApp(app => app.syncPush(projectId)));
  server.registerTool("sync_pull", {
    description: "Authenticate and replay remote events into the configured project, preserving concurrent conflicts.", outputSchema,
    inputSchema: { projectId: z.string().min(1) }, annotations: { openWorldHint: true, idempotentHint: true },
  }, ({ projectId }) => withApp(app => app.syncPull(projectId)));
  server.registerTool("sync_conflicts", {
    description: "List unresolved local sync conflicts with all competing event versions.", outputSchema,
    inputSchema: { projectId: z.string().min(1) }, annotations: { readOnlyHint: true, idempotentHint: true },
  }, ({ projectId }) => withApp(app => app.syncConflicts(projectId)));
  server.registerTool("sync_resolve", {
    description: "Resolve a sync conflict by explicitly choosing an event; records a new event descending from all current versions.", outputSchema,
    inputSchema: { projectId: z.string().min(1), table: z.enum(SYNC_TABLES), entity: z.string().min(1), chosenEventId: z.string().min(1) },
    annotations: { readOnlyHint: false, idempotentHint: false },
  }, ({ projectId, table, entity, chosenEventId }) => withApp(app => app.resolveSyncConflict(projectId, table, entity, chosenEventId)));
  server.registerTool("project_backup_remote", {
    description: "Encrypt and upload a knowledge snapshot to an explicitly configured S3 target. Code indexes excluded; selected user rules only.",
    outputSchema, inputSchema: { projectId: z.string().min(1), remoteName: z.string().min(1),
      userMemoryIds: z.array(z.string().min(1)).max(1000).optional(), includeSourceExcerpts: z.boolean().default(false) },
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
  }, ({ projectId, remoteName, userMemoryIds, includeSourceExcerpts }) => withApp(app => app.backupRemote(projectId, remoteName, {
    includeSourceExcerpts, ...(userMemoryIds ? { userMemoryIds } : {}),
  })));
  server.registerTool("project_restore_remote", {
    description: "Download, authenticate and stage a remote knowledge snapshot in a new allowed directory. Does not replace registered projects or apply personal rules.",
    outputSchema, inputSchema: { remoteName: z.string().min(1), key: z.string().min(1), directory: z.string().min(1) },
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
  }, ({ remoteName, key, directory }) => withApp(app => app.restoreRemote(remoteName, key, directory)));
  registerPrompts(server);
  server.server.onclose = stopAllProjectWatches;
  return server;
}

function registerResources(server: McpServer): void {
  server.registerResource(
    "project-registry",
    "project-context://projects",
    { title: "Project Context projects", description: "Registered local projects", mimeType: "application/json" },
    (uri) => resourceValue(uri, (app) => app.projects.list()),
  );
  server.registerResource(
    "project-health",
    new ResourceTemplate("project-context://projects/{projectId}/health", { list: undefined }),
    { title: "Project health", description: "Project index and memory health", mimeType: "application/json" },
    (uri, variables) => resourceValue(uri, (app) => app.healthOverview(variable(variables, "projectId"))),
  );
  server.registerResource(
    "project-memory",
    new ResourceTemplate("project-context://projects/{projectId}/memories/{memoryId}", { list: undefined }),
    { title: "Project memory", description: "A sourced long-term project memory", mimeType: "application/json" },
    (uri, variables) => resourceValue(uri, (app) => app.memory(
      variable(variables, "projectId"), variable(variables, "memoryId"),
    )),
  );
  server.registerResource(
    "project-task",
    new ResourceTemplate("project-context://projects/{projectId}/tasks/{taskId}", { list: undefined }),
    { title: "Project task", description: "A cross-session task and checkpoint", mimeType: "application/json" },
    (uri, variables) => resourceValue(uri, (app) => app.task(
      variable(variables, "projectId"), variable(variables, "taskId"),
    )),
  );
  server.registerResource(
    "project-source",
    new ResourceTemplate("project-context://projects/{projectId}/sources/{sourceId}", { list: undefined }),
    { title: "Indexed project source", description: "Indexed source metadata and chunks", mimeType: "application/json" },
    (uri, variables) => resourceValue(uri, (app) => app.source(
      variable(variables, "projectId"), variable(variables, "sourceId"),
    )),
  );
}

function registerPrompts(server: McpServer): void {
  server.registerPrompt("resume-project-task", {
    title: "Resume a project task",
    description: "Load task-focused project context and active checkpoints.",
    argsSchema: { projectId: z.string().min(1), task: z.string().min(1) },
  }, async ({ projectId, task }) => ({
    description: `Resume work on ${task}`,
    messages: [{ role: "user", content: { type: "text", text: JSON.stringify(
      await withAppValue((app) => app.context(projectId, task, DEFAULT_CONTEXT_BUDGET_TOKENS)), null, 2,
    ) } }],
  }));
  server.registerPrompt("review-memory-candidates", {
    title: "Review memory candidates",
    description: "Load pending sourced candidates for explicit acceptance or rejection.",
    argsSchema: { projectId: z.string().min(1) },
  }, async ({ projectId }) => ({
    messages: [{ role: "user", content: { type: "text", text: JSON.stringify(
      await withAppValue((app) => app.candidates(projectId)), null, 2,
    ) } }],
  }));
}

async function withApp(callback: (app: ProjectContextApp) => unknown | Promise<unknown>) {
  let app: ProjectContextApp | undefined;
  try {
    app = await ProjectContextApp.create();
    return response(await callback(app));
  } catch (error) {
    return errorResponse(error);
  } finally {
    app?.close();
  }
}

function response(value: unknown) {
  const serialized = JSON.stringify(value, null, 2) ?? String(value);
  const text = serialized.length <= MAX_TEXT_CONTENT_CHARS
    ? serialized
    : JSON.stringify({
      notice: "Large result omitted from text content to avoid duplicating structured data in the client context.",
      structuredContentAvailable: true,
      sizeChars: serialized.length,
      fields: isRecord(value) ? Object.keys(value) : [],
    }, null, 2);
  return {
    structuredContent: { result: value },
    content: [{ type: "text" as const, text }],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function withAppValue<T>(callback: (app: ProjectContextApp) => T | Promise<T>): Promise<T> {
  const app = await ProjectContextApp.create();
  try {
    return await callback(app);
  } finally {
    app.close();
  }
}

async function resourceValue(
  uri: URL,
  callback: (app: ProjectContextApp) => unknown | Promise<unknown>,
) {
  const value = await withAppValue(callback);
  return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value, null, 2) }] };
}

function variable(variables: Record<string, string | string[]>, name: string): string {
  const value = variables[name];
  if (typeof value !== "string" || !value) throw new ProjectContextError("INVALID_RESOURCE_URI", `Missing ${name}.`);
  return value;
}

function errorResponse(error: unknown) {
  const body = error instanceof ProjectContextError
    ? { code: error.code, message: error.message, details: error.details ?? null }
    : { code: "INTERNAL_ERROR", message: errorMessage(error), details: null };
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
}

async function main(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
  console.error("Project Context MCP server running on stdio");
  void reportStoppedServers();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
