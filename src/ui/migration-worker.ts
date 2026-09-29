import { parentPort, workerData } from "node:worker_threads";
import { ProjectContextApp } from "../core/app.js";
import { ProjectContextError, errorMessage } from "../shared/errors.js";
import type { MigrationJobInput } from "./migration-jobs.js";

async function run(): Promise<void> {
  const input = workerData as MigrationJobInput;
  let app: ProjectContextApp | undefined;
  try {
    app = await ProjectContextApp.create();
    const result = input.kind === "compact"
      ? await app.compactProjectIndex(input.projectId)
      : await app.optimizeProjectIndex(input.projectId, input.excludeDirectories);
    parentPort!.postMessage({ status: "completed", result });
  } catch (error) {
    parentPort!.postMessage({ status: "failed", error: {
      code: error instanceof ProjectContextError ? error.code : "MIGRATION_FAILED",
      message: errorMessage(error),
      ...(error instanceof ProjectContextError && error.details ? { details: error.details } : {}),
    } });
  } finally { app?.close(); }
}
void run();
