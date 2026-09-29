import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import * as z from "zod/v4";
import { ProjectContextApp } from "../core/app.js";
import { ProjectContextError, errorMessage } from "../shared/errors.js";
import { memoryTypeSchema } from "../memory/memory-service.js";
import { userMemoryScopeSchema } from "../memory/user-memory-service.js";
import { UI_CSS, UI_HTML, UI_JS } from "./assets.js";
import { GRAPH_RELATION_TYPES } from "../code-intelligence/graph-service.js";
import { DEFAULT_WATCH_DEBOUNCE_MS } from "../indexing/watch-service.js";
import { MigrationJobs } from "./migration-jobs.js";

const MAX_BODY_BYTES = 64 * 1024;
const retentionDaysSchema = z.number().int().min(1).max(3650);
const cleanupInputSchema = z.object({
  dryRun: z.boolean().default(true),
  retentionDays: retentionDaysSchema.default(30),
  vacuum: z.boolean().default(true),
  confirmProjectId: z.string().min(1).optional(),
}).strict();
const maintenanceInputSchema = z.object({
  enabled: z.boolean(), retentionDays: retentionDaysSchema,
  intervalHours: z.number().int().min(1).max(8760).default(24),
}).strict();
const searchRankingInputSchema = z.object({
  businessChunk: z.number().min(0).max(2), businessSymbol: z.number().min(0).max(2),
  memory: z.number().min(0).max(2), lowRelevanceChunk: z.number().min(0).max(2),
  lowRelevanceSymbol: z.number().min(0).max(2),
}).strict();
const SESSION_COOKIE = "project_context_ui";
const require = createRequire(import.meta.url);
const CYTOSCAPE_PATH = require.resolve("cytoscape/dist/cytoscape.min.js");
let cytoscapeSource: Promise<string> | undefined;
const ruleInputSchema = z.object({
  type: memoryTypeSchema,
  title: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(8_000),
  reason: z.string().trim().max(3_000).optional(),
  scopeLevel: userMemoryScopeSchema,
  projectId: z.string().trim().min(1).optional(),
  scopeRef: z.string().trim().min(1).max(500).optional(),
}).strict();
const contextInputSchema = z.object({
  projectId: z.string().trim().min(1),
  task: z.string().trim().min(1).max(4_000),
  budgetTokens: z.number().int().min(500).max(100_000),
}).strict();
const graphRelationSchema = z.enum(GRAPH_RELATION_TYPES);
const graphNodeIdSchema = z.string().trim().min(1).max(800);
const projectIgnoreInputSchema = z.object({
  content: z.string().max(60_000).refine((value) => !value.includes("\0"), "Ignore rules cannot contain NUL bytes."),
}).strict();
const projectUpdateInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  rootPath: z.string().trim().min(1).max(2_000).refine((value) => !value.includes("\0"), "Project root cannot contain NUL bytes."),
}).strict();

export interface UiServerHandle {
  url: string;
  launchUrl: string;
  port: number;
  close: () => Promise<void>;
}

