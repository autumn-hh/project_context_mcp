import type { SqliteDatabase } from "../storage/database.js";
import { sha256 } from "../shared/ids.js";
import { ProjectContextError } from "../shared/errors.js";
import { replaceItemNgrams } from "../search/ngram-index.js";

interface TitleRow { id: string; title: string; content: string; reason: string | null }
export interface TitleNormalizationPreview {
  previewHash: string;
  changes: Array<{ id: string; oldTitle: string; newTitle: string }>;
}

export function previewTaskSummaryTitles(db: SqliteDatabase): TitleNormalizationPreview {
  const rows = legacySummaries(db);
  return {
    previewHash: sha256(JSON.stringify(rows)),
    changes: rows.map((row) => ({ id: row.id, oldTitle: row.title, newTitle: normalizedTitle(row) })),
  };
}

export function normalizeTaskSummaryTitles(
  db: SqliteDatabase, previewHash: string, options: { signal?: AbortSignal } = {},
): { changed: number; changes: TitleNormalizationPreview["changes"] } {
  const checkCancellation = (): void => {
    if (options.signal?.aborted) {
      throw new ProjectContextError("TITLE_NORMALIZATION_CANCELLED", "Title normalization was cancelled; no titles were changed.");
    }
  };
  checkCancellation();
  return db.transaction(() => {
    const preview = previewTaskSummaryTitles(db);
    if (preview.previewHash !== previewHash) {
      throw new ProjectContextError("TITLE_PREVIEW_STALE", "Task summaries changed after preview. Preview again before applying.");
    }
    const update = db.prepare("UPDATE memories SET title = ? WHERE id = ?");
    const removeFts = db.prepare("DELETE FROM memories_fts WHERE memory_id = ?");
    const insertFts = db.prepare("INSERT INTO memories_fts (memory_id, title, content, reason) VALUES (?, ?, ?, ?)");
    for (const row of legacySummaries(db)) {
      checkCancellation();
      const title = normalizedTitle(row);
      update.run(title, row.id);
      removeFts.run(row.id);
      insertFts.run(row.id, title, row.content, row.reason ?? "");
      replaceItemNgrams(db, "memory", row.id, `${title}\n${row.content}\n${row.reason ?? ""}`);
    }
    checkCancellation();
    return { changed: preview.changes.length, changes: preview.changes };
  }).immediate();
}

function legacySummaries(db: SqliteDatabase): TitleRow[] {
  return db.prepare(`
    SELECT id, title, content, reason FROM memories
    WHERE status = 'active' AND type = 'task-summary'
      AND title LIKE 'Review task-summary from task:%'
    ORDER BY id
  `).all() as TitleRow[];
}

function normalizedTitle(row: TitleRow): string {
  const line = row.content.split(/\r?\n/u).find((value) => value.trim()) ?? "";
  const conclusion = line.trim().replace(/^(?:#{1,6}\s+|[-*+]\s+)/u, "")
    .replace(/^(?:decision|constraint|lesson|issue|risk)\s*:\s*/iu, "");
  return ((conclusion.split(/(?<=[。！？])\s*|(?<=[.!?])\s+/u)[0] ?? "").trim()
    || row.title.replace(/^Review task-summary from task:\s*/iu, "").trim()
    || "任务摘要").slice(0, 160);
}
