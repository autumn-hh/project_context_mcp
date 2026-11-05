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

const BRIEF_ITEMS = 50;
// Images, archives and binaries swamp the list (7,175 of them on one project); list them last.
const ROUTINE_SKIPS = new Set(["unsupported-file", "binary-content"]);

/**
 * A bounded form for MCP and workbench responses, which the full list can exceed by far (883,000
 * characters on a large project). The stored report stays complete for the indexer and the CLI.
 */
export function briefContentProtection(report: ContentProtectionReport | null) {
  if (!report) return null;
  const skippedByReason: Record<string, number> = {};
  for (const { reason } of report.skipped) skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1;
  const skipped = [
    ...report.skipped.filter((item) => !ROUTINE_SKIPS.has(item.reason)),
    ...report.skipped.filter((item) => ROUTINE_SKIPS.has(item.reason)),
  ];
  return {
    ...report,
    skipped: skipped.slice(0, BRIEF_ITEMS), skippedTotal: skipped.length, skippedByReason,
    redacted: report.redacted.slice(0, BRIEF_ITEMS), redactedTotal: report.redacted.length,
  };
}

export function withBriefProtection<T extends object>(value: T) {
  const report = (value as { contentProtection?: ContentProtectionReport | null }).contentProtection ?? null;
  return { ...value, contentProtection: briefContentProtection(report) };
}

/** Null means this database has not yet been indexed with line redaction enabled. */
export function readContentProtection(db: SqliteDatabase): ContentProtectionReport | null {
  const value = db.prepare("SELECT value FROM metadata WHERE key = ?").pluck().get(REPORT_KEY) as string | undefined;
  return value ? JSON.parse(value) as ContentProtectionReport : null;
}
