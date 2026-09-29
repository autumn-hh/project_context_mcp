import { realpath, stat, statfs } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

export type MigrationMode = "upgrade" | "compact";
export interface MigrationSpaceCheck {
  sufficient: boolean;
  checks: Array<{ path: string; paths: string[]; roles: string[]; availableBytes: number | null; requiredBytes: number; shortfallBytes: number | null }>;
  warnings: string[];
}

export interface SpaceProbe { volume: string; availableBytes: number }

// Resolve the nearest existing ancestor: a new backup directory need not exist yet.
export async function probeSpace(path: string): Promise<SpaceProbe> {
  let existing = resolve(path);
  for (;;) {
    try {
      const canonical = await realpath(existing);
      const [info, filesystem] = await Promise.all([stat(canonical), statfs(canonical, { bigint: true })]);
      const available = filesystem.bavail * filesystem.bsize;
      if (available < 0n || available > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Invalid filesystem free-space value");
      return { volume: String(info.dev), availableBytes: Number(available) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
}

export async function checkMigrationSpace(input: {
  databasePath: string; databaseBytes: number; walBytes: number; backupDirectory: string;
  mode?: MigrationMode; temporaryDirectory?: string;
}, probe: (path: string) => Promise<SpaceProbe> = probeSpace): Promise<MigrationSpaceCheck> {
  const mode = input.mode ?? "upgrade";
  // Do not deduct free pages: SQLite may need to rewrite the original allocation.
  const bytes = Math.max(input.databaseBytes + input.walBytes, 1024 * 1024);
  const demands = [
    { path: dirname(input.databasePath), role: "数据库（压缩重写与 WAL 余量）", bytes: bytes * (mode === "upgrade" ? 2 : 1) },
    { path: input.temporaryDirectory ?? process.env.SQLITE_TMPDIR ?? tmpdir(), role: "SQLite 临时目录", bytes },
    ...(mode === "upgrade" ? [{ path: input.backupDirectory, role: "迁移备份", bytes }] : []),
  ];
  const checks: MigrationSpaceCheck["checks"] = [];
  const volumes = new Map<string, MigrationSpaceCheck["checks"][number]>();
  const warnings = ["空间需求为保守估算：备份约一份数据库，升级 WAL 预留一份，压缩在数据库及临时盘合计预留两份；同盘合并计算并另留 64 MiB。其他进程和索引增长仍可能导致运行时空间不足。"];
  for (const demand of demands) {
    try {
      const space = await probe(demand.path);
      if (!Number.isFinite(space.availableBytes) || space.availableBytes < 0) throw new Error("Invalid free-space value");
      const existing = volumes.get(space.volume);
      if (existing) {
        existing.paths.push(demand.path);
        existing.roles.push(demand.role);
        existing.requiredBytes += demand.bytes;
        existing.availableBytes = Math.min(existing.availableBytes!, space.availableBytes);
        existing.shortfallBytes = Math.max(0, existing.requiredBytes - existing.availableBytes);
      } else {
        const requiredBytes = demand.bytes + 64 * 1024 * 1024;
        const row = { path: demand.path, paths: [demand.path], roles: [demand.role], availableBytes: space.availableBytes, requiredBytes, shortfallBytes: Math.max(0, requiredBytes - space.availableBytes) };
        volumes.set(space.volume, row);
        checks.push(row);
      }
    } catch (error) {
      checks.push({ path: demand.path, paths: [demand.path], roles: [demand.role], availableBytes: null, requiredBytes: demand.bytes + 64 * 1024 * 1024, shortfallBytes: null });
      warnings.push(`无法确认 ${demand.path} 的可用空间：${error instanceof Error ? error.message : String(error)}。请检查路径和访问权限后重试。`);
    }
  }
  return { sufficient: checks.every(row => row.shortfallBytes === 0), checks, warnings };
}

export function migrationFailureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/database or disk is full|SQLITE_FULL|ENOSPC|disk full/i.test(raw)) {
    return `磁盘空间不足，请释放数据库、备份及临时目录所在磁盘的空间后重试；保留现有数据库和 WAL 文件。原始错误：${raw}`;
  }
  if (/SQLITE_BUSY|database is locked|database is busy/i.test(raw)) return `数据库被其他连接占用，请等待其他进程空闲后重试。原始错误：${raw}`;
  return raw;
}
