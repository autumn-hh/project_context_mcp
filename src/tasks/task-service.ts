import type { SqliteDatabase } from "../storage/database.js";
import { createId, nowIso } from "../shared/ids.js";
import { ProjectContextError } from "../shared/errors.js";
import { createHash } from "node:crypto";
import { taskWorkflowSchema, type TaskWorkflow } from './task-workflow.js';
import { summarizeVerification } from './task-verification.js';

export interface TaskCheckpoint extends TaskWorkflow {
  summary?: string;
  completed: string[];
  next: string[];
  changedFiles: string[];
  verification: Array<{ command: string; status: string; summary?: string }>;
  blockers: string[];
  risks: string[];
}

/** Omitted fields preserve current state; an explicit empty array clears it. */
export type TaskCheckpointPatch = { [K in keyof TaskCheckpoint]?: TaskCheckpoint[K] | undefined };

export interface TaskRecord {
  id: string;
  goal: string;
  status: "in_progress" | "completed" | "cancelled";
  checkpoint: TaskCheckpoint;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export type TaskEventKind = "created" | "checkpoint" | "completed" | "cancelled" | "migration_snapshot";

export interface TaskEvent {
  sequence: number;
  taskId: string;
  kind: TaskEventKind;
  recordedAt: string;
  source: string;
  snapshot: TaskRecord;
}

export interface TaskHistoryPage {
  items: TaskEvent[];
  total: number;
  limit: number;
  offset: number;
}

export interface TaskCheckpointOptions {
  requestId?: string;
  source?: string;
  expectedUpdatedAt?: string;
  expectedRevision?: number;
}

interface TaskRow {
  id: string; goal: string; status: TaskRecord["status"]; checkpoint_json: string;
  created_at: string; updated_at: string; completed_at: string | null;
}

const emptyCheckpoint = (): TaskCheckpoint => ({
  completed: [], next: [], changedFiles: [], verification: [], blockers: [], risks: [],
});

export function startTask(db: SqliteDatabase, goal: string, options: { source?: string } & TaskWorkflow = {}): TaskRecord {
  const source = validateIdentifier(options.source ?? "local", "source", 80);
  const timestamp = nowIso();
  const task: TaskRecord = {
    id: createId("task"), goal: goal.trim(), status: "in_progress", checkpoint: emptyCheckpoint(),
    createdAt: timestamp, updatedAt: timestamp, completedAt: null,
  };
  if (!task.goal) throw new ProjectContextError("INVALID_TASK", "Task goal is required.");
  task.checkpoint = { ...task.checkpoint, stage: 'executing', ...workflow(options) };
  validateWorkflow(task.checkpoint);
  return db.transaction(() => {
    db.prepare(`
      INSERT INTO tasks (id, goal, status, checkpoint_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(task.id, task.goal, task.status, JSON.stringify(task.checkpoint), task.createdAt, task.updatedAt);
    appendEvent(db, task, "created", source);
    return task;
  }).immediate();
}

export function checkpointTask(
  db: SqliteDatabase, taskId: string, checkpoint: TaskCheckpointPatch, options: TaskCheckpointOptions = {},
): TaskRecord {
  const source = validateIdentifier(options.source ?? "local", "source", 80);
  const requestId = options.requestId === undefined ? undefined : validateIdentifier(options.requestId, "requestId", 128);
  if (requestId?.startsWith('reopen:')) throw new ProjectContextError('INVALID_TASK_OPTIONS', 'The reopen: request namespace is reserved.');
  const payload = canonicalJson(checkpoint);
  const payloadHash = createHash("sha256").update(payload).digest("hex");
  return db.transaction(() => {
    const current = getTask(db, taskId);
    if (requestId !== undefined) {
      const receipt = db.prepare("SELECT payload_hash FROM task_checkpoint_requests WHERE task_id = ? AND request_id = ?")
        .get(taskId, requestId) as { payload_hash: string } | undefined;
      if (receipt) {
        if (receipt.payload_hash !== payloadHash) {
          throw new ProjectContextError("TASK_REQUEST_CONFLICT", "This checkpoint request ID was already used with different content.");
        }
        // Return current state: retrying an old request must never revert newer work.
        return current;
      }
      db.prepare("INSERT INTO task_checkpoint_requests (task_id, request_id, payload_hash) VALUES (?, ?, ?)")
        .run(taskId, requestId, payloadHash);
    }
    if (options.expectedUpdatedAt !== undefined && current.updatedAt !== options.expectedUpdatedAt) {
      throw new ProjectContextError('TASK_UPDATE_CONFLICT', '任务已更新，请刷新后再保存。');
    }
    if (options.expectedRevision !== undefined && options.expectedRevision !== db.prepare('SELECT COALESCE(MAX(sequence),0) FROM task_events WHERE task_id=?').pluck().get(taskId)) {
      throw new ProjectContextError('TASK_UPDATE_CONFLICT', '任务已更新，请刷新后再保存。');
    }
    const merged = mergeCheckpoint(current.checkpoint, checkpoint);
    validateWorkflow(merged);
    if (current.status !== 'in_progress' && (canonicalJson(merged.next) !== canonicalJson(current.checkpoint.next)
      || canonicalJson(merged.blockers) !== canonicalJson(current.checkpoint.blockers)
      || canonicalJson(merged.acceptance ?? []) !== canonicalJson(current.checkpoint.acceptance ?? [])
      || canonicalJson(merged.verification) !== canonicalJson(current.checkpoint.verification)
      || merged.stage !== current.checkpoint.stage)) {
      throw new ProjectContextError('TASK_REOPEN_REQUIRED', 'Closed tasks only accept explanatory notes. Reopen before adding required work or verification.');
    }
    const storedPayload = canonicalJson(merged);
    if (canonicalJson(current.checkpoint) === storedPayload) return current;
    db.prepare("UPDATE tasks SET checkpoint_json = ?, updated_at = ? WHERE id = ?")
      .run(storedPayload, nowIso(), taskId);
    const task = getTask(db, taskId);
    appendEvent(db, task, "checkpoint", source);
    return task;
  }).immediate();
}

export function completeTask(
  db: SqliteDatabase, taskId: string, checkpoint?: TaskCheckpointPatch, options: Pick<TaskCheckpointOptions, 'source' | 'expectedRevision'> = {},
): TaskRecord {
  const source = validateIdentifier(options.source ?? "local", "source", 80);
  return db.transaction(() => {
    const current = getTask(db, taskId);
    if (current.status === "completed") return current;
    checkRevision(db, taskId, options.expectedRevision);
    if (current.status !== "in_progress") {
      throw new ProjectContextError("TASK_TRANSITION_BLOCKED", `Only an in-progress task can be completed: ${taskId}`);
    }
    const finalCheckpoint = checkpoint ? mergeCheckpoint(current.checkpoint, checkpoint) : current.checkpoint;
    const issues = completionIssues(finalCheckpoint);
    if (issues.length) throw new ProjectContextError('TASK_ACCEPTANCE_REQUIRED', issues.join(' '));
    const timestamp = nowIso();
    if (checkpoint) {
      db.prepare(`
        UPDATE tasks SET status = 'completed', checkpoint_json = ?, updated_at = ?, completed_at = ? WHERE id = ?
      `).run(JSON.stringify(finalCheckpoint), timestamp, timestamp, taskId);
    } else {
      db.prepare("UPDATE tasks SET status = 'completed', updated_at = ?, completed_at = ? WHERE id = ?")
        .run(timestamp, timestamp, taskId);
    }
    const task = getTask(db, taskId);
    appendEvent(db, task, "completed", source);
    return task;
  }).immediate();
}

export function completionIssues(checkpoint: TaskCheckpoint): string[] {
  validateWorkflow(checkpoint);
  const issues: string[] = [];
  if (!checkpoint.summary?.trim() && !checkpoint.completed.some(item => item.trim())) issues.push('请先记录最终结论。');
  if (checkpoint.next.length || checkpoint.blockers.length) issues.push('仍有必要下一步或阻塞，请保留未完成并更新进展。');
  if (['backlog','waiting','paused','untriaged'].includes(checkpoint.stage ?? '')) issues.push('请先核对工作阶段，完成验收后再关闭。');
  if (!checkpoint.acceptance?.length) issues.push('请记录完成条件和对应验收证据。');
  if (checkpoint.acceptance?.some(item => item.status !== 'passed' || !item.evidence?.trim())) issues.push('每项完成条件均需通过并提供具体证据。');
  // Entries are ordered attempts. A later pass of the same command supersedes
  // its earlier failure; a different successful command does not erase it.
  if (summarizeVerification(checkpoint.verification).unresolved) {
    issues.push('仍有未通过或未执行的验证，请记录同一验证的最新通过结果，或明确修订必要验证范围。');
  }
  return issues;
}

export function reopenTask(db: SqliteDatabase, taskId: string, reason: string, options: TaskCheckpointOptions = {}): TaskRecord {
  const source = validateIdentifier(`${options.source ?? 'local'}:reopen`, 'source', 80);
  if (!reason.trim() || reason.length > 2000) throw new ProjectContextError('INVALID_TASK', 'A reopening reason (1–2000 characters) is required.');
  const requestId = options.requestId === undefined ? undefined
    : 'reopen:' + createHash('sha256').update(validateIdentifier(options.requestId, 'requestId', 128)).digest('hex');
  if (requestId === undefined || options.expectedRevision === undefined
    || (options.expectedRevision !== undefined && (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0))) {
    throw new ProjectContextError('INVALID_TASK_OPTIONS', 'Reopening retries require both requestId and expectedRevision.');
  }
  const payloadHash = createHash('sha256').update(canonicalJson({reason:reason.trim(), expectedRevision:options.expectedRevision})).digest('hex');
  return db.transaction(() => {
    const current = getTask(db, taskId);
    if (requestId !== undefined) {
      const receipt = db.prepare('SELECT payload_hash FROM task_checkpoint_requests WHERE task_id=? AND request_id=?').get(taskId, requestId) as {payload_hash:string} | undefined;
      if (receipt) {
        if (receipt.payload_hash !== payloadHash) throw new ProjectContextError('TASK_REQUEST_CONFLICT', 'Reopen request ID was already used with different content.');
        return current;
      }
      if (options.expectedRevision !== db.prepare('SELECT COALESCE(MAX(sequence),0) FROM task_events WHERE task_id=?').pluck().get(taskId)) {
        throw new ProjectContextError('TASK_UPDATE_CONFLICT', '任务已更新，请刷新后再重新打开。');
      }
      db.prepare('INSERT INTO task_checkpoint_requests (task_id,request_id,payload_hash) VALUES (?,?,?)').run(taskId,requestId,payloadHash);
    }
    if (current.status === 'in_progress') return current;
    const checkpoint: TaskCheckpoint = { ...current.checkpoint, stage: 'acceptance',
      next: [reason.trim()], acceptance: [...(current.checkpoint.acceptance ?? []), { criterion: reason.trim(), status: 'pending' }] };
    validateWorkflow(checkpoint);
    db.prepare("UPDATE tasks SET status='in_progress', completed_at=NULL, checkpoint_json=?, updated_at=? WHERE id=?")
      .run(JSON.stringify(checkpoint), nowIso(), taskId);
    const task = getTask(db, taskId);
    // Compatible event kind, explicit source; original completion remains immutable.
    appendEvent(db, task, 'checkpoint', source);
    return task;
  }).immediate();
}

function mergeCheckpoint(current: TaskCheckpoint, patch: TaskCheckpointPatch): TaskCheckpoint {
  return { ...current, ...Object.fromEntries(Object.entries(patch).filter(([,value]) => value !== undefined)) };
}

function workflow(value: TaskWorkflow): TaskWorkflow {
  return taskWorkflowSchema.parse(Object.fromEntries(['stage','acceptance','waitingReason']
    .filter(key => value[key as keyof TaskWorkflow] !== undefined).map(key => [key,value[key as keyof TaskWorkflow]])));
}

function validateWorkflow(checkpoint: TaskCheckpoint): void {
  workflow(checkpoint);
  if (['waiting','paused'].includes(checkpoint.stage ?? '') && !checkpoint.waitingReason?.trim()) {
    throw new ProjectContextError('INVALID_TASK_STAGE', 'Waiting or paused tasks require a reason; pause only on explicit user instruction.');
  }
}

export function cancelTask(db: SqliteDatabase, taskId: string, options: Pick<TaskCheckpointOptions, 'source' | 'expectedRevision'> = {}): TaskRecord {
  const source = validateIdentifier(options.source ?? "local", "source", 80);
  return db.transaction(() => {
    const current = getTask(db, taskId);
    if (current.status === "cancelled") return current;
    checkRevision(db, taskId, options.expectedRevision);
    if (current.status !== "in_progress") {
      throw new ProjectContextError("TASK_TRANSITION_BLOCKED", `Only an in-progress task can be cancelled: ${taskId}`);
    }
    const timestamp = nowIso();
    db.prepare("UPDATE tasks SET status = 'cancelled', updated_at = ?, completed_at = ? WHERE id = ?")
      .run(timestamp, timestamp, taskId);
    const task = getTask(db, taskId);
    appendEvent(db, task, "cancelled", source);
    return task;
  }).immediate();
}

export function listTasks(db: SqliteDatabase, status = "in_progress", limit = 20): TaskRecord[] {
  return (db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY updated_at DESC LIMIT ?")
    .all(status, limit) as TaskRow[]).map(mapTask);
}

export function getTask(db: SqliteDatabase, taskId: string): TaskRecord {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
  if (!row) throw new ProjectContextError("TASK_NOT_FOUND", `Unknown task: ${taskId}`);
  return mapTask(row);
}

function checkRevision(db: SqliteDatabase, taskId: string, revision?: number): void {
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0
    || revision !== db.prepare('SELECT COALESCE(MAX(sequence),0) FROM task_events WHERE task_id=?').pluck().get(taskId))) {
    throw new ProjectContextError('TASK_UPDATE_CONFLICT', '任务已更新，请刷新并核对最新内容后再操作。');
  }
}

export function taskDetail(db: SqliteDatabase, taskId: string): TaskRecord & {revision:number} {
  return db.transaction(() => ({...getTask(db,taskId),
    revision:Number(db.prepare('SELECT COALESCE(MAX(sequence),0) FROM task_events WHERE task_id=?').pluck().get(taskId))}))();
}

export function listTaskHistory(
  db: SqliteDatabase, taskId: string, options: { limit?: number; offset?: number } = {},
): TaskHistoryPage {
  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) {
    throw new ProjectContextError("INVALID_TASK_PAGINATION", "History limit must be 1–100 and offset must be an integer between 0 and 100000.");
  }
  return db.transaction(() => {
    getTask(db, taskId);
    const { total } = db.prepare("SELECT COUNT(*) AS total FROM task_events WHERE task_id = ?")
      .get(taskId) as { total: number };
    const rows = db.prepare(`SELECT sequence, task_id, kind, recorded_at, source, snapshot_json
      FROM task_events WHERE task_id = ? ORDER BY sequence DESC LIMIT ? OFFSET ?`)
      .all(taskId, limit, offset) as Array<{
        sequence: number; task_id: string; kind: TaskEventKind; recorded_at: string; source: string; snapshot_json: string;
      }>;
    return {
      items: rows.map(row => ({ sequence: row.sequence, taskId: row.task_id, kind: row.kind,
        recordedAt: row.recorded_at, source: row.source, snapshot: JSON.parse(row.snapshot_json) as TaskRecord })),
      total, limit, offset,
    };
  })();
}

function appendEvent(db: SqliteDatabase, task: TaskRecord, kind: TaskEventKind, source: string): void {
  db.prepare("INSERT INTO task_events (task_id, kind, recorded_at, source, snapshot_json) VALUES (?, ?, ?, ?, ?)")
    .run(task.id, kind, nowIso(), source, JSON.stringify(task));
}

function validateIdentifier(value: string, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !/^[a-zA-Z0-9_.:/-]+$/.test(value)) {
    throw new ProjectContextError("INVALID_TASK_OPTIONS", `${name} must be a 1–${maximum} character identifier using letters, digits, _, ., :, / or -.`);
  }
  return value;
}

// Object-key order is irrelevant; array order and all serialized values remain meaningful.
function canonicalJson(value: unknown): string {
  function sort(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, child]) => [key, sort(child)]));
    }
    return item;
  }
  return JSON.stringify(sort(JSON.parse(JSON.stringify(value))));
}

function mapTask(row: TaskRow): TaskRecord {
  return {
    id: row.id, goal: row.goal, status: row.status,
    checkpoint: JSON.parse(row.checkpoint_json) as TaskCheckpoint,
    createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at,
  };
}
