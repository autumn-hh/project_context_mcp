import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ProjectContextError } from "./errors.js";

/**
 * Long-lived MCP and Web processes keep the code they started with. Once the installation is
 * rebuilt or upgraded underneath them, their watchers and index runs would apply old rules to
 * databases a newer build upgraded: an outdated process re-added 2,850 excluded files and
 * replaced the newer relation targets on hrbust_back_new (2026-11-04). Outdated processes
 * therefore pause indexing, and a newly started server stops the servers of older builds so
 * their clients reconnect to the current build.
 */
const executeFile = promisify(execFile);
// Every build rewrites this file, so its modification time identifies the build on disk.
const BUILD_MARKER = fileURLToPath(new URL("./version.js", import.meta.url));
const INSTALLATION_ROOT = dirname(dirname(dirname(BUILD_MARKER)));
const STARTED_BUILD = buildStamp();

function buildStamp(): number | null {
  try {
    return statSync(BUILD_MARKER).mtimeMs;
  } catch {
    // Running from source (tsx, tests) has no build to compare.
    return null;
  }
}

/** Replaceable in tests; production reads the build marker. */
export const processFreshness = {
  codeChanged(): boolean {
    if (STARTED_BUILD === null) return false;
    const current = buildStamp();
    return current !== null && current !== STARTED_BUILD;
  },
};

export function outdatedProcessError(reason = "Project Context was rebuilt or upgraded after this process started."): ProjectContextError {
  return new ProjectContextError("MCP_PROCESS_OUTDATED",
    `${reason} Indexing is paused so old rules cannot rewrite upgraded indexes; restart this MCP or Web connection to use the new version.`);
}

export function isOutdatedProcessError(error: unknown): boolean {
  return error instanceof ProjectContextError && error.code === "MCP_PROCESS_OUTDATED";
}

export interface RunningProcess {
  pid: number;
  startedAt: number;
  commandLine: string;
}

const normalized = (text: string) => text.replaceAll("\\", "/").toLowerCase();

/**
 * Long-lived servers of this installation (the MCP server, `cli.js ui` and `cli.js watch`) that
 * started before the current build and so run older code. Short CLI commands are left alone.
 */
export function selectOutdatedServers(
  processes: readonly RunningProcess[], root: string, currentBuild: number, selfPid: number,
): RunningProcess[] {
  const server = normalized(`${root}/dist/mcp/server.js`);
  const cli = normalized(`${root}/dist/cli.js`);
  return processes.filter((item) => {
    if (item.pid === selfPid || !(item.startedAt < currentBuild - 1_000)) return false;
    const command = normalized(item.commandLine);
    return command.includes(server) || (command.includes(cli) && /\s(?:ui|watch)(?:\s|$)/u.test(command));
  });
}

export async function runningNodeProcesses(): Promise<RunningProcess[]> {
  if (process.platform === "win32") {
    const script = "@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; started = $_.CreationDate.ToUniversalTime().ToString('o'); command = [string]$_.CommandLine } }) | ConvertTo-Json -Compress";
    const { stdout } = await executeFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 15_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    const parsed = JSON.parse(stdout.replace(/^﻿/u, "").trim() || "[]") as Array<{ pid: number; started: string; command: string }>
      | { pid: number; started: string; command: string };
    return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({ pid: item.pid, startedAt: Date.parse(item.started), commandLine: item.command ?? "" }));
  }
  const { stdout } = await executeFile("ps", ["-eo", "pid=,lstart=,args="], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.split("\n").flatMap((line) => {
    // pid, then a five-field start time such as "Wed Nov  4 19:28:13 2026", then the command line.
    const match = line.trim().match(/^(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/u);
    return match && /node/iu.test(match[3]!) ? [{ pid: Number(match[1]), startedAt: Date.parse(match[2]!), commandLine: match[3]! }] : [];
  });
}

/**
 * Stop the long-lived servers of older builds of this installation; their clients reconnect to
 * servers of the current build. Skipped when running from source or when
 * PROJECT_CONTEXT_KEEP_OUTDATED_SERVERS=1.
 */
export async function stopOutdatedServers(): Promise<number[]> {
  if (STARTED_BUILD === null || process.env.PROJECT_CONTEXT_KEEP_OUTDATED_SERVERS === "1") return [];
  const outdated = selectOutdatedServers(await runningNodeProcesses(), INSTALLATION_ROOT, STARTED_BUILD, process.pid);
  const stopped: number[] = [];
  for (const item of outdated) {
    try {
      process.kill(item.pid, "SIGTERM");
      stopped.push(item.pid);
    } catch { /* already gone, or owned by another user */ }
  }
  return stopped;
}

/** Run at server start; reports on stderr, which MCP clients keep in their server logs. */
export async function reportStoppedServers(): Promise<void> {
  try {
    const stopped = await stopOutdatedServers();
    if (stopped.length) console.error(`Stopped Project Context servers running an older build: ${stopped.join(", ")}`);
  } catch (error) {
    console.error(`Could not check for servers running an older build: ${error instanceof Error ? error.message : String(error)}`);
  }
}
