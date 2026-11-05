import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SqliteDatabase } from "../storage/database.js";
import { nowIso, sha256 } from "../shared/ids.js";

const execFileAsync = promisify(execFile);

export type VersionControlKind = "git" | "hg" | "svn";

export interface VersionControlChange {
  status: string;
  path: string;
}

export interface VersionControlSnapshot {
  available: boolean;
  kind: VersionControlKind | null;
  revision: string | null;
  branch: string | null;
  remoteUrl: string | null;
  changes: VersionControlChange[];
  diff: string;
  diffHash: string | null;
  capturedAt: string;
}

const BRIEF_CHANGES = 50;

/** The stored state for responses that must stay small: the first changes only, with their total. */
export function briefVcsState(state: Record<string, string>): Record<string, string> {
  let changes: unknown;
  try { changes = JSON.parse(state.status ?? "[]"); } catch { return state; }
  if (!Array.isArray(changes) || changes.length <= BRIEF_CHANGES) return state;
  return { ...state, status: JSON.stringify(changes.slice(0, BRIEF_CHANGES)), changeCount: String(changes.length), statusTruncated: "true" };
}

export type VersionControlCommandRunner = (
  command: VersionControlKind,
  args: string[],
  rootPath: string,
) => Promise<string>;

export async function captureVersionControlState(
  db: SqliteDatabase,
  rootPath: string,
  run: VersionControlCommandRunner = runCommand,
): Promise<VersionControlSnapshot> {
  const capturedAt = nowIso();
  const kind = await detectVersionControl(rootPath, run);
  const snapshot = kind
    ? await capture(kind, rootPath, capturedAt, run)
    : emptySnapshot(capturedAt);
  persistSnapshot(db, snapshot);
  return snapshot;
}

export async function detectVersionControlRemote(
  rootPath: string,
  run: VersionControlCommandRunner = runCommand,
): Promise<string | null> {
  const kind = await detectVersionControl(rootPath, run);
  if (!kind) return null;
  const args = kind === "git"
    ? ["remote", "get-url", "origin"]
    : kind === "hg"
      ? ["paths", "default"]
      : ["info", "--show-item", "url", "."];
  return (await run(kind, args, rootPath).catch(() => "")).trim() || null;
}

export async function detectVersionControl(
  rootPath: string,
  run: VersionControlCommandRunner = runCommand,
): Promise<VersionControlKind | null> {
  const probes: Array<[VersionControlKind, string[]]> = [
    ["git", ["rev-parse", "--is-inside-work-tree"]],
    ["hg", ["root"]],
    ["svn", ["info", "--show-item", "wc-root", "."]],
  ];
  for (const [kind, args] of probes) {
    const output = await run(kind, args, rootPath).catch(() => "");
    if (kind === "git" ? output.trim() === "true" : Boolean(output.trim())) return kind;
  }
  return null;
}

async function capture(
  kind: VersionControlKind,
  rootPath: string,
  capturedAt: string,
  run: VersionControlCommandRunner,
): Promise<VersionControlSnapshot> {
  const commands = commandSet(kind);
  const [revision, branch, remoteUrl, status, diff] = await Promise.all([
    run(kind, commands.revision, rootPath).catch(() => ""),
    run(kind, commands.branch, rootPath).catch(() => ""),
    run(kind, commands.remote, rootPath).catch(() => ""),
    run(kind, commands.status, rootPath).catch(() => ""),
    run(kind, commands.diff, rootPath).catch(() => ""),
  ]);
  const normalizedDiff = diff.trimEnd();
  return {
    available: true,
    kind,
    revision: normalizeRevision(kind, revision),
    branch: normalizeBranch(kind, branch),
    remoteUrl: remoteUrl.trim() || null,
    changes: parseVersionControlStatus(kind, status),
    diff: normalizedDiff,
    diffHash: normalizedDiff ? sha256(normalizedDiff) : null,
    capturedAt,
  };
}

function commandSet(kind: VersionControlKind): {
  revision: string[]; branch: string[]; remote: string[]; status: string[]; diff: string[];
} {
  if (kind === "git") {
    return {
      revision: ["rev-parse", "HEAD"],
      branch: ["branch", "--show-current"],
      remote: ["remote", "get-url", "origin"],
      status: ["status", "--porcelain=v1", "--untracked-files=all"],
      diff: ["diff", "HEAD", "--no-ext-diff", "--unified=1", "--", ":(exclude)*.lock"],
    };
  }
  if (kind === "hg") {
    return {
      revision: ["id", "-i"],
      branch: ["branch"],
      remote: ["paths", "default"],
      status: ["status"],
      diff: ["diff", "--git", "-U", "1"],
    };
  }
  return {
    revision: ["info", "--show-item", "revision", "."],
    branch: ["info", "--show-item", "relative-url", "."],
    remote: ["info", "--show-item", "url", "."],
    status: ["status", "--ignore-externals", "."],
    diff: ["diff", "--internal-diff", "."],
  };
}

export function parseVersionControlStatus(
  kind: VersionControlKind,
  value: string,
): VersionControlChange[] {
  return value.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    if (kind === "git") {
      const status = line.slice(0, 2).trim() || "?";
      const rawPath = line.slice(3).trim();
      const path = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1)! : rawPath;
      return [{ status, path: normalizePath(path) }];
    }
    if (kind === "hg") {
      const path = line.slice(2).trim();
      return path ? [{ status: line[0]?.trim() || "?", path: normalizePath(path) }] : [];
    }
    if (/^Status against revision:/i.test(line)) return [];
    const path = line.length > 8 ? line.slice(8).trim() : "";
    return path ? [{ status: line.slice(0, 7).trim() || "?", path: normalizePath(path) }] : [];
  });
}

function normalizeRevision(kind: VersionControlKind, value: string): string | null {
  const revision = value.trim();
  if (!revision) return null;
  return kind === "hg" ? revision.replace(/\+$/, "") || null : revision;
}

function normalizeBranch(kind: VersionControlKind, value: string): string | null {
  const branch = value.trim();
  if (!branch) return null;
  return kind === "svn" ? branch.replace(/^\^\//, "") || "/" : branch;
}

function normalizePath(path: string): string {
  return path.replace(/^"|"$/g, "").replaceAll("\\", "/");
}

function emptySnapshot(capturedAt: string): VersionControlSnapshot {
  return {
    available: false,
    kind: null,
    revision: null,
    branch: null,
    remoteUrl: null,
    changes: [],
    diff: "",
    diffHash: null,
    capturedAt,
  };
}

function persistSnapshot(db: SqliteDatabase, snapshot: VersionControlSnapshot): void {
  const write = db.prepare(`
    INSERT INTO git_state (key, value, captured_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, captured_at = excluded.captured_at
  `);
  const values: Record<string, string> = {
    available: String(snapshot.available),
    provider: snapshot.kind ?? "",
    revision: snapshot.revision ?? "",
    head: snapshot.revision ?? "",
    branch: snapshot.branch ?? "",
    remote_url: snapshot.remoteUrl ?? "",
    status: JSON.stringify(snapshot.changes),
    diff_hash: snapshot.diffHash ?? "",
  };
  db.transaction(() => {
    for (const [key, value] of Object.entries(values)) write.run(key, value, snapshot.capturedAt);
  })();
}

async function runCommand(command: VersionControlKind, args: string[], rootPath: string): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    cwd: rootPath,
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}
