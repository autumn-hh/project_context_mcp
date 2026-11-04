import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexProject } from "../src/indexing/indexer.js";
import { readContentProtection } from "../src/indexing/content-protection.js";
import { openDatabase, type SqliteDatabase } from "../src/storage/database.js";
import { migrateProject } from "../src/storage/schema.js";
import type { ProjectRecord } from "../src/projects/project-service.js";

describe("unchanged file detection", () => {
  let root: string;
  let db: SqliteDatabase;
  let project: ProjectRecord;
  const anHourAgo = new Date(Date.now() - 3_600_000);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "context-unchanged-"));
    db = openDatabase(":memory:");
    migrateProject(db);
    project = { id: "prj_unchanged", rootPath: root } as ProjectRecord;
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  /** Rewrite a file with same-length content and restore its timestamp, so only a read can notice. */
  async function rewriteInPlace(name: string, content: string): Promise<void> {
    const { mtime } = await stat(join(root, name));
    await writeFile(join(root, name), content, "utf8");
    await utimes(join(root, name), mtime, mtime);
  }

  const storedContent = (name: string) => db.prepare("SELECT content FROM chunks WHERE source_path = ?").pluck().get(name);
  const verification = () => JSON.parse(db.prepare("SELECT value FROM metadata WHERE key = 'content_verification'").pluck().get() as string) as {
    fingerprint: string; verifiedAt: string;
  };
  const setVerification = (value: { fingerprint: string; verifiedAt: string }) =>
    db.prepare("UPDATE metadata SET value = ? WHERE key = 'content_verification'").run(JSON.stringify(value));

  it("trusts unchanged size and time until the daily check or a rule change re-reads every file", async () => {
    await writeFile(join(root, "notes.txt"), "alpha original\n", "utf8");
    await utimes(join(root, "notes.txt"), anHourAgo, anHourAgo);
    expect(await indexProject(db, project)).toMatchObject({ indexed: 1, errors: [] });

    await rewriteInPlace("notes.txt", "alpha modified\n");
    expect(await indexProject(db, project)).toMatchObject({ indexed: 0, skipped: 1 });
    expect(storedContent("notes.txt")).toBe("alpha original\n");

    setVerification({ ...verification(), verifiedAt: new Date(Date.now() - 25 * 3_600_000).toISOString() });
    expect(await indexProject(db, project)).toMatchObject({ indexed: 1 });
    expect(storedContent("notes.txt")).toBe("alpha modified\n");

    await rewriteInPlace("notes.txt", "alpha replaced\n");
    setVerification({ ...verification(), fingerprint: "rules-before-upgrade" });
    expect(await indexProject(db, project)).toMatchObject({ indexed: 1 });
    expect(storedContent("notes.txt")).toBe("alpha replaced\n");
  });

  it("re-reads a file modified close to its last read", async () => {
    await writeFile(join(root, "fresh.txt"), "first version\n", "utf8");
    await indexProject(db, project);
    await rewriteInPlace("fresh.txt", "later version\n");
    expect(await indexProject(db, project)).toMatchObject({ indexed: 1 });
    expect(storedContent("fresh.txt")).toBe("later version\n");
  });

  it("remembers the new timestamp of a touched file after confirming its content", async () => {
    await writeFile(join(root, "touched.txt"), "same content\n", "utf8");
    await utimes(join(root, "touched.txt"), anHourAgo, anHourAgo);
    await indexProject(db, project);
    const halfAnHourAgo = new Date(Date.now() - 1_800_000);
    await utimes(join(root, "touched.txt"), halfAnHourAgo, halfAnHourAgo);
    expect(await indexProject(db, project)).toMatchObject({ indexed: 0, skipped: 1 });
    expect(db.prepare("SELECT modified_ms FROM sources").pluck().get()).toBe(halfAnHourAgo.getTime());
  });

  it("keeps re-reading redacted files so the protection report stays complete", async () => {
    await writeFile(join(root, "config.txt"), "name=demo\napi_key=abcdefghijklmnopqrstuvwxyz123456\n", "utf8");
    await utimes(join(root, "config.txt"), anHourAgo, anHourAgo);
    await indexProject(db, project);
    await indexProject(db, project);
    expect(readContentProtection(db)?.redacted).toEqual([{ path: "config.txt", lines: [2] }]);
  });
});
