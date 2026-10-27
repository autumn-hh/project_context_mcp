import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ProjectContextApp } from "../../core/app.js";
import { authorizeOutputPath } from "../../security/path-policy.js";
import { ProjectContextError } from "../../shared/errors.js";
import { loadRemoteTarget, S3RemoteStore } from "./s3.js";

function receiptDirectory(storageRoot: string, projectId: string): string {
  return join(storageRoot, "remote-backup-history", createHash("sha256").update(projectId).digest("hex"));
}
async function workspace(app: ProjectContextApp): Promise<string> {
  const allowed = app.allowedOutputRoots[0];
  if (!allowed) throw new ProjectContextError("REMOTE_OUTPUT_ROOT_REQUIRED", "Configure an allowed output root for encrypted transfer staging.");
  const root = await authorizeOutputPath(join(allowed, ".project-context-transfers"), app.allowedOutputRoots);
  await mkdir(root, { recursive: true, mode: 0o700 });
  return mkdtemp(join(root, "transfer-"));
}

export async function backupRemote(app: ProjectContextApp, projectId: string, remoteName: string,
  options: { userMemoryIds?: string[]; includeSourceExcerpts?: boolean } = {}) {
  app.projects.get(projectId);
  const target = await loadRemoteTarget(app.storageRoot, remoteName);
  const store = new S3RemoteStore(target);
  const temporary = await workspace(app);
  const id = randomUUID();
  const key = `${createHash("sha256").update(projectId).digest("hex")}/${id}.pcmb`;
  try {
    const snapshot = join(temporary, "knowledge.pcmb");
    const exported = await app.exportEncryptedPack(projectId, snapshot, target.passphraseEnv, options);
    const uploaded = await store.upload(key, snapshot, app.allowedOutputRoots);
    const result = { id, projectId, remoteName, key, bytes: uploaded.bytes, sha256: uploaded.sha256,
      completedAt: new Date().toISOString(), content: "knowledge" as const,
      sourceExcerpts: exported.manifest.policy.sourceExcerpts, rules: options.userMemoryIds?.length ?? 0 };
    let historySaved = true;
    try {
      const directory = receiptDirectory(app.storageRoot, projectId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(join(directory, `${id}.json`), JSON.stringify(result) + "\n", { flag: "wx", mode: 0o600 });
    } catch { historySaved = false; }
    return { ...result, historySaved, warning: historySaved ? null : "Upload succeeded but local history could not be saved. Retain the returned remote name and object key." };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function restoreRemote(app: ProjectContextApp, remoteName: string, key: string, directory: string) {
  // Destination authorization precedes any network access.
  await authorizeOutputPath(directory, app.allowedOutputRoots);
  const target = await loadRemoteTarget(app.storageRoot, remoteName);
  const temporary = await workspace(app);
  try {
    const source = join(temporary, "knowledge.pcmb");
    await new S3RemoteStore(target).download(key, source, app.allowedOutputRoots);
    const restored = await app.restoreEncryptedPack(source, directory, target.passphraseEnv);
    return { ...restored, remoteName, key };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function remoteBackupHistory(storageRoot: string, projectId: string) {
  const directory = receiptDirectory(storageRoot, projectId);
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const records: Array<Record<string, unknown>> = [];
  for (const name of names.filter(name => /^[a-f0-9-]+[.]json$/.test(name))) {
    const raw = await readFile(join(directory, name), "utf8");
    if (raw.length > 16384) throw new ProjectContextError("REMOTE_HISTORY_INVALID", "Remote backup history is invalid.");
    try { records.push(JSON.parse(raw) as Record<string, unknown>); }
    catch { throw new ProjectContextError("REMOTE_HISTORY_INVALID", "Remote backup history is invalid."); }
  }
  return records.sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt))).slice(0, 50);
}
