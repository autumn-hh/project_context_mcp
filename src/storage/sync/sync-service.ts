import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod/v4";
import type { ProjectContextApp } from "../../core/app.js";
import type { SqliteDatabase } from "../database.js";
import { openDatabase } from "../database.js";
import { initializeRuleBridge, drainRuleOutbox, applyRuleProjection } from "./rule-bridge.js";
import { loadRemoteTarget, S3RemoteStore } from "../remote/s3.js";
import { decryptBackupToTemporary, encryptPortableFile, readPassphraseEnvironment } from "../../maintenance/encrypted-backup-service.js";
import { authorizeOutputPath } from "../../security/path-policy.js";
import { ProjectContextError } from "../../shared/errors.js";
import { acknowledgeEvents, initializeSync, outgoingEvents, receiveEvents, syncStatus, type SyncEvent } from "./event-store.js";

const configSchema = z.object({ syncId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), remoteName: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) }).strict();
const MAX_BATCH_BYTES = 8 * 1024 * 1024;
const active = new Set<string>();

async function deviceIdentity(storageRoot: string): Promise<string> {
  const path = join(storageRoot, "sync-device.json");
  const read = async () => {
    const id = JSON.parse(await readFile(path, "utf8")).id;
    if (typeof id !== "string" || !/^dev_[a-f0-9-]{36}$/.test(id)) throw new ProjectContextError("SYNC_DEVICE_INVALID", "Local sync device identity is invalid.");
    return id as string;
  };
  try { return await read(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await mkdir(storageRoot, { recursive: true });
  try { await writeFile(path, JSON.stringify({ id: "dev_" + randomUUID() }), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return read();
}

export async function configureProjectSync(app: ProjectContextApp, projectId: string, input: unknown) {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) throw new ProjectContextError("INVALID_SYNC_CONFIG", "Sync configuration requires a stable syncId and configured remote name.");
  await loadRemoteTarget(app.storageRoot, parsed.data.remoteName);
  const device = await deviceIdentity(app.storageRoot);
  const db = app.projects.projectDatabase(projectId);
  try {
    const existing = db.prepare("SELECT value FROM metadata WHERE key='sync_remote_config'").pluck().get();
    if (existing && existing !== JSON.stringify(parsed.data)) throw new ProjectContextError("SYNC_CONFIG_EXISTS", "Existing synchronization destination cannot be silently replaced.");
    const status = initializeSync(db, parsed.data.syncId, device);
    const registry = openDatabase(join(app.storageRoot, "registry.db"));
    try { initializeRuleBridge(registry, db, projectId, parsed.data.syncId); drainRuleOutbox(registry, db, projectId, parsed.data.syncId); }
    finally { registry.close(); }
    db.prepare("INSERT OR REPLACE INTO metadata VALUES('sync_remote_config',?)").run(JSON.stringify(parsed.data));
    return { ...syncStatus(db), remoteName: parsed.data.remoteName, codeIndex: false };
  } finally { db.close(); }
}

function configuration(db: SqliteDatabase) {
  const value = db.prepare("SELECT value FROM metadata WHERE key='sync_remote_config'").pluck().get();
  if (typeof value !== "string") throw new ProjectContextError("SYNC_NOT_CONFIGURED", "Configure the project sync space and remote first.");
  return configSchema.parse(JSON.parse(value));
}

export async function transferSync(app: ProjectContextApp, projectId: string, direction: "push" | "pull") {
  const lock = app.storageRoot + "/" + projectId;
  if (active.has(lock)) throw new ProjectContextError("SYNC_BUSY", "This project already has a sync transfer in progress.");
  active.add(lock);
  let db: SqliteDatabase | undefined; let temporary: string | undefined;
  try {
    db = app.projects.projectDatabase(projectId);
    const config = configuration(db);
    const bridge = (apply = false) => {
      const registry = openDatabase(join(app.storageRoot, "registry.db"));
      try {
        initializeRuleBridge(registry, db!, projectId, config.syncId);
        return apply ? applyRuleProjection(registry, db!, projectId, config.syncId) : drainRuleOutbox(registry, db!, projectId, config.syncId);
      } finally { registry.close(); }
    };
    bridge();
    const target = await loadRemoteTarget(app.storageRoot, config.remoteName);
    const store = new S3RemoteStore(target); const passphrase = readPassphraseEnvironment(target.passphraseEnv);
    const allowed = app.allowedOutputRoots[0];
    if (!allowed) throw new ProjectContextError("SYNC_OUTPUT_ROOT_REQUIRED", "Configure an allowed output root for sync staging.");
    const directory = await authorizeOutputPath(join(allowed, ".project-context-transfers"), app.allowedOutputRoots);
    await mkdir(directory, { recursive: true }); temporary = await mkdtemp(join(directory, "sync-"));
    let batches = 0; let count = 0;
    const prefix = `sync/${config.syncId}/`;
    if (direction === "push") {
      for (let iteration = 0; iteration < 100; iteration++) {
        const pending = outgoingEvents(db, 100); if (!pending.length) break;
        const events: SyncEvent[] = []; let bytes = 0;
        for (const event of pending) {
          const size = Buffer.byteLength(JSON.stringify(event));
          if (size > MAX_BATCH_BYTES - 1024) throw new ProjectContextError("SYNC_EVENT_TOO_LARGE", "A local event exceeds the sync batch limit.");
          if (bytes + size > MAX_BATCH_BYTES - 1024) break; events.push(event); bytes += size;
        }
        const state = syncStatus(db);
        if (!state.configured) throw new ProjectContextError("SYNC_NOT_CONFIGURED", "Missing sync identity.");
        const payload = JSON.stringify({ version: 1, syncId: config.syncId, producer: state.deviceId, events });
        const batchId = createHash("sha256").update(payload).digest("hex");
        // Ciphertext is randomized. Keep the encrypted outbox until confirmed, so retry uses identical bytes.
        const outbox = await authorizeOutputPath(join(directory, "outbox", config.syncId), app.allowedOutputRoots); await mkdir(outbox, { recursive: true });
        // Outbox must obey configured output policy, including custom storage roots.
        const encrypted = await authorizeOutputPath(join(outbox, `${batchId}.pcmb`), app.allowedOutputRoots);
        try { await stat(encrypted); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          const plaintext = join(temporary, `${batchId}.json`); await writeFile(plaintext, payload, { flag: "wx", mode: 0o600 });
          await encryptPortableFile(plaintext, encrypted, app.allowedOutputRoots, passphrase);
          await rm(plaintext, { force: true });
        }
        await store.upload(prefix + batchId + ".pcmb", encrypted, app.allowedOutputRoots);
        acknowledgeEvents(db, events.map(event => event.id));
        await rm(encrypted, { force: true }); count += events.length; batches++;
      }
    } else {
      let continuation: string | undefined; const tokens = new Set<string>();
      do {
        const page = await store.list(prefix, continuation);
        for (const key of page.keys) {
          if (!new RegExp("^sync/" + config.syncId + "/[a-f0-9]{64}[.]pcmb$").test(key)) continue;
          if (db.prepare("SELECT 1 FROM sync_received WHERE object_key=?").get(key)) continue;
          const encrypted = join(temporary, randomUUID() + ".pcmb");
          const download = await store.download(key, encrypted, app.allowedOutputRoots);
          const decrypted = await decryptBackupToTemporary(encrypted, app.allowedOutputRoots, passphrase);
          try {
            if ((await stat(decrypted.temporary)).size > MAX_BATCH_BYTES) throw new ProjectContextError("SYNC_BATCH_LIMIT", "Remote event batch exceeds limit.");
            const plaintext = await readFile(decrypted.temporary, "utf8");
            const contentId = createHash("sha256").update(plaintext).digest("hex");
            if (key !== prefix + contentId + ".pcmb") throw new ProjectContextError("SYNC_BATCH_ID_MISMATCH", "Remote batch content does not match its immutable key.");
            const payload = z.object({ version: z.literal(1), syncId: z.literal(config.syncId), producer: z.string().min(1).max(256), events: z.array(z.unknown()).max(1000) }).strict()
              .parse(JSON.parse(plaintext));
            bridge();
            const received = await receiveEvents(db, payload.events); count += received.inserted; batches++;
            bridge(true);
            db.prepare("INSERT INTO sync_received VALUES (?,?)").run(key, download.sha256);
          } finally { await rm(decrypted.temporary, { force: true }); await rm(encrypted, { force: true }); }
        }
        continuation = page.continuationToken ?? undefined;
        if (continuation) {
          if (tokens.has(continuation) || tokens.size >= 100) throw new ProjectContextError("SYNC_LIST_LIMIT", "Remote listing repeated a cursor or exceeded the per-call page limit.");
          tokens.add(continuation);
        }
      } while (continuation);
    }
    bridge(true);
    return { direction, batches, events: count, status: syncStatus(db) };
  } finally {
    db?.close(); if (temporary) await rm(temporary, { recursive: true, force: true }); active.delete(lock);
  }
}