export async function startUiServer(options: {
  port?: number;
  openBrowser?: boolean;
} = {}): Promise<UiServerHandle> {
  const sessionToken = randomBytes(32).toString("base64url");
  const migrationJobs = new MigrationJobs();
  let expectedOrigin = "";
  const server = createServer((request, response) => {
    void routeRequest(request, response, sessionToken, expectedOrigin, migrationJobs);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new ProjectContextError("UI_START_FAILED", "Unable to determine the local UI port.");
  }
  expectedOrigin = `http://127.0.0.1:${address.port}`;
  const launchUrl = `${expectedOrigin}/#token=${encodeURIComponent(sessionToken)}`;
  if (options.openBrowser !== false) openBrowser(launchUrl);
  return {
    url: expectedOrigin,
    launchUrl,
    port: address.port,
    close: async () => { await migrationJobs.wait(); return new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }); },
  };
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  sessionToken: string,
  expectedOrigin: string,
  migrationJobs: MigrationJobs,
): Promise<void> {
  setSecurityHeaders(response);
  try {
    if (!validHost(request, expectedOrigin)) {
      sendJson(response, 403, { code: "INVALID_HOST", message: "Request host is not authorized." });
      return;
    }
    const url = new URL(request.url ?? "/", expectedOrigin);
    if (request.method === "GET" && url.pathname === "/") return sendAsset(response, "text/html; charset=utf-8", UI_HTML);
    if (request.method === "GET" && url.pathname === "/styles.css") return sendAsset(response, "text/css; charset=utf-8", UI_CSS);
    if (request.method === "GET" && url.pathname === "/vendor/cytoscape.js") {
      cytoscapeSource ??= readFile(CYTOSCAPE_PATH, "utf8");
      return sendAsset(response, "text/javascript; charset=utf-8", await cytoscapeSource);
    }
    if (request.method === "GET" && url.pathname === "/app.js") return sendAsset(response, "text/javascript; charset=utf-8", UI_JS);
    if (request.method === "GET" && url.pathname === "/favicon.ico") { response.writeHead(204); response.end(); return; }

    if (!validApiOrigin(request, expectedOrigin)) {
      sendJson(response, 403, { code: "INVALID_ORIGIN", message: "Request origin is not authorized." });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/session") {
      const body = await readJsonBody(request);
      const token = typeof body.token === "string" ? body.token : "";
      if (!safeEqual(token, sessionToken)) {
        sendJson(response, 401, { code: "INVALID_SESSION", message: "The UI launch session is invalid or expired." });
        return;
      }
      response.setHeader("Set-Cookie", `${SESSION_COOKIE}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`);
      sendJson(response, 200, { established: true });
      return;
    }
    if (!authenticated(request, sessionToken)) {
      sendJson(response, 401, { code: "AUTHENTICATION_REQUIRED", message: "Open the UI using the current launch address." });
      return;
    }

    const jobsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/migration-jobs(?:\/([^/]+))?$/);
    if (jobsMatch && (request.method === "GET" || request.method === "POST")) {
      const projectId = decodeSegment(jobsMatch[1]!);
      const app = await ProjectContextApp.create();
      try {
        const project = app.projects.get(projectId);
        if (request.method === "GET") {
          const requestId = jobsMatch[2] ? z.uuid().parse(decodeSegment(jobsMatch[2])) : undefined;
          const job = migrationJobs.get(project.rootPath, requestId);
          return sendJson(response, requestId && !job ? 404 : 200, job ?? (requestId ? { code: "NOT_FOUND", message: "Migration request was not found." } : null));
        }
        if (jobsMatch[2]) throw new ProjectContextError("INVALID_INPUT", "Start migrations at the collection endpoint.");
        const input = z.object({ confirmProjectId: z.string(), kind: z.enum(["upgrade", "compact"]), requestId: z.uuid(), excludeDirectories: z.array(z.string().min(1).max(2000)).default([]) }).strict().parse(await readJsonBody(request));
        if (input.confirmProjectId !== projectId) throw new ProjectContextError("CLEANUP_CONFIRMATION_REQUIRED", "Confirm the selected project before migration.");
        if (!migrationJobs.get(project.rootPath, input.requestId)) app.assertProjectMigrationIdle(projectId);
        const prepared = migrationJobs.prepare(project.rootPath, { ...input, projectId });
        // Finish the short HTTP acknowledgement before any long work starts.
        response.once("finish", prepared.start);
        response.once("close", prepared.start);
        return sendJson(response, 202, prepared.job);
      } finally { app.close(); }
    }

    const mutationMatch = url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/(index|watch|cleanup|ignore|optimize-index|compact-index|maintenance))?$/);
    if (mutationMatch && !["GET", "HEAD"].includes(request.method ?? "")) {
      const app = await ProjectContextApp.create();
      try { migrationJobs.assertIdle(app.projects.get(decodeSegment(mutationMatch[1]!)).rootPath); }
      finally { app.close(); }
    }

    if (request.method === "GET" && url.pathname === "/api/bootstrap") {
      await withApp(response, async (app) => {
        await app.reconcileMovedProjects();
        return {
          projects: app.projects.list(true),
          memories: app.allUserMemories(),
        };
      });
      return;
    }
    const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (request.method === "PUT" && projectMatch) {
      const projectId = decodeSegment(projectMatch[1]!);
      const input = projectUpdateInputSchema.parse(await readJsonBody(request));
      await withApp(response, async (app) => {
        const current = app.projects.get(projectId);
        if (current.rootPath !== input.rootPath) await app.relocateProject(projectId, input.rootPath);
        return app.updateProject(projectId, input.name);
      });
      return;
    }
    const portraitMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/portrait$/);
    if (request.method === "GET" && portraitMatch) {
      const projectId = decodeURIComponent(portraitMatch[1]!);
      await withApp(response, (app) => app.portrait(projectId));
      return;
    }
    const indexLogsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/index-logs$/);
    if (request.method === "GET" && indexLogsMatch) {
      const projectId = decodeSegment(indexLogsMatch[1]!);
      const options = {
        limit: z.coerce.number().int().min(1).max(100).parse(url.searchParams.get("limit") ?? "20"),
        offset: z.coerce.number().int().min(0).max(1_000_000).parse(url.searchParams.get("offset") ?? "0"),
        status: z.enum(["all", "completed", "failed", "running"]).parse(url.searchParams.get("status") ?? "all"),
      };
      await withApp(response, (app) => app.indexLogs(projectId, options));
      return;
    }
    const storageMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/(storage|cleanup|maintenance)$/);
    if (storageMatch) {
      const projectId = decodeSegment(storageMatch[1]!);
      const action = storageMatch[2]!;
      if (request.method === "GET" && action === "storage") {
        await withApp(response, (app) => app.storageUsage(projectId));
        return;
      }
      if (request.method === "POST" && action === "cleanup") {
        const input = cleanupInputSchema.parse(await readJsonBody(request));
        if (!input.dryRun && input.confirmProjectId !== projectId) {
          throw new ProjectContextError("CLEANUP_CONFIRMATION_REQUIRED", "Confirm the selected project before executing cleanup.");
        }
        await withApp(response, (app) => app.cleanupProject(projectId, input));
        return;
      }
      if (request.method === "GET" && action === "maintenance") {
        await withApp(response, (app) => app.maintenanceSettings(projectId));
        return;
      }
      if (request.method === "PUT" && action === "maintenance") {
        const input = maintenanceInputSchema.parse(await readJsonBody(request));
        await withApp(response, (app) => app.setMaintenanceSettings(projectId, input));
        return;
      }
    }
    const rankingMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/search-ranking$/);
    if (rankingMatch) {
      const projectId = decodeSegment(rankingMatch[1]!);
      if (request.method === "GET") {
        await withApp(response, (app) => app.searchRanking(projectId));
        return;
      }
      if (request.method === "PUT") {
        const input = searchRankingInputSchema.parse(await readJsonBody(request));
        await withApp(response, (app) => app.setSearchRanking(projectId, input));
        return;
      }
    }
    const projectIgnoreMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/ignore$/);
    if (projectIgnoreMatch) {
      const projectId = decodeSegment(projectIgnoreMatch[1]!);
      if (request.method === "GET") {
        await withApp(response, (app) => app.readProjectIgnore(projectId));
        return;
      }
      if (request.method === "PUT") {
        const input = projectIgnoreInputSchema.parse(await readJsonBody(request));
        await withApp(response, (app) => app.writeProjectIgnore(projectId, input.content));
        return;
      }
    }
    const projectIgnorePreviewMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/ignore\/preview$/);
    if (request.method === "POST" && projectIgnorePreviewMatch) {
      const projectId = decodeSegment(projectIgnorePreviewMatch[1]!);
      const input = projectIgnoreInputSchema.parse(await readJsonBody(request));
      await withApp(response, (app) => app.previewProjectIgnore(projectId, input.content));
      return;
    }
    const projectActionMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/(index|watch)$/);
    if (projectActionMatch) {
      const projectId = decodeSegment(projectActionMatch[1]!);
      const action = projectActionMatch[2]!;
      if (request.method === "POST" && action === "index") {
        await withApp(response, (app) => app.index(projectId));
        return;
      }
      if (request.method === "POST" && action === "watch") {
        const input = z.object({ debounceMs: z.number().int().min(100).max(60_000).default(DEFAULT_WATCH_DEBOUNCE_MS) })
          .strict().parse(await readJsonBody(request));
        await withApp(response, (app) => app.watchStart(projectId, input.debounceMs, false));
        return;
      }
      if (request.method === "DELETE" && action === "watch") {
        await withApp(response, (app) => app.watchStop(projectId));
        return;
      }
    }
    const optimizeIndexMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/optimize-index$/);
    const migrationSpaceMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/migration-space$/);
    if (request.method === "GET" && migrationSpaceMatch) {
      const projectId = decodeSegment(migrationSpaceMatch[1]!);
      const mode = z.enum(["upgrade", "compact"]).parse(url.searchParams.get("mode") ?? "upgrade");
      await withApp(response, (app) => app.migrationSpaceCheck(projectId, mode));
      return;
    }
    const compactIndexMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/compact-index$/);
    if (request.method === "POST" && compactIndexMatch) {
      const projectId = decodeSegment(compactIndexMatch[1]!);
      const input = z.object({ confirmProjectId: z.string().min(1) }).strict().parse(await readJsonBody(request));
      if (input.confirmProjectId !== projectId) throw new ProjectContextError("CLEANUP_CONFIRMATION_REQUIRED", "Confirm the selected project before compaction.");
      await withApp(response, (app) => app.compactProjectIndex(projectId));
      return;
    }
    if (request.method === "GET" && optimizeIndexMatch) {
      const projectId = decodeSegment(optimizeIndexMatch[1]!);
      await withApp(response, (app) => app.indexMigrationPreview(projectId));
      return;
    }
    if (request.method === "POST" && optimizeIndexMatch) {
      const projectId = decodeSegment(optimizeIndexMatch[1]!);
      const input = z.object({ confirmProjectId: z.string().min(1), excludeDirectories: z.array(z.string().min(1).max(2000)).default([]) }).strict().parse(await readJsonBody(request));
      if (input.confirmProjectId !== projectId) throw new ProjectContextError("CLEANUP_CONFIRMATION_REQUIRED", "Confirm the selected project before migration.");
      await withApp(response, (app) => app.optimizeProjectIndex(projectId, input.excludeDirectories));
      return;
    }
    const projectMemoryMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/memories\/([^/]+)\/status$/);
    if (request.method === "PATCH" && projectMemoryMatch) {
      const projectId = decodeSegment(projectMemoryMatch[1]!);
      const memoryId = decodeSegment(projectMemoryMatch[2]!);
      const input = z.object({ status: z.literal("deleted") }).strict().parse(await readJsonBody(request));
      await withApp(response, (app) => {
        const current = app.memory(projectId, memoryId);
        if (current.status !== "stale" && current.status !== "conflicted") {
          throw new ProjectContextError("PROJECT_MEMORY_DELETE_BLOCKED", "Only stale or conflicted memories can be deleted here.");
        }
        return app.setMemoryStatus(projectId, memoryId, input.status);
      });
      return;
    }
    const candidateActionMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/candidates\/([^/]+)\/(accept|reject)$/);
    if (request.method === "POST" && candidateActionMatch) {
      const projectId = decodeSegment(candidateActionMatch[1]!);
      const candidateId = decodeSegment(candidateActionMatch[2]!);
      const action = candidateActionMatch[3]!;
      await withApp(response, (app) => action === "accept"
        ? app.acceptCandidate(projectId, candidateId)
        : app.rejectCandidate(projectId, candidateId));
      return;
    }
    const taskActionMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/(complete|cancel)$/);
    if (request.method === "POST" && taskActionMatch) {
      const projectId = decodeSegment(taskActionMatch[1]!);
      const taskId = decodeSegment(taskActionMatch[2]!);
      const action = taskActionMatch[3]!;
      await withApp(response, (app) => action === "complete"
        ? app.completeTask(projectId, taskId)
        : app.cancelTask(projectId, taskId));
      return;
    }
    const graphMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/graph$/);
    if (request.method === "GET" && graphMatch) {
      const projectId = decodeSegment(graphMatch[1]!);
      const input = graphOptions(url, 80, 120);
      await withApp(response, (app) => app.graphOverview(projectId, input));
      return;
    }
    const graphNeighborsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/graph\/neighbors$/);
    if (request.method === "GET" && graphNeighborsMatch) {
      const projectId = decodeSegment(graphNeighborsMatch[1]!);
      const nodeId = graphNodeIdSchema.parse(url.searchParams.get("node") ?? "");
      const input = {
        ...graphOptions(url, 100, 150),
        depth: z.coerce.number().int().min(1).max(2).parse(url.searchParams.get("depth") ?? "1"),
      };
      await withApp(response, (app) => app.graphNeighbors(projectId, nodeId, input));
      return;
    }
    const graphSearchMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/graph\/search$/);
    if (request.method === "GET" && graphSearchMatch) {
      const projectId = decodeSegment(graphSearchMatch[1]!);
      const query = z.string().trim().min(1).max(120).parse(url.searchParams.get("q") ?? "");
      const limit = z.coerce.number().int().min(1).max(30).parse(url.searchParams.get("limit") ?? "20");
      await withApp(response, (app) => app.graphSearch(projectId, query, limit));
      return;
    }
    const graphNodeMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/graph\/nodes\/([^/]+)$/);
    if (request.method === "GET" && graphNodeMatch) {
      const projectId = decodeSegment(graphNodeMatch[1]!);
      const nodeId = graphNodeIdSchema.parse(decodeSegment(graphNodeMatch[2]!));
      await withApp(response, (app) => app.graphNode(projectId, nodeId));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/memories") {
      const input = ruleInputSchema.parse(await readJsonBody(request));
      await withApp(response, (app) => app.rememberUser(ruleMemoryInput(input)));
      return;
    }
    const updateMatch = url.pathname.match(/^\/api\/memories\/([^/]+)$/);
    if (request.method === "PUT" && updateMatch) {
      const memoryId = decodeURIComponent(updateMatch[1]!);
      const input = ruleInputSchema.parse(await readJsonBody(request));
      await withApp(response, (app) => {
        const current = app.userMemory(memoryId);
        if (current.status !== "active") {
          throw new ProjectContextError("USER_MEMORY_NOT_ACTIVE", "Only active rules can be versioned. Reactivate it first.");
        }
        return app.rememberUser(ruleMemoryInput(input, memoryId));
      });
      return;
    }
    const statusMatch = url.pathname.match(/^\/api\/memories\/([^/]+)\/status$/);
    if (request.method === "PATCH" && statusMatch) {
      const memoryId = decodeURIComponent(statusMatch[1]!);
      const input = z.object({ status: z.enum(["active", "deleted"]) }).strict().parse(await readJsonBody(request));
      await withApp(response, (app) => {
        const current = app.userMemory(memoryId);
        if (input.status === "active" && current.status !== "deleted") {
          throw new ProjectContextError("USER_MEMORY_REACTIVATION_BLOCKED", "Only a deleted rule can be reactivated.");
        }
        if (input.status === "deleted" && current.status !== "active") {
          throw new ProjectContextError("USER_MEMORY_DELETE_BLOCKED", "Only an active rule can be deleted.");
        }
        return app.setUserMemoryStatus(memoryId, input.status);
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/context-preview") {
      const input = contextInputSchema.parse(await readJsonBody(request));
      await withApp(response, (app) => app.context(input.projectId, input.task, input.budgetTokens));
      return;
    }
    sendJson(response, 404, { code: "NOT_FOUND", message: "Unknown local UI endpoint." });
  } catch (error) {
    const status = error instanceof z.ZodError ? 400
      : error instanceof ProjectContextError ? projectErrorStatus(error.code)
      : 500;
    sendJson(response, status, errorBody(error));
  }
}

