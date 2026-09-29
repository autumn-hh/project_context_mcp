import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isMainThread, workerData } from "node:worker_threads";
import { ProjectContextError } from "../shared/errors.js";

/** Cooperating processes stop opening project connections while the migration worker owns it. */
export function assertMigrationAccess(root: string): void {
  const directory = join(root, ".project-context", "migration-jobs");
  try {
    const active = JSON.parse(readFileSync(join(directory, "active.json"), "utf8")) as { requestId: string };
    if (!/^[0-9a-f-]{36}$/i.test(active.requestId)) throw new Error("Invalid migration request ID");
    const job = JSON.parse(readFileSync(join(directory, `${active.requestId}.json`), "utf8")) as { status: string; ownerPid: number };
    if (job.status !== "running") return;
    if (!isMainThread && workerData?.requestId === active.requestId && job.ownerPid === process.pid) return;
    try { process.kill(job.ownerPid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; }
    throw new ProjectContextError("INDEX_MIGRATION_RUNNING", "此项目正在升级，已暂缓其他连接访问；升级结束后自动恢复。请勿重复升级。", { requestId: active.requestId });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (error instanceof ProjectContextError) throw error;
    throw new ProjectContextError("MIGRATION_STATE_UNREADABLE", "无法确认项目升级状态，请检查 migration-jobs 记录后再访问数据库。");
  }
}
