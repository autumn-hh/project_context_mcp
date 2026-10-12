import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { isMainThread } from "node:worker_threads";
import { PACKAGE_VERSION } from "../shared/version.js";

const executeFile = promisify(execFile);
const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();

interface ConnectionRecord {
  pid: number;
  version: string;
  role: string;
  openedAt: string;
  processStartedAt: string;
}

export interface DatabaseHolder {
  pid: number;
  name: string;
  version: string | null;
  roles: string[];
  connectionCount: number | null;
  openedAt: string | null;
  currentProcess: boolean;
  restartRecommended: boolean;
  evidence: Array<"registered" | "operating-system">;
}

export interface DatabaseOccupancy {
  databasePath: string;
  checkedAt: string;
  currentPid: number;
  currentVersion: string;
  holders: DatabaseHolder[];
  operatingSystemProbe: "available" | "unavailable";
  warnings: string[];
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

export function connectionDirectory(databasePath: string): string {
  const path = resolve(databasePath);
  const canonical = process.platform === "win32" ? path.toLowerCase() : path;
  const key = createHash("sha256").update(canonical).digest("hex");
  // Keep volatile connection bookkeeping outside watched project trees. Windows
  // can emit pathless fs.watch events for internal directory/file creation.
  return join(tmpdir(), "project-context-connections", key);
}

/** Project connections only. Never persist command lines, arguments or environment variables. */
export function registerDatabaseConnection(databasePath: string): () => void {
  if (basename(databasePath) !== "project.db" || basename(dirname(databasePath)) !== ".project-context") return () => {};
  const directory = connectionDirectory(databasePath);
  const file = join(directory, `${process.pid}-${randomUUID()}.json`);
  const args = process.argv.slice(1);
  const role = !isMainThread ? "worker" : args.includes("ui") ? "Web"
    : args.some((arg) => /(?:server|mcp)(?:\.[cm]?[jt]s)?$/i.test(arg)) ? "MCP" : "CLI / library";
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(file, JSON.stringify({ pid: process.pid, version: PACKAGE_VERSION, role,
      openedAt: new Date().toISOString(), processStartedAt: PROCESS_STARTED_AT } satisfies ConnectionRecord), { flag: "wx" });
  } catch {
    // Observability must not prevent legitimate database access. OS discovery is the fallback.
    return () => {};
  }
  return () => { try { unlinkSync(file); } catch {} };
}

