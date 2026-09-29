import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { ProjectContextError } from "../shared/errors.js";

export interface MigrationJob {
  requestId: string;
  projectId: string;
  kind: "upgrade" | "compact";
  status: "running" | "completed" | "failed" | "interrupted";
  startedAt: string;
  updatedAt: string;
  ownerPid: number;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}
export interface MigrationJobInput {
  requestId: string;
  projectId: string;
  kind: "upgrade" | "compact";
  excludeDirectories: string[];
}

function directory(root: string): string { return join(root, ".project-context", "migration-jobs"); }
function read<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** The durable lock is deliberately retained after interruption until a new explicit request. */
export class MigrationJobs {
  private running = new Map<string, Promise<void>>();
  private jobs = new Map<string, MigrationJob>();

  get(root: string, requestId?: string): MigrationJob | null {
    const dir = directory(root);
    const id = requestId ?? read<{ requestId: string }>(join(dir, "active.json"))?.requestId;
    if (!id) return null;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ProjectContextError("INVALID_INPUT", "Invalid migration request ID.");
    const job = this.jobs.get(join(dir, id)) ?? read<MigrationJob>(join(dir, `${id}.json`));
    if (!job) return null;
    if (job.status === "running" && !alive(job.ownerPid)) {
      return { ...job, status: "interrupted", error: {
        code: "MIGRATION_INTERRUPTED",
        message: "升级服务已退出，执行结果未知。请先检查索引和备份，勿直接重复升级。",
        details: { stateDirectory: dir, outcomeUnknown: true },
      } };
    }
    return job;
  }

  assertIdle(root: string): void {
    const job = this.get(root);
    if (job?.status === "running") throw new ProjectContextError("INDEX_ALREADY_RUNNING", "索引升级仍在后台运行，请等待任务结束。", { requestId: job.requestId });
  }

  prepare(root: string, input: MigrationJobInput): { job: MigrationJob; start: () => void } {
    if (!/^[0-9a-f-]{36}$/i.test(input.requestId)) throw new ProjectContextError("INVALID_INPUT", "Invalid migration request ID.");
    const dir = directory(root);
    mkdirSync(dir, { recursive: true });
    const reservation = join(dir, "reservation.json");
    // Short exclusive reservation prevents two services replacing the same terminal lock.
    // A crash here is conservative: explicit recovery is needed, never silently rerun.
    try { writeFileSync(reservation, JSON.stringify({ pid: process.pid }), { flag: "wx" }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ProjectContextError("INDEX_ALREADY_RUNNING", "升级请求正在启动或上次启动被中断，请检查任务状态后再操作。", { stateDirectory: dir });
      throw error;
    }
    try { return this.prepareReserved(root, input); }
    finally { unlinkSync(reservation); }
  }

  private prepareReserved(root: string, input: MigrationJobInput): { job: MigrationJob; start: () => void } {
    const existing = this.get(root, input.requestId);
    if (existing) {
      if (existing.kind !== input.kind || existing.projectId !== input.projectId) throw new ProjectContextError("INVALID_INPUT", "Request ID belongs to a different migration.");
      return { job: existing, start: () => {} };
    }
    this.assertIdle(root);
    const dir = directory(root);
    mkdirSync(dir, { recursive: true });
    const lock = join(dir, "active.json");
    // Only remove a terminal lock. Exclusive creation arbitrates other UI processes.
    const previous = this.get(root);
    if (previous && previous.status !== "running") {
      const current = read<{ requestId: string }>(lock);
      if (current?.requestId === previous.requestId) unlinkSync(lock);
    }
    const now = new Date().toISOString();
    const job: MigrationJob = { requestId: input.requestId, projectId: input.projectId, kind: input.kind, status: "running", ownerPid: process.pid, startedAt: now, updatedAt: now };
    try { writeFileSync(lock, JSON.stringify({ requestId: job.requestId }), { flag: "wx" }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ProjectContextError("INDEX_ALREADY_RUNNING", "另一升级任务正在启动，请稍后查看状态。");
      throw error;
    }
    try { this.save(root, job); } catch (error) { unlinkSync(lock); throw error; }
    let started = false;
    return { job, start: () => {
      if (started) return;
      started = true;
      const key = join(dir, input.requestId);
      const done = new Promise<void>((resolve) => {
        let finished = false;
        const finish = (update: Partial<MigrationJob>) => {
          if (finished) return;
          finished = true;
          Object.assign(job, update, { updatedAt: new Date().toISOString() });
          try { this.save(root, job); }
          catch { job.error ??= { code: "MIGRATION_STATE_WRITE_FAILED", message: "无法保存最终任务状态，请保留备份并检查磁盘空间。" }; }
          resolve();
        };
        try {
          const source = import.meta.url.endsWith(".ts");
          const worker = source
            ? new Worker(`require('tsx/cjs');require(${JSON.stringify(fileURLToPath(new URL("migration-worker.ts", import.meta.url)))});`, { eval: true, workerData: input })
            : new Worker(new URL("migration-worker.js", import.meta.url), { workerData: input });
          worker.once("message", (message: Partial<MigrationJob>) => finish(message));
          worker.once("error", (error) => finish({ status: "interrupted", error: { code: "MIGRATION_WORKER_FAILED", message: `升级后台任务中断，结果未知：${error.message}`, details: { outcomeUnknown: true, stateDirectory: dir } } }));
          worker.once("exit", (code) => { if (!finished) finish({ status: "interrupted", error: { code: "MIGRATION_WORKER_EXITED", message: `升级后台任务退出（${code}），结果未知，请检查备份和索引。`, details: { outcomeUnknown: true, stateDirectory: dir } } }); });
        } catch (error) { finish({ status: "failed", error: { code: "MIGRATION_START_FAILED", message: String(error) } }); }
      });
      this.running.set(key, done);
      void done.finally(() => this.running.delete(key));
    } };
  }

  async wait(): Promise<void> { await Promise.all(this.running.values()); }

  private save(root: string, job: MigrationJob): void {
    const path = join(directory(root), `${job.requestId}.json`);
    this.jobs.set(join(directory(root), job.requestId), job);
    writeFileSync(`${path}.tmp`, JSON.stringify(job));
    renameSync(`${path}.tmp`, path);
  }
}
