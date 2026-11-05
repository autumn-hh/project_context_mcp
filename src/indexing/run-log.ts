import type { SqliteDatabase } from "../storage/database.js";
import { nowIso } from "../shared/ids.js";
import { containsLikelySecret } from "./file-policy.js";

export interface RunLogEntry {
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
  path?: string;
}

export interface RunLog {
  entries: RunLogEntry[];
  totalEvents: number;
  truncated: boolean;
}

const BRIEF_RUN_ERRORS = 3;

/** An index_runs row for responses that must stay small: no process log, and only the first few errors. */
export function briefIndexRun(run: Record<string, unknown> | null) {
  if (!run) return null;
  const { log_json: _log, errors_json: stored, ...rest } = run;
  let errors: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(String(stored ?? "[]"));
    if (Array.isArray(parsed)) errors = parsed;
  } catch { /* an unreadable list counts as no errors */ }
  const first = errors.slice(0, BRIEF_RUN_ERRORS).map((error) => {
    const text = JSON.stringify(error);
    return text.length > 600 ? `${text.slice(0, 600)}…` : error;
  });
  return { ...rest, errors_json: JSON.stringify(first), errorCount: errors.length };
}

// Retain a bounded beginning plus the final outcome, without source contents or terminal output.
export function createRunLogger(db: SqliteDatabase, runId: string) {
  const log: RunLog = { entries: [], totalEvents: 0, truncated: false };
  let bytes = 0;
  const update = db.prepare("UPDATE index_runs SET log_json = ? WHERE id = ?");
  const flush = () => update.run(JSON.stringify(log), runId);
  const record = (message: string, path?: string, level: RunLogEntry["level"] = "info", final = false) => {
    const safePath = path === undefined ? undefined : containsLikelySecret(path) ? "[Sensitive path hidden]" : path.slice(0, 200);
    const entry: RunLogEntry = { timestamp: nowIso(), level, message: message.slice(0, 300), ...(safePath !== undefined ? { path: safePath } : {}) };
    const size = Buffer.byteLength(JSON.stringify(entry), "utf8");
    log.totalEvents++;
    const retained = final || (log.entries.length < 99 && bytes + size <= 30_000);
    if (retained) {
      log.entries.push(entry);
      bytes += size;
    } else log.truncated = true;
    if (path && path.length > 200) log.truncated = true;
    // Once the bounded log is full, periodic rewrites would only change the event counter.
    if (final || log.totalEvents === 1 || (retained && log.totalEvents % 25 === 0)) flush();
  };
  return { record, flush };
}
