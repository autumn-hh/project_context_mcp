import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, type SqliteDatabase } from "../src/storage/database.js";
import { migrateProject } from "../src/storage/schema.js";
import { generateVersionControlCandidates } from "../src/memory/candidate-service.js";
import {
  briefVcsState,
  captureVersionControlState,
  detectVersionControlRemote,
  parseVersionControlStatus,
  type VersionControlCommandRunner,
} from "../src/vcs/vcs-service.js";

describe("version control service", () => {
  let tempRoot: string;
  let db: SqliteDatabase;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "project-context-vcs-"));
    db = openDatabase(join(tempRoot, "project.db"));
    migrateProject(db);
  });

  afterEach(async () => {
    db.close();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("captures Mercurial metadata, changes, diff, and remote URL", async () => {
    const run = fixtureRunner({
      "hg root": `${tempRoot}\n`,
      "hg id -i": "abc123+\n",
      "hg branch": "default\n",
      "hg paths default": "ssh://example.test/repository\n",
      "hg status": "M README.md\n? notes.txt\n",
      "hg diff --git -U 1": "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n # Project\n+Decision: local context must remain private.\n",
    });

    const snapshot = await captureVersionControlState(db, tempRoot, run);

    expect(snapshot).toMatchObject({
      available: true,
      kind: "hg",
      revision: "abc123",
      branch: "default",
      remoteUrl: "ssh://example.test/repository",
      changes: [
        { status: "M", path: "README.md" },
        { status: "?", path: "notes.txt" },
      ],
    });
    expect(snapshot.diffHash).toMatch(/^[a-f0-9]{64}$/);
    expect(state(db)).toMatchObject({ provider: "hg", revision: "abc123", branch: "default" });
    expect(await detectVersionControlRemote(tempRoot, run)).toBe("ssh://example.test/repository");
  });

  it("captures Subversion metadata and creates SVN-sourced review candidates", async () => {
    const diff = "Index: README.md\n--- README.md\t(revision 12)\n+++ README.md\t(working copy)\n@@ -1 +1,2 @@\n # Project\n+Decision: project memory must remain local.\n";
    const run = fixtureRunner({
      "svn info --show-item wc-root .": `${tempRoot}\n`,
      "svn info --show-item revision .": "12\n",
      "svn info --show-item relative-url .": "^/trunk\n",
      "svn info --show-item url .": "https://svn.example.test/repository/trunk\n",
      "svn status --ignore-externals .": "M       README.md\n?       notes.txt\n",
      "svn diff --internal-diff .": diff,
    });

    const snapshot = await captureVersionControlState(db, tempRoot, run);
    const candidates = generateVersionControlCandidates(db, snapshot);

    expect(snapshot).toMatchObject({
      available: true,
      kind: "svn",
      revision: "12",
      branch: "trunk",
      changes: [
        { status: "M", path: "README.md" },
        { status: "?", path: "notes.txt" },
      ],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      sourceKind: "svn",
      sourceRef: "12:README.md",
      evidence: { path: "README.md", changeCount: 1 },
    });
  });

  it("clears persisted state when no supported version control is detected", async () => {
    const snapshot = await captureVersionControlState(db, tempRoot, async () => {
      throw new Error("command unavailable");
    });

    expect(snapshot).toMatchObject({ available: false, kind: null, changes: [] });
    expect(state(db)).toMatchObject({ available: "false", provider: "", revision: "", status: "[]" });
  });

  it("briefs a large change list for responses, keeping the total and small states unchanged", () => {
    const changes = Array.from({ length: 5_000 }, (_, i) => ({ status: "M", path: `src/generated/file-${i}.ts` }));
    const state = { head: "abc", branch: "main", status: JSON.stringify(changes), available: "true" };
    const brief = briefVcsState(state);
    expect(JSON.parse(brief.status!)).toEqual(changes.slice(0, 50));
    expect(brief).toMatchObject({ head: "abc", branch: "main", changeCount: "5000", statusTruncated: "true" });
    expect(JSON.stringify(brief).length).toBeLessThan(6_000);
    const small = { ...state, status: JSON.stringify(changes.slice(0, 50)) };
    expect(briefVcsState(small)).toBe(small);
    expect(briefVcsState({ head: "abc" })).toEqual({ head: "abc" });
    const unreadable = { status: "not json" };
    expect(briefVcsState(unreadable)).toBe(unreadable);
    expect(state.status).toBe(JSON.stringify(changes));
  });

  it("parses Git, Mercurial, and Subversion status formats", () => {
    expect(parseVersionControlStatus("git", "R  old.md -> docs/new.md\n?? todo.txt\n"))
      .toEqual([{ status: "R", path: "docs/new.md" }, { status: "??", path: "todo.txt" }]);
    expect(parseVersionControlStatus("hg", "! removed.txt\nA added.txt\n"))
      .toEqual([{ status: "!", path: "removed.txt" }, { status: "A", path: "added.txt" }]);
    expect(parseVersionControlStatus("svn", "D       removed.txt\nStatus against revision: 12\n"))
      .toEqual([{ status: "D", path: "removed.txt" }]);
  });
});

function fixtureRunner(outputs: Record<string, string>): VersionControlCommandRunner {
  return async (command, args) => {
    const key = `${command} ${args.join(" ")}`;
    if (!(key in outputs)) throw new Error(`Unexpected command: ${key}`);
    return outputs[key]!;
  };
}

function state(db: SqliteDatabase): Record<string, string> {
  const rows = db.prepare("SELECT key, value FROM git_state").all() as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}
