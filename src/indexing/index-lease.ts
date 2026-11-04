import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { SqliteDatabase } from "../storage/database.js";
import { ProjectContextError } from "../shared/errors.js";
import { createId } from "../shared/ids.js";

/**
 * Cross-process index lease. Each MCP, Web and CLI process guards its own runs in memory,
 * but several of them often watch the same project and react to the same file events.
 * The lease lets one process index at a time; the others wait and then reuse its result.
 */
const LEASE_KEY = "index_lease";
// The holder renews well inside the TTL, so an unrenewed lease belongs to an exited process.
export const INDEX_LEASE_TTL_MS = 120_000;
export const INDEX_LEASE_RENEW_MS = 30_000;
const LEASE_POLL_MS = 500;

export const PROCESS_LEASE_OWNER = `${hostname()}:${process.pid}:${randomUUID()}`;

export interface IndexLease {
  owner: string;
  pid: number;
  runId: string;
  acquiredAt: string;
  expiresAt: string;
}

export const INTERRUPTED_RUN_ERRORS = JSON.stringify([
  { path: "<index>", message: "Index run did not finish; its process exited before recording a result." },
]);

function readLease(db: SqliteDatabase): IndexLease | null {
  const value = db.prepare("SELECT value FROM metadata WHERE key = ?").pluck().get(LEASE_KEY) as string | undefined;
  try {
    return value ? JSON.parse(value) as IndexLease : null;
  } catch {
    return null;
  }
}

function heldByOther(lease: IndexLease | null, owner: string, now: number): boolean {
  return lease !== null && lease.owner !== owner && Date.parse(lease.expiresAt) > now;
}

/** Take the lease when it is free, expired or already ours. An expired holder's run is marked failed. */
export function tryAcquireIndexLease(
  db: SqliteDatabase, runId: string, owner = PROCESS_LEASE_OWNER, now = Date.now(),
): { acquired: true; replaced: IndexLease | null } | { acquired: false; holder: IndexLease } {
  return db.transaction(() => {
    const current = readLease(db);
    if (current && heldByOther(current, owner, now)) return { acquired: false as const, holder: current };
    const lease: IndexLease = {
      owner, pid: process.pid, runId, acquiredAt: new Date(now).toISOString(), expiresAt: new Date(now + INDEX_LEASE_TTL_MS).toISOString(),
    };
    db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)").run(LEASE_KEY, JSON.stringify(lease));
    const replaced = current && current.owner !== owner ? current : null;
    if (replaced) {
      db.prepare("UPDATE index_runs SET status = 'failed', completed_at = ?, errors_json = ? WHERE id = ? AND status = 'running'")
        .run(new Date(now).toISOString(), INTERRUPTED_RUN_ERRORS, replaced.runId);
    }
    return { acquired: true as const, replaced };
  }).immediate();
}

/** Wait, without holding the write lock, until no other live process holds the lease. */
export async function waitForOtherIndexer(db: SqliteDatabase, signal?: AbortSignal, owner = PROCESS_LEASE_OWNER): Promise<void> {
  while (heldByOther(readLease(db), owner, Date.now())) {
    if (signal?.aborted) throw new ProjectContextError("INDEX_CANCELLED", "Project indexing was cancelled.");
    await new Promise((resolve) => setTimeout(resolve, LEASE_POLL_MS));
  }
}

export async function acquireIndexLease(
  db: SqliteDatabase, runId: string, signal?: AbortSignal, owner = PROCESS_LEASE_OWNER,
): Promise<IndexLease | null> {
  for (;;) {
    await waitForOtherIndexer(db, signal, owner);
    const attempt = tryAcquireIndexLease(db, runId, owner);
    if (attempt.acquired) return attempt.replaced;
  }
}

export function renewIndexLease(db: SqliteDatabase, owner = PROCESS_LEASE_OWNER, now = Date.now()): boolean {
  return db.transaction(() => {
    const current = readLease(db);
    if (current?.owner !== owner) return false;
    db.prepare("UPDATE metadata SET value = ? WHERE key = ?")
      .run(JSON.stringify({ ...current, expiresAt: new Date(now + INDEX_LEASE_TTL_MS).toISOString() }), LEASE_KEY);
    return true;
  }).immediate();
}

export function releaseIndexLease(db: SqliteDatabase, owner = PROCESS_LEASE_OWNER): void {
  db.transaction(() => {
    if (readLease(db)?.owner === owner) db.prepare("DELETE FROM metadata WHERE key = ?").run(LEASE_KEY);
  }).immediate();
}

/** Run `work` while holding the lease, renewing it until the work settles. */
export async function withIndexLease<T>(
  db: SqliteDatabase, signal: AbortSignal | undefined, work: (runId: string) => Promise<T>,
): Promise<T> {
  const runId = createId("idx");
  await acquireIndexLease(db, runId, signal);
  const renewal = setInterval(() => {
    try { renewIndexLease(db); } catch { /* retried at the next interval; expiry only lets another process start */ }
  }, INDEX_LEASE_RENEW_MS);
  try {
    return await work(runId);
  } finally {
    clearInterval(renewal);
    try { releaseIndexLease(db); } catch { /* an unreleased lease expires on its own */ }
  }
}