async function withApp(
  response: ServerResponse,
  callback: (app: ProjectContextApp) => unknown | Promise<unknown>,
): Promise<void> {
  const app = await ProjectContextApp.create();
  try {
    sendJson(response, 200, await callback(app));
  } finally {
    app.close();
  }
}

function validHost(request: IncomingMessage, expectedOrigin: string): boolean {
  return request.headers.host === new URL(expectedOrigin).host;
}

function validApiOrigin(request: IncomingMessage, expectedOrigin: string): boolean {
  const origin = request.headers.origin;
  const originAllowed = request.method === "GET" ? (!origin || origin === expectedOrigin) : origin === expectedOrigin;
  return originAllowed && request.headers["x-project-context-ui"] === "1";
}

function authenticated(request: IncomingMessage, sessionToken: string): boolean {
  const cookies = Object.fromEntries((request.headers.cookie ?? "").split(";").flatMap((part) => {
    const index = part.indexOf("=");
    return index < 0 ? [] : [[part.slice(0, index).trim(), part.slice(index + 1).trim()]];
  }));
  return safeEqual(cookies[SESSION_COOKIE] ?? "", sessionToken);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new ProjectContextError("REQUEST_TOO_LARGE", "Request body exceeds 64 KiB.");
    chunks.push(buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new ProjectContextError("INVALID_JSON", "Request body must be a JSON object.");
  }
}

