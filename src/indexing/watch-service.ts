import { watch, type FSWatcher } from "node:fs";
import ignore, { type Ignore } from "ignore";
import { ProjectContextError } from "../shared/errors.js";
import { defaultIgnorePatterns, isCandidateTextFile, isSensitivePath } from "./file-policy.js";

export const DEFAULT_WATCH_DEBOUNCE_MS = 300;

export interface ProjectWatchStatus {
  projectId: string;
  rootPath: string;
  debounceMs: number;
  startedAt: string;
  pending: boolean;
  indexing: boolean;
  lastEventAt: string | null;
  lastIndexAt: string | null;
  lastError: { code: string; message: string; at: string } | null;
}

interface WatchEntry extends ProjectWatchStatus {
  watcher: FSWatcher;
  timer: NodeJS.Timeout | null;
  dirty: boolean;
  run: Promise<void> | null;
  matcher: Ignore;
  changeVersion: number;
  indexedVersion: number;
}

export class ProjectWatchService {
  private readonly entries = new Map<string, WatchEntry>();

  constructor(private readonly runIndex: (projectId: string) => Promise<unknown>) {}

  start(projectId: string, rootPath: string, debounceMs = DEFAULT_WATCH_DEBOUNCE_MS, initialIndex = true): ProjectWatchStatus {
    if (!Number.isInteger(debounceMs) || debounceMs < 100 || debounceMs > 60_000) {
      throw new ProjectContextError("INVALID_WATCH_DEBOUNCE", "Watch debounce must be between 100 and 60000 milliseconds.");
    }
    const existing = this.entries.get(projectId);
    if (existing) return publicStatus(existing);

    let entry: WatchEntry;
    try {
      const matcher = ignore().add(defaultIgnorePatterns(rootPath));
      const watcher = watch(rootPath, { recursive: true }, (_eventType, filename) => {
        if (filename && ignoredWatchPath(matcher, filename.toString())) return;
        entry.lastEventAt = new Date().toISOString();
        entry.dirty = true;
        entry.changeVersion += 1;
        this.schedule(entry);
      });
      entry = {
        projectId,
        rootPath,
        debounceMs,
        startedAt: new Date().toISOString(),
        pending: false,
        indexing: false,
        lastEventAt: null,
        lastIndexAt: null,
        lastError: null,
        watcher,
        timer: null,
        dirty: initialIndex,
        run: null,
        matcher,
        changeVersion: initialIndex ? 1 : 0,
        indexedVersion: 0,
      };
      watcher.on("error", (error) => {
        entry.lastError = { code: "WATCH_ERROR", message: error.message, at: new Date().toISOString() };
      });
      this.entries.set(projectId, entry);
      if (initialIndex) this.schedule(entry, 0);
      return publicStatus(entry);
    } catch (error) {
      throw new ProjectContextError(
        "WATCH_START_FAILED",
        `Unable to watch project root: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  stop(projectId: string): ProjectWatchStatus {
    const entry = this.entries.get(projectId);
    if (!entry) throw new ProjectContextError("WATCH_NOT_FOUND", `Project is not being watched: ${projectId}`);
    if (entry.timer) clearTimeout(entry.timer);
    entry.watcher.close();
    this.entries.delete(projectId);
    return publicStatus(entry);
  }

  list(): ProjectWatchStatus[] {
    return [...this.entries.values()].map(publicStatus);
  }

  async flushPending(projectId: string): Promise<ProjectWatchStatus | null> {
    let entry = this.entries.get(projectId);
    const targetVersion = entry?.changeVersion ?? 0;
    while (entry && entry.indexedVersion < targetVersion) {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      entry.pending = false;
      if (entry.run) {
        await entry.run;
      } else if (entry.dirty) {
        await this.flush(entry);
      } else {
        break;
      }
      entry = this.entries.get(projectId);
      if (entry?.lastError && entry.indexedVersion < targetVersion) {
        throw new ProjectContextError(entry.lastError.code, entry.lastError.message);
      }
    }
    return entry ? publicStatus(entry) : null;
  }

  stopAll(): void {
    for (const projectId of [...this.entries.keys()]) this.stop(projectId);
  }

  private schedule(entry: WatchEntry, delay = entry.debounceMs): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.pending = true;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.flushPending(entry.projectId).catch(() => undefined);
    }, delay);
  }

  private async flush(entry: WatchEntry): Promise<void> {
    if (!this.entries.has(entry.projectId)) return;
    entry.pending = false;
    entry.dirty = false;
    entry.indexing = true;
    const targetVersion = entry.changeVersion;
    entry.run = (async () => {
      try {
        await this.runIndex(entry.projectId);
        entry.indexedVersion = Math.max(entry.indexedVersion, targetVersion);
        entry.lastIndexAt = new Date().toISOString();
        entry.lastError = null;
      } catch (error) {
        const code = error instanceof ProjectContextError ? error.code : "INDEX_FAILED";
        entry.lastError = {
          code,
          message: error instanceof Error ? error.message : String(error),
          at: new Date().toISOString(),
        };
        entry.dirty = true;
      } finally {
        entry.indexing = false;
        entry.run = null;
        entry.dirty ||= entry.indexedVersion < entry.changeVersion;
        if (entry.dirty && this.entries.has(entry.projectId)) this.schedule(entry, entry.lastError?.code === "INDEX_MIGRATION_RUNNING" ? 2000 : entry.debounceMs);
      }
    })();
    await entry.run;
  }
}

function ignoredWatchPath(matcher: Ignore, filename: string): boolean {
  const relativePath = filename.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!relativePath || relativePath.startsWith("../")) return false;
  return matcher.ignores(relativePath)
    || matcher.ignores(`${relativePath.replace(/\/$/, "")}/`)
    || isSensitivePath(relativePath)
    || !isCandidateTextFile(relativePath);
}

function publicStatus(entry: WatchEntry): ProjectWatchStatus {
  return {
    projectId: entry.projectId,
    rootPath: entry.rootPath,
    debounceMs: entry.debounceMs,
    startedAt: entry.startedAt,
    pending: entry.pending,
    indexing: entry.indexing,
    lastEventAt: entry.lastEventAt,
    lastIndexAt: entry.lastIndexAt,
    lastError: entry.lastError,
  };
}
