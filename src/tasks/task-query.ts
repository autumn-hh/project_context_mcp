import { z } from "zod";
import type { SqliteDatabase } from "../storage/database.js";
import type { ProjectRecord } from "../projects/project-service.js";
import { errorMessage, ProjectContextError } from "../shared/errors.js";
import type { TaskCheckpoint, TaskRecord } from "./task-service.js";

export const taskQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  status: z.enum(["all", "in_progress", "completed", "cancelled"]).default("all"),
  q: z.string().trim().max(200).default(""),
  sort: z.enum(["updated", "created", "completed"]).default("updated"),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).max(100000).default(0),
  includeArchived: z.boolean().default(false),
});
export type TaskQuery = z.output<typeof taskQuerySchema>;
export type TaskQueryInput = z.input<typeof taskQuerySchema>;
export interface TaskQueryPage { items: TaskRecord[]; total: number; limit: number; offset: number }
export type TaskSummary = Omit<TaskRecord, "checkpoint"> & { summary: string; hasBlockers: boolean; revision: number };
interface QueryPage<T> { items: T[]; total: number; limit: number; offset: number }
type ProjectFields = Pick<WorkspaceTask, "projectId" | "projectName" | "projectRoot" | "projectArchived">;
export type WorkspaceTaskSummary = TaskSummary & ProjectFields;
export type WorkspaceTaskSummaryPage = Omit<WorkspaceTaskPage, "items"> & { items: WorkspaceTaskSummary[] };
export type WorkspaceTask = TaskRecord & {
  projectId: string; projectName: string; projectRoot: string; projectArchived: boolean;
};
export interface WorkspaceTaskPage {
  items: WorkspaceTask[]; total: number; limit: number; offset: number; partial: boolean;
  warnings: Array<{ projectId: string; projectName: string; code: string; message: string }>;
}
interface TaskRow {
  id: string; goal: string; status: TaskRecord["status"]; checkpoint_json: string;
  created_at: string; updated_at: string; completed_at: string | null;
}

function queryParts(input: TaskQuery) {
  const where: string[] = [];
  const parameters: string[] = [];
  if (input.status !== "all") { where.push("status = ?"); parameters.push(input.status); }
  if (input.q) {
    const literal = `%${input.q.replace(/[\\%_]/g, "\\$&")}%`;
    where.push(`(goal LIKE ? ESCAPE '\\' OR
      (CASE WHEN json_valid(checkpoint_json) THEN json_extract(checkpoint_json, '$.summary') ELSE NULL END) LIKE ? ESCAPE '\\')`);
    parameters.push(literal, literal);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const column = { updated: "updated_at", created: "created_at", completed: "completed_at" }[input.sort];
  return { clause, column, parameters };
}

function readPage(db: SqliteDatabase, input: TaskQuery, limit: number, offset: number): TaskQueryPage {
  const { clause, column, parameters } = queryParts(input);
  return db.transaction(() => {
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM tasks ${clause}`).get(...parameters) as { total: number };
    const rows = db.prepare(`SELECT id, goal, status, checkpoint_json, created_at, updated_at, completed_at
      FROM tasks ${clause} ORDER BY ${column} DESC, id COLLATE BINARY ASC LIMIT ? OFFSET ?`)
      .all(...parameters, limit, offset) as TaskRow[];
    return { items: rows.map(row => ({ id: row.id, goal: row.goal, status: row.status,
      checkpoint: JSON.parse(row.checkpoint_json) as TaskCheckpoint,
      createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at,
    })), total, limit, offset };
  })();
}

function readSummaryPage(db: SqliteDatabase, input: TaskQuery, limit: number, offset: number): QueryPage<TaskSummary> {
  const { clause, column, parameters } = queryParts(input);
  return db.transaction(() => {
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM tasks ${clause}`).get(...parameters) as { total: number };
    // Page before extracting JSON: only returned tasks pay for summary/blocker extraction.
    // SQLite still parses each selected checkpoint, but full documents never cross into JS or the response.
    const rows = db.prepare(`WITH page AS MATERIALIZED (
      SELECT id
      FROM tasks ${clause} ORDER BY ${column} DESC, id COLLATE BINARY ASC LIMIT ? OFFSET ?
    ) SELECT id, goal, status, created_at, updated_at, completed_at,
      CASE WHEN json_valid(checkpoint_json) THEN substr(COALESCE(json_extract(checkpoint_json, '$.summary'), ''), 1, 500) ELSE '' END AS summary,
      CASE WHEN json_valid(checkpoint_json) THEN COALESCE(json_array_length(checkpoint_json, '$.blockers'), 0) > 0 ELSE 0 END AS has_blockers,
      COALESCE((SELECT MAX(sequence) FROM task_events WHERE task_id = page.id), 0) AS revision
      FROM page JOIN tasks USING (id) ORDER BY ${column} DESC, id COLLATE BINARY ASC`).all(...parameters, limit, offset) as Array<
        Omit<TaskRow, "checkpoint_json"> & { summary: string; has_blockers: number; revision: number }>;
    return { items: rows.map(row => ({ id: row.id, goal: row.goal, status: row.status,
      summary: row.summary, hasBlockers: Boolean(row.has_blockers), revision: row.revision,
      createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at,
    })), total, limit, offset };
  })();
}