function sendAsset(response: ServerResponse, contentType: string, content: string): void {
  response.setHeader("Content-Type", contentType);
  response.setHeader("Cache-Control", "no-store");
  response.writeHead(200);
  response.end(content);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.writeHead(status);
  response.end(JSON.stringify(value));
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function graphOptions(url: URL, defaultLimit: number, maximumLimit: number) {
  const relationTypes = url.searchParams.getAll("relation").map((value) => graphRelationSchema.parse(value));
  return {
    limit: z.coerce.number().int().min(10).max(maximumLimit).parse(url.searchParams.get("limit") ?? String(defaultLimit)),
    ...(relationTypes.length ? { relationTypes } : {}),
  };
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ProjectContextError("INVALID_INPUT", "URL path contains invalid encoding.");
  }
}

function projectErrorStatus(code: string): number {
  if (code.includes("NOT_FOUND")) return 404;
  if (code.includes("NOT_AUTHORIZED") || code.includes("NOT_ALLOWED")) return 403;
  if (code === "REQUEST_TOO_LARGE") return 413;
  return 400;
}

function errorBody(error: unknown): Record<string, unknown> {
  if (error instanceof z.ZodError) {
    return { code: "INVALID_INPUT", message: "Request fields are invalid.", details: error.issues };
  }
  if (error instanceof ProjectContextError) {
    return { code: error.code, message: error.message, details: error.details ?? null };
  }
  return { code: "INTERNAL_ERROR", message: errorMessage(error) };
}

function openBrowser(url: string): void {
  const command = process.platform === "win32" ? "rundll32"
    : process.platform === "darwin" ? "open"
    : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

function ruleMemoryInput(input: z.infer<typeof ruleInputSchema>, supersedesId?: string) {
  return {
    type: input.type,
    title: input.title,
    content: input.content,
    scopeLevel: input.scopeLevel,
    sourceKind: "user" as const,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
    ...(supersedesId ? { supersedesId } : {}),
  };
}
