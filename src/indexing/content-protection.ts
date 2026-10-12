import type { SqliteDatabase } from "../storage/database.js";
import { containsLikelySecret } from "./file-policy.js";

const REPORT_KEY = "index_content_protection";

export interface ContentProtectionReport {
  runId: string;
  completed: boolean;
  checkedAt: string;
  skipped: Array<{ path: string; reason: string }>;
  redacted: Array<{ path: string; lines: number[] }>;
}

export function safeReportPath(path: string): string {
  return containsLikelySecret(path) ? "[Sensitive path hidden]" : path;
}

export function saveContentProtection(db: SqliteDatabase, report: ContentProtectionReport): void {
  db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)")
    .run(REPORT_KEY, JSON.stringify(report));
}

/** Null means this database has not yet been indexed with line redaction enabled. */
export function readContentProtection(db: SqliteDatabase): ContentProtectionReport | null {
  const value = db.prepare("SELECT value FROM metadata WHERE key = ?").pluck().get(REPORT_KEY) as string | undefined;
  return value ? JSON.parse(value) as ContentProtectionReport : null;
}