// Restart Manager queries only handles to these files and includes processes from old builds.
// Do not use RmShutdown or RmRestart: this is a read-only preflight.
const WINDOWS_PROBE = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class ProjectDatabaseHandles {
  [StructLayout(LayoutKind.Sequential)] public struct UniqueProcess { public int pid; public System.Runtime.InteropServices.ComTypes.FILETIME start; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct ProcessInfo {
    public UniqueProcess process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string name;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string service;
    public uint type; public uint status; public uint session; [MarshalAs(UnmanagedType.Bool)] public bool restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] public static extern int RmStartSession(out uint handle, int flags, string key);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] public static extern int RmRegisterResources(uint handle, uint count, string[] files, uint apps, IntPtr processes, uint services, IntPtr names);
  [DllImport("rstrtmgr.dll")] public static extern int RmGetList(uint handle, out uint needed, ref uint count, [In, Out] ProcessInfo[] info, ref uint reasons);
  [DllImport("rstrtmgr.dll")] public static extern int RmEndSession(uint handle);
}
'@
$dbPaths = [string[]]($env:PROJECT_CONTEXT_OCCUPANCY_PATHS | ConvertFrom-Json)
$dbHandle = [uint32]0
$dbCode = [ProjectDatabaseHandles]::RmStartSession([ref]$dbHandle, 0, [guid]::NewGuid().ToString('N'))
if ($dbCode -ne 0) { throw "RmStartSession failed: $dbCode" }
try {
  $dbCode = [ProjectDatabaseHandles]::RmRegisterResources($dbHandle, $dbPaths.Length, $dbPaths, 0, [IntPtr]::Zero, 0, [IntPtr]::Zero)
  if ($dbCode -ne 0) { throw "RmRegisterResources failed: $dbCode" }
  $dbNeeded = [uint32]0; $dbCount = [uint32]0; $dbReasons = [uint32]0
  $dbCode = [ProjectDatabaseHandles]::RmGetList($dbHandle, [ref]$dbNeeded, [ref]$dbCount, $null, [ref]$dbReasons)
  $dbResult = @()
  if ($dbCode -eq 234) {
    for ($dbAttempt = 0; $dbAttempt -lt 3; $dbAttempt++) {
      $dbCount = $dbNeeded
      $dbInfo = New-Object ProjectDatabaseHandles+ProcessInfo[] $dbCount
      $dbCode = [ProjectDatabaseHandles]::RmGetList($dbHandle, [ref]$dbNeeded, [ref]$dbCount, $dbInfo, [ref]$dbReasons)
      if ($dbCode -ne 234) { break }
    }
    if ($dbCode -eq 0) {
      for ($dbIndex = 0; $dbIndex -lt $dbCount; $dbIndex++) {
        $dbProcess = $dbInfo[$dbIndex]
        $dbStart = ([long]$dbProcess.process.start.dwHighDateTime -shl 32) -bor ([long]$dbProcess.process.start.dwLowDateTime -band 4294967295)
        $dbResult += @{ pid = $dbProcess.process.pid; name = $dbProcess.name; startedAt = [DateTime]::FromFileTimeUtc($dbStart).ToString('o') }
      }
    }
  }
  if ($dbCode -ne 0) { throw "RmGetList failed: $dbCode" }
  ConvertTo-Json -Compress -InputObject @($dbResult)
} finally { [void][ProjectDatabaseHandles]::RmEndSession($dbHandle) }
`;

export async function databaseOccupancy(databasePath: string): Promise<DatabaseOccupancy> {
  const report: DatabaseOccupancy = { databasePath: resolve(databasePath), checkedAt: new Date().toISOString(),
    currentPid: process.pid, currentVersion: PACKAGE_VERSION, holders: [], operatingSystemProbe: "unavailable", warnings: [] };
  const holders = new Map<number, DatabaseHolder>();
  const processStarts = new Map<number, string>();
  const directory = connectionDirectory(databasePath);
  try {
    for (const file of readdirSync(directory)) {
      if (!/^\d+-[a-f0-9-]{36}\.json$/i.test(file)) continue;
      try {
        const record = JSON.parse(readFileSync(join(directory, file), "utf8")) as ConnectionRecord;
        if (!Number.isSafeInteger(record.pid) || record.pid < 1 || !record.version || !record.role || !record.processStartedAt || !record.openedAt) throw new Error("Invalid record");
        if (!alive(record.pid)) { try { unlinkSync(join(directory, file)); } catch {} continue; }
        processStarts.set(record.pid, record.processStartedAt);
        const existing = holders.get(record.pid);
        if (existing) {
          existing.connectionCount! += 1;
          if (!existing.roles.includes(record.role)) existing.roles.push(record.role);
          if (record.openedAt < existing.openedAt!) existing.openedAt = record.openedAt;
        } else holders.set(record.pid, { pid: record.pid, name: "Project Context", version: record.version, roles: [record.role],
          connectionCount: 1, openedAt: record.openedAt, currentProcess: record.pid === process.pid,
          restartRecommended: record.version !== PACKAGE_VERSION, evidence: ["registered"] });
      } catch { report.warnings.push("A connection record could not be read; registered-process coverage may be incomplete."); }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") report.warnings.push("Connection registration directory could not be read.");
  }
  if (process.platform === "win32") {
    try {
      const { stdout } = await executeFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_PROBE, "utf16le").toString("base64")],
        { timeout: 12_000, windowsHide: true, maxBuffer: 256 * 1024, env: { ...process.env, PROJECT_CONTEXT_OCCUPANCY_PATHS: JSON.stringify([resolve(databasePath), `${resolve(databasePath)}-wal`, `${resolve(databasePath)}-shm`]) } });
      const processes = JSON.parse(stdout.replace(/^﻿/, "").trim()) as Array<{ pid: number; name: string; startedAt: string }>;
      for (const item of processes) {
        // PID reuse invalidates a crashed process registration. Uptime timestamps have small rounding error.
        if (holders.has(item.pid) && Math.abs(Date.parse(item.startedAt) - Date.parse(processStarts.get(item.pid)!)) > 5000) holders.delete(item.pid);
        const existing = holders.get(item.pid);
        if (existing) { existing.name = item.name; existing.evidence.push("operating-system"); }
        else holders.set(item.pid, { pid: item.pid, name: item.name, version: null, roles: ["未登记进程"], connectionCount: null,
          openedAt: null, currentProcess: item.pid === process.pid, restartRecommended: item.pid !== process.pid, evidence: ["operating-system"] });
      }
      report.operatingSystemProbe = "available";
    } catch { report.warnings.push("操作系统文件占用检查不可用；当前仅显示已登记连接，旧版 MCP/Web 和外部数据库工具可能未列出。"); }
  } else report.warnings.push("当前平台仅显示已登记连接，旧版 MCP/Web 和外部数据库工具可能未列出。");
  report.holders = [...holders.values()].sort((a, b) => a.pid - b.pid);
  report.warnings.push("占用列表是即时快照，文件句柄不代表正在持有写锁；已有连接不会被强制关闭。升级后需重启全部 MCP/Web 进程。");
  return report;
}