export function queryTaskSummaries(db: SqliteDatabase, input: TaskQueryInput = {}): QueryPage<TaskSummary> {
  const parsed = taskQuerySchema.parse(input);
  return readSummaryPage(db, parsed, parsed.limit, parsed.offset);
}

export function queryTasks(db: SqliteDatabase, input: TaskQueryInput = {}): TaskQueryPage {
  const parsed = taskQuerySchema.parse(input);
  return readPage(db, parsed, parsed.limit, parsed.offset);
}

const binaryCompare = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

// Retain at most the requested prefix, rather than all tasks from all projects.
function mergePrefix<T>(left: T[], right: T[], maximum: number, compare: (a: T, b: T) => number): T[] {
  const result: T[] = [];
  let a = 0, b = 0;
  while (result.length < maximum && (a < left.length || b < right.length)) {
    if (b >= right.length || (a < left.length && compare(left[a]!, right[b]!) <= 0)) result.push(left[a++]!);
    else result.push(right[b++]!);
  }
  return result;
}

export function queryWorkspaceTasks(
  projects: ProjectRecord[], openDatabase: (projectId: string) => SqliteDatabase, input: TaskQueryInput = {},
): WorkspaceTaskPage {
  return queryWorkspace(projects, openDatabase, input, readPage);
}

export function queryWorkspaceTaskSummaries(
  projects: ProjectRecord[], openDatabase: (projectId: string) => SqliteDatabase, input: TaskQueryInput = {},
): WorkspaceTaskSummaryPage {
  return queryWorkspace(projects, openDatabase, input, readSummaryPage);
}

function queryWorkspace<T extends Omit<TaskRecord, "checkpoint">>(
  projects: ProjectRecord[], openDatabase: (projectId: string) => SqliteDatabase, input: TaskQueryInput,
  read: (db: SqliteDatabase, input: TaskQuery, limit: number, offset: number) => QueryPage<T>,
): Omit<WorkspaceTaskPage, "items"> & { items: Array<T & ProjectFields> } {
  const parsed = taskQuerySchema.parse(input);
  if (parsed.projectId && !projects.some(project => project.id === parsed.projectId)) {
    throw new ProjectContextError("PROJECT_NOT_FOUND", `Unknown project: ${parsed.projectId}`);
  }
  const selected = projects.filter(project => (!parsed.projectId || project.id === parsed.projectId)
    && (parsed.includeArchived || !project.archivedAt));
  const key = { updated: "updatedAt", created: "createdAt", completed: "completedAt" }[parsed.sort] as "updatedAt" | "createdAt" | "completedAt";
  const compare = (a: T & ProjectFields, b: T & ProjectFields): number => {
    const left = a[key], right = b[key];
    const byTime = left === right ? 0 : left === null ? 1 : right === null ? -1 : binaryCompare(right, left);
    return byTime || binaryCompare(a.projectId, b.projectId) || binaryCompare(a.id, b.id);
  };
  let retained: Array<T & ProjectFields> = [];
  let total = 0;
  const warnings: WorkspaceTaskPage["warnings"] = [];
  const maximum = parsed.offset + parsed.limit;
  const singleProject = selected.length === 1;
  for (const project of selected) {
    let db: SqliteDatabase | undefined;
    let page: QueryPage<T> | undefined;
    let failure: WorkspaceTaskPage["warnings"][number] | undefined;
    try {
      db = openDatabase(project.id);
      // A single project needs no global merge: do not load or parse earlier checkpoints.
      page = read(db, parsed, singleProject ? parsed.limit : maximum, singleProject ? parsed.offset : 0);
    } catch (error) {
      failure = { projectId: project.id, projectName: project.name,
        code: error instanceof Error && "code" in error ? String(error.code) : "PROJECT_TASK_QUERY_FAILED",
        message: errorMessage(error) };
    } finally {
      try { db?.close(); }
      catch (error) {
        const message = `Database close failed: ${errorMessage(error)}`;
        if (failure) failure.message += `; ${message}`;
        else failure = { projectId: project.id, projectName: project.name, code: "PROJECT_DATABASE_CLOSE_FAILED", message };
      }
    }
    // Publish only fully successful projects, once cleanup has also succeeded.
    if (failure) { warnings.push(failure); continue; }
    if (!page) continue;
    const items = page.items.map(task => ({ ...task, projectId: project.id, projectName: project.name,
      projectRoot: project.rootPath, projectArchived: Boolean(project.archivedAt) }));
    retained = singleProject ? items : mergePrefix(retained, items, maximum, compare);
    total += page.total;
  }
  return { items: singleProject ? retained : retained.slice(parsed.offset, maximum), total, limit: parsed.limit, offset: parsed.offset,
    partial: warnings.length > 0, warnings };
}
