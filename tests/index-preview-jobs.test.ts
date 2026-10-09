import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Worker } from "node:worker_threads";
import { ProjectContextApp } from "../src/core/app.js";
import { IndexPreviewJobs } from "../src/ui/index-preview-jobs.js";

describe("bounded index preview workers", () => {
  let root: string;
  let app: ProjectContextApp;
  let jobs: IndexPreviewJobs;
  let projectId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "index-preview-worker-"));
    vi.stubEnv("PROJECT_CONTEXT_HOME", join(root, "memory"));
    vi.stubEnv("PROJECT_CONTEXT_ALLOWED_ROOTS", root);
    vi.stubEnv("PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS", root);
    const projectRoot = join(root, "project");
    await mkdir(join(projectRoot, "src"), { recursive: true });
    await writeFile(join(projectRoot, "src", "main.c"), "int main() { return 0; }\n");
    app = await ProjectContextApp.create();
    projectId = (await app.openProject(projectRoot)).id;
    await app.index(projectId);
    jobs = new IndexPreviewJobs();
  });

  afterEach(async () => {
    await jobs?.close();
    app?.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("matches direct preview, shares concurrent requests and allows a fresh request after exit", async () => {
    const expected = app.indexMigrationPreview(projectId);
    expect(expected.totalIndexedFiles).toBeGreaterThan(0);
    const first = jobs.run(projectId);
    expect(jobs.run(projectId)).toBe(first);
    await expect(first).resolves.toEqual(expected);
    const next = jobs.run(projectId);
    expect(next).not.toBe(first);
    await expect(next).resolves.toEqual(expected);
  }, 20000);

  it("retains domain error codes and continues queued work after a failed preview", async () => {
    const failed = expect(jobs.run("missing-project")).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    const queued = jobs.run(projectId);
    await failed;
    await expect(queued).resolves.toMatchObject({ totalIndexedFiles: 1 });
  }, 20000);

  it("bounds requests and closes both active and queued work without hanging", async () => {
    const pending = Array.from({ length: 8 }, (_, index) => jobs.run(index === 0 ? projectId : `missing-${index}`));
    const outcomes = Promise.allSettled(pending);
    await expect(jobs.run("overflow")).rejects.toMatchObject({ code: "INDEX_PREVIEW_BUSY" });
    expect(jobs.run(projectId)).toBe(pending[0]);
    await jobs.close();
    expect((await outcomes).every(result => result.status === "rejected" && result.reason.code === "INDEX_PREVIEW_CLOSED")).toBe(true);
    await expect(jobs.run(projectId)).rejects.toMatchObject({ code: "INDEX_PREVIEW_CLOSED" });
    await jobs.close();
  });

  it("preserves migration lock error details from the worker", async () => {
    const directory = join(root, "project", ".project-context", "migration-jobs");
    await mkdir(directory);
    const requestId = randomUUID();
    await writeFile(join(directory, "active.json"), JSON.stringify({ requestId }));
    await writeFile(join(directory, `${requestId}.json`), JSON.stringify({ status: "running", ownerPid: process.pid }));
    await expect(jobs.run(projectId)).rejects.toMatchObject({ code: "INDEX_MIGRATION_RUNNING", details: { requestId } });
  }, 20000);

  it("rejects interrupted workers and releases their slot for queued requests", async () => {
    const failed = expect(jobs.run(projectId)).rejects.toMatchObject({ code: "INDEX_PREVIEW_WORKER_EXITED" });
    const queued = expect(jobs.run("missing-after-interruption")).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    const worker = (jobs as unknown as { worker: Worker }).worker;
    await worker.terminate();
    await failed;
    await queued;
  }, 20000);
});
