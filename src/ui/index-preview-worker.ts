import { parentPort, workerData } from "node:worker_threads";
import { ProjectContextApp } from "../core/app.js";
import { ProjectContextError, errorMessage } from "../shared/errors.js";
import type { IndexPreviewMessage } from "./index-preview-jobs.js";

async function run(): Promise<void> {
  let app: ProjectContextApp | undefined;
  let message: IndexPreviewMessage;
  try {
    app = await ProjectContextApp.create({ initializeProjects: false });
    message = { result: app.indexMigrationPreview((workerData as { projectId: string }).projectId) };
  } catch (error) {
    message = { error: {
      code: error instanceof ProjectContextError ? error.code : "INDEX_PREVIEW_FAILED",
      message: errorMessage(error),
      ...(error instanceof ProjectContextError && error.details ? { details: error.details } : {}),
    } };
  } finally { app?.close(); }
  parentPort!.postMessage(message);
}
void run();
