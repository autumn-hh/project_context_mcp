import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { ProjectContextApp } from "../core/app.js";
import { ProjectContextError } from "../shared/errors.js";

type Preview = ReturnType<ProjectContextApp["indexMigrationPreview"]>;
export type IndexPreviewMessage =
  | { result: Preview }
  | { error: { code: string; message: string; details?: Record<string, unknown> } };
interface Job {
  projectId: string;
  promise: Promise<Preview>;
  resolve: (value: Preview) => void;
  reject: (error: Error) => void;
}

/** One preview worker at a time; repeated requests share work, not an unbounded queue. */
export class IndexPreviewJobs {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private worker: Worker | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;

  run(projectId: string): Promise<Preview> {
    if (this.closed) return Promise.reject(new ProjectContextError("INDEX_PREVIEW_CLOSED", "索引预览服务已关闭。"));
    const existing = this.jobs.get(projectId);
    if (existing) return existing.promise;
    if (this.jobs.size >= 8) return Promise.reject(new ProjectContextError("INDEX_PREVIEW_BUSY", "索引预览请求较多，请稍后重试。"));
    let resolve!: Job["resolve"];
    let reject!: Job["reject"];
    const promise = new Promise<Preview>((success, failure) => { resolve = success; reject = failure; });
    const job = { projectId, promise, resolve, reject };
    this.jobs.set(projectId, job);
    this.queue.push(job);
    this.startNext();
    return promise;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const job of this.jobs.values()) job.reject(new ProjectContextError("INDEX_PREVIEW_CLOSED", "索引预览服务已关闭。"));
    this.jobs.clear();
    this.queue.length = 0;
    const worker = this.worker;
    this.closing = worker ? worker.terminate().then(() => {}) : Promise.resolve();
    return this.closing;
  }

  private startNext(): void {
    if (this.closed || this.worker) return;
    const job = this.queue.shift();
    if (!job) return;
    const finish = (message: IndexPreviewMessage) => {
      this.jobs.delete(job.projectId);
      if ("error" in message) job.reject(new ProjectContextError(message.error.code, message.error.message, message.error.details));
      else job.resolve(message.result);
      this.startNext();
    };
    try {
      const worker = import.meta.url.endsWith(".ts")
        ? new Worker(`require('tsx/cjs');require(${JSON.stringify(fileURLToPath(new URL("index-preview-worker.ts", import.meta.url)))});`, { eval: true, workerData: { projectId: job.projectId } })
        : new Worker(new URL("index-preview-worker.js", import.meta.url), { workerData: { projectId: job.projectId } });
      this.worker = worker;
      let response: IndexPreviewMessage | undefined;
      worker.once("message", (message: IndexPreviewMessage) => { response = message; });
      worker.once("error", (error) => { response = { error: { code: "INDEX_PREVIEW_WORKER_FAILED", message: error.message } }; });
      // Wait for exit before launching another worker so even cleanup never overlaps.
      worker.once("exit", (code) => {
        this.worker = undefined;
        finish(code === 0 && response ? response : {
          error: response && "error" in response ? response.error : {
            code: "INDEX_PREVIEW_WORKER_EXITED", message: `索引预览后台任务退出（${code}），请重试。`,
          },
        });
      });
    } catch (error) {
      finish({ error: { code: "INDEX_PREVIEW_START_FAILED", message: error instanceof Error ? error.message : String(error) } });
    }
  }
}
