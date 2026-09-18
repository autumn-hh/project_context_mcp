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
    if (final || (log.entries.length < 99 && bytes + size <= 30_000)) {
      log.entries.push(entry);
      bytes += size;
    } else log.truncated = true;
    if (path && path.length > 200) log.truncated = true;
    if (final || log.totalEvents === 1 || log.totalEvents % 25 === 0) flush();
  };
  return { record, flush };
}
