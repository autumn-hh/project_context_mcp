import type { SqliteDatabase } from "../storage/database.js";
import { createId, nowIso } from "../shared/ids.js";
import { ProjectContextError } from "../shared/errors.js";
import { createHash } from "node:crypto";

export interface TaskCheckpoint {
  summary?: string;
  completed: string[];
  next: string[];
  changedFiles: string[];
  verification: Array<{ command: string; status: string; summary?: string }>;
  blockers: string[];
  risks: string[];
}

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
}

interface TaskRow {
  id: string; goal: string; status: TaskRecord["status"]; checkpoint_json: string;
  created_at: string; updated_at: string; completed_at: string | null;
}

const emptyCheckpoint = (): TaskCheckpoint => ({
  completed: [], next: [], changedFiles: [], verification: [], blockers: [], risks: [],
});

export function startTask(db: SqliteDatabase, goal: string, options: { source?: string } = {}): TaskRecord {
  const source = validateIdentifier(options.source ?? "local", "source", 80);
  const timestamp = nowIso();
  const task: TaskRecord = {
    id: createId("task"), goal: goal.trim(), status: "in_progress", checkpoint: emptyCheckpoint(),
    createdAt: timestamp, updatedAt: timestamp, completedAt: null,
  };
  if (!task.goal) throw new ProjectContextError("INVALID_TASK", "Task goal is required.");
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
  db: SqliteDatabase, taskId: string, checkpoint: TaskCheckpoint, options: TaskCheckpointOptions = {},
): TaskRecord {
  const source = validateIdentifier(options.source ?? "local", "source", 80);
  const requestId = options.requestId === undefined ? undefined : validateIdentifier(options.requestId, "requestId", 128);
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
    if (canonicalJson(current.checkpoint) === payload) return current;
    db.prepare("UPDATE tasks SET checkpoint_json = ?, updated_at = ? WHERE id = ?")
      .run(payload, nowIso(), taskId);
    const task = getTask(db, taskId);
    appendEvent(db, task, "checkpoint", source);
    return task;
  }).immediate();
}

export function completeTask(
  db: SqliteDatabase, taskId: string, checkpoint?: TaskCheckpoint, options: { source?: string } = {},
): TaskRecord {
  const source = validateIdentifier(options.source ?? "local", "source", 80);
  return db.transaction(() => {
    const current = getTask(db, taskId);
    if (current.status === "completed") return current;
    if (current.status !== "in_progress") {
      throw new ProjectContextError("TASK_TRANSITION_BLOCKED", `Only an in-progress task can be completed: ${taskId}`);
    }
    const timestamp = nowIso();
    if (checkpoint) {
      db.prepare(`
        UPDATE tasks SET status = 'completed', checkpoint_json = ?, updated_at = ?, completed_at = ? WHERE id = ?
      `).run(JSON.stringify(checkpoint), timestamp, timestamp, taskId);
    } else {
      db.prepare("UPDATE tasks SET status = 'completed', updated_at = ?, completed_at = ? WHERE id = ?")
        .run(timestamp, timestamp, taskId);
    }
    const task = getTask(db, taskId);
    appendEvent(db, task, "completed", source);
    return task;
  }).immediate();
}

export function cancelTask(db: SqliteDatabase, taskId: string, options: { source?: string } = {}): TaskRecord {
  const source = validateIdentifier(options.source ?? "local", "source", 80);
  return db.transaction(() => {
    const current = getTask(db, taskId);
    if (current.status === "cancelled") return current;
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
