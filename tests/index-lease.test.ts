import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INDEX_LEASE_TTL_MS, releaseIndexLease, renewIndexLease, tryAcquireIndexLease } from "../src/indexing/index-lease.js";
import { openDatabase, type SqliteDatabase } from "../src/storage/database.js";
import { migrateProject } from "../src/storage/schema.js";

describe("index lease", () => {
  let db: SqliteDatabase;
  const now = Date.now();

  beforeEach(() => {
    db = openDatabase(":memory:");
    migrateProject(db);
  });

  afterEach(() => db.close());

  it("admits one process at a time until the holder releases it", () => {
    expect(tryAcquireIndexLease(db, "idx_a", "process-a", now)).toMatchObject({ acquired: true, replaced: null });
    expect(tryAcquireIndexLease(db, "idx_b", "process-b", now + 1_000))
      .toMatchObject({ acquired: false, holder: { owner: "process-a", runId: "idx_a" } });
    expect(tryAcquireIndexLease(db, "idx_a2", "process-a", now + 1_000)).toMatchObject({ acquired: true, replaced: null });
    releaseIndexLease(db, "process-b");
    expect(tryAcquireIndexLease(db, "idx_b", "process-b", now + 2_000).acquired).toBe(false);
    releaseIndexLease(db, "process-a");
    expect(tryAcquireIndexLease(db, "idx_b", "process-b", now + 2_000)).toMatchObject({ acquired: true, replaced: null });
  });

  it("extends only the holder's lease", () => {
    tryAcquireIndexLease(db, "idx_a", "process-a", now);
    expect(renewIndexLease(db, "process-b", now + 60_000)).toBe(false);
    expect(renewIndexLease(db, "process-a", now + 60_000)).toBe(true);
    expect(tryAcquireIndexLease(db, "idx_b", "process-b", now + INDEX_LEASE_TTL_MS + 1).acquired).toBe(false);
  });

  it("takes over an expired lease and marks the abandoned run failed at once", () => {
    db.prepare("INSERT INTO index_runs (id, started_at, status) VALUES ('idx_dead', ?, 'running')").run(new Date(now).toISOString());
    tryAcquireIndexLease(db, "idx_dead", "exited-process", now);
    expect(tryAcquireIndexLease(db, "idx_next", "process-b", now + INDEX_LEASE_TTL_MS + 1))
      .toMatchObject({ acquired: true, replaced: { owner: "exited-process", runId: "idx_dead" } });
    const run = db.prepare("SELECT status, errors_json FROM index_runs WHERE id = 'idx_dead'").get() as { status: string; errors_json: string };
    expect(run.status).toBe("failed");
    expect(run.errors_json).toContain("did not finish");
  });
});
