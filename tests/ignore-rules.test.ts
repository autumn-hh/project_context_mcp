import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexProject } from "../src/indexing/indexer.js";
import { openDatabase, type SqliteDatabase } from "../src/storage/database.js";
import { migrateProject } from "../src/storage/schema.js";
import type { ProjectRecord } from "../src/projects/project-service.js";

describe("project ignore rules", () => {
  let root: string;
  let db: SqliteDatabase;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "context-ignore-rules-"));
    db = openDatabase(":memory:");
    migrateProject(db);
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  const indexedPaths = async () => {
    await indexProject(db, { id: "prj_ignore", rootPath: root } as ProjectRecord);
    return db.prepare("SELECT path FROM sources ORDER BY path").pluck().all();
  };

  it("applies .git/info/exclude first so .gitignore can re-include a path", async () => {
    await mkdir(join(root, ".git", "info"), { recursive: true });
    await mkdir(join(root, "old-copy"), { recursive: true });
    await writeFile(join(root, ".git", "info", "exclude"), "/old-copy/\nnotes.txt\n", "utf8");
    await writeFile(join(root, ".gitignore"), "!notes.txt\n", "utf8");
    await writeFile(join(root, "old-copy", "Main.java"), "class Main {}\n", "utf8");
    await writeFile(join(root, "notes.txt"), "kept\n", "utf8");
    await writeFile(join(root, "app.ts"), "export const kept = true;\n", "utf8");
    expect(await indexedPaths()).toEqual([".gitignore", "app.ts", "notes.txt"]);
  });

  it("treats a .git file, as in worktrees and submodules, as having no exclude rules", async () => {
    await writeFile(join(root, ".git"), "gitdir: ../main/.git/worktrees/feature\n", "utf8");
    await writeFile(join(root, "app.ts"), "export const kept = true;\n", "utf8");
    expect(await indexedPaths()).toEqual(["app.ts"]);
  });
});
