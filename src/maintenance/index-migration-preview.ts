import type { SqliteDatabase } from "../storage/database.js";
import { analyzeIndexRecommendations } from "./index-recommendations.js";

/** Indexed source sizes are a selection aid, not an estimate of SQLite savings. */
export function indexMigrationPreview(db: SqliteDatabase) {
  const rows = db.prepare(`SELECT s.path, s.size_bytes AS bytes, COUNT(c.id) AS chunks
    FROM sources s LEFT JOIN chunks c ON c.source_id = s.id GROUP BY s.id ORDER BY s.path`)
    .all() as Array<{ path: string; bytes: number; chunks: number }>;
  const groups = new Map<string, { path: string; files: number; sourceBytes: number; chunks: number; samples: string[]; reason: string }>();
  for (const row of rows) {
    const parts = row.path.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      const path = parts.slice(0, depth).join("/");
      if (/[\\*?\[\]!#\r\n]/u.test(path) || path.trim() !== path || parts.slice(0, depth).some(p => !p || p === "." || p === ".." || p.trim() !== p)) continue;
      const reason = /(^|\/)(worktrees?|\.worktrees)(\/|$)/i.test(path)
        ? "可能包含工作树副本，请确认是否需要在本项目搜索"
        : /(^|\/)([^/]*learning[^/]*|examples?|samples?|references?)(\/|$)/i.test(path)
          ? "可能是学习、示例或参考源码，请按业务需要选择" : "请确认该目录是否需要参与搜索";
      const group = groups.get(path) ?? { path, files: 0, sourceBytes: 0, chunks: 0, samples: [], reason };
      group.files++; group.sourceBytes += row.bytes; group.chunks += row.chunks;
      if (group.samples.length < 3) group.samples.push(row.path);
      groups.set(path, group);
    }
  }
  const directoryRows = [...groups.values()].sort((a, b) => b.sourceBytes - a.sourceBytes || a.path.localeCompare(b.path));
  const recommendations = analyzeIndexRecommendations(rows.map(row => row.path), directoryRows.map(directory => directory.path));
  const directories = directoryRows.map(directory => ({ ...directory,
    recommended: recommendations.recommendations[directory.path]?.recommended ?? false,
    recommendationReason: recommendations.recommendations[directory.path]?.reason,
  }));
  return { directories, totalDirectories: groups.size, totalIndexedFiles: rows.length,
    sourceBytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    projectTypes: recommendations.projectTypes,
    note: "按已索引源码字节数排序，支持搜索全部目录；父子目录统计重叠，不可相加，也不代表数据库可回收量。未索引文件不在此预览内。" };
}
