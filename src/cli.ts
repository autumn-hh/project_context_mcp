#!/usr/bin/env node
import { Command, Option } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { isAbsolute, join, resolve } from "node:path";
import { ProjectContextApp } from "./core/app.js";
import { defaultUserStorageRoot, saveGlobalConfig } from "./config/paths.js";
import { ProjectContextError, errorMessage } from "./shared/errors.js";
import { memoryStatusSchema, memoryTypeSchema } from "./memory/memory-service.js";
import { userMemoryScopeSchema, userMemorySourceKindSchema } from "./memory/user-memory-service.js";
import type { TaskCheckpoint } from "./tasks/task-service.js";
import { startUiServer } from "./ui/server.js";
import { DEFAULT_WATCH_DEBOUNCE_MS } from "./indexing/watch-service.js";

const program = new Command()
  .name("project-context")
  .description("Cross-session project intelligence and memory")
  .version("0.8.0")
  .showHelpAfterError();

program.command("init")
  .description("Choose and initialize persistent memory storage")
  .option("--storage <mode-or-path>", "user, project, or an absolute custom path")
  .option("--project-root <path>", "project root used by project storage mode")
  .option("--allow-project-root <paths...>", "absolute roots from which projects may be registered")
  .option("--allow-output-root <paths...>", "absolute roots to which backups and exports may be written")
  .action(async (options: {
    storage?: string;
    projectRoot?: string;
    allowProjectRoot?: string[];
    allowOutputRoot?: string[];
  }) => {
    const storageRoot = await chooseStorage(options.storage, options.projectRoot);
    const config = await saveGlobalConfig(storageRoot, {
      allowedProjectRoots: options.allowProjectRoot ?? [resolve(options.projectRoot ?? process.cwd())],
      allowedOutputRoots: options.allowOutputRoot ?? [storageRoot],
    });
    print({ configured: true, ...config });
  });

const project = program.command("project").description("Register and inspect projects");
project.command("open")
  .argument("<root>", "project root")
  .action(withApp(async (app, root: string) => print(await app.openProject(root))));
project.command("list")
  .option("--include-archived", "include archived projects", false)
  .action(withApp((app, options: { includeArchived: boolean }) => print(app.projects.list(options.includeArchived))));
project.command("update")
  .argument("<project-id>")
  .requiredOption("--name <name>")
  .action(withApp((app, projectId: string, options: { name: string }) => {
    print(app.updateProject(projectId, options.name));
  }));
project.command("archive")
  .argument("<project-id>")
  .action(withApp((app, projectId: string) => print(app.archiveProject(projectId))));
project.command("unarchive")
  .argument("<project-id>")
  .action(withApp((app, projectId: string) => print(app.unarchiveProject(projectId))));
project.command("relocate")
  .argument("<project-id>")
  .argument("<new-root>")
  .action(withApp(async (app, projectId: string, newRoot: string) => {
    print(await app.relocateProject(projectId, newRoot));
  }));
project.command("delete")
  .argument("<project-id>")
  .requiredOption("--confirm <project-id>", "must exactly match the project ID")
  .option("--purge", "permanently delete the archived project database", false)
  .option("--backup <absolute-destination>", "create a final backup before purge")
  .action(withApp(async (app, projectId: string, options: {
    confirm: string; purge: boolean; backup?: string;
  }) => {
    print(await app.deleteProject(projectId, {
      confirmProjectId: options.confirm,
      purge: options.purge,
      ...(options.backup ? { backupDestination: options.backup } : {}),
    }));
  }));
project.command("restore")
  .argument("<source>", "absolute backup database path")
  .option("--root <path>", "authorized project root for a new restored project")
  .option("--name <name>", "name for a new restored project")
  .option("--project-id <id>", "archived project to replace")
  .option("--confirm <id>", "must exactly match --project-id")
  .action(withApp(async (app, source: string, options: {
    root?: string; name?: string; projectId?: string; confirm?: string;
  }) => {
    print(await app.restoreProject({
      source,
      ...(options.root ? { root: options.root } : {}),
      ...(options.name ? { name: options.name } : {}),
      ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(options.confirm ? { confirmProjectId: options.confirm } : {}),
    }));
  }));
project.command("restore-encrypted")
  .argument("<source>", "absolute encrypted backup path")
  .requiredOption("--passphrase-env <name>", "environment variable containing the passphrase")
  .option("--root <path>", "authorized project root for a new restored project")
  .option("--name <name>", "name for a new restored project")
  .option("--project-id <id>", "archived project to replace")
  .option("--confirm <id>", "must exactly match --project-id")
  .action(withApp(async (app, source: string, options: {
    passphraseEnv: string; root?: string; name?: string; projectId?: string; confirm?: string;
  }) => {
    print(await app.encryptedRestore({
      source,
      passphraseEnv: options.passphraseEnv,
      ...(options.root ? { root: options.root } : {}),
      ...(options.name ? { name: options.name } : {}),
      ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(options.confirm ? { confirmProjectId: options.confirm } : {}),
    }));
  }));

program.command("index")
  .argument("<project-id>")
  .action(withApp(async (app, projectId: string) => print(await app.index(projectId))));

program.command("watch")
  .description("Watch a project and incrementally index debounced file changes")
  .argument("<project-id>")
  .option("--debounce <milliseconds>", "debounce interval", numberOption, DEFAULT_WATCH_DEBOUNCE_MS)
  .option("--no-initial-index", "wait for the first file change before indexing")
  .action(async (projectId: string, options: { debounce: number; initialIndex: boolean }) => {
    const app = await ProjectContextApp.create();
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      print(app.watchStop(projectId));
      app.close();
    };
    try {
      print(app.watchStart(projectId, options.debounce, options.initialIndex));
      await new Promise<void>((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
      stop();
    } finally {
      if (!stopped) stop();
    }
  });

program.command("ui")
  .description("Open the localhost rule manager and context preview")
  .option("--port <number>", "localhost port; 0 chooses an available port", numberOption, 0)
  .option("--no-open", "do not open the system browser")
  .action(async (options: { port: number; open: boolean }) => {
    const ui = await startUiServer({ port: options.port, openBrowser: options.open });
    print({
      url: ui.url,
      ...(options.open ? {} : { launchUrl: ui.launchUrl }),
      listeningOn: "127.0.0.1",
    });
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    await ui.close();
  });

program.command("search")
  .argument("<project-id>")
  .argument("<query>")
  .option("--limit <number>", "maximum results", numberOption, 20)
  .action(withApp((app, projectId: string, query: string, options: { limit: number }) => {
    print(app.search(projectId, query, options.limit));
  }));

const memory = program.command("memory").description("Manage long-term project memories");
memory.command("add")
  .argument("<project-id>")
  .requiredOption("--type <type>", memoryTypeSchema.options.join(", "))
  .requiredOption("--title <title>")
  .requiredOption("--content <content>")
  .requiredOption("--source-kind <kind>", "user, file, git, tool, inference, or import")
  .option("--source-ref <reference>")
  .option("--reason <reason>")
  .option("--scope <scope...>")
  .option("--confidence <number>", "0 through 1", numberOption)
  .option("--supersedes <memory-id>")
  .action(withApp((app, projectId: string, options: Record<string, unknown>) => {
    const type = memoryTypeSchema.parse(options.type);
    const confidence = options.confidence as number | undefined;
    if (confidence !== undefined && (confidence < 0 || confidence > 1)) {
      throw new ProjectContextError("INVALID_CONFIDENCE", "Confidence must be between 0 and 1.");
    }
    print(app.remember(projectId, {
      type,
      title: String(options.title),
      content: String(options.content),
      sourceKind: String(options.sourceKind),
      ...(options.sourceRef ? { sourceRef: String(options.sourceRef) } : {}),
      ...(options.reason ? { reason: String(options.reason) } : {}),
      ...(options.scope ? { scope: options.scope as string[] } : {}),
      ...(confidence !== undefined ? { confidence } : {}),
      ...(options.supersedes ? { supersedesId: String(options.supersedes) } : {}),
    }));
  }));
memory.command("list")
  .argument("<project-id>")
  .option("--status <status>", "memory status", "active")
  .option("--limit <number>", "maximum results", numberOption, 50)
  .action(withApp((app, projectId: string, options: { status: string; limit: number }) => {
    print(app.memories(projectId, options.status, options.limit));
  }));
memory.command("status")
  .argument("<project-id>")
  .argument("<memory-id>")
  .addOption(new Option("--set <status>").choices(memoryStatusSchema.options).makeOptionMandatory())
  .action(withApp((app, projectId: string, memoryId: string, options: { set: string }) => {
    print(app.setMemoryStatus(projectId, memoryId, memoryStatusSchema.parse(options.set)));
  }));
memory.command("candidates")
  .argument("<project-id>")
  .option("--status <status>", "pending, accepted, or rejected", "pending")
  .option("--limit <number>", "maximum results", numberOption, 50)
  .action(withApp((app, projectId: string, options: { status: string; limit: number }) => {
    print(app.candidates(projectId, options.status, options.limit));
  }));
memory.command("accept")
  .argument("<project-id>")
  .argument("<candidate-id>")
  .action(withApp((app, projectId: string, candidateId: string) => {
    print(app.acceptCandidate(projectId, candidateId));
  }));
memory.command("reject")
  .argument("<project-id>")
  .argument("<candidate-id>")
  .action(withApp((app, projectId: string, candidateId: string) => {
    print(app.rejectCandidate(projectId, candidateId));
  }));

const userMemory = program.command("user-memory").description("Manage cross-project user memories");
userMemory.command("add")
  .requiredOption("--type <type>", memoryTypeSchema.options.join(", "))
  .requiredOption("--title <title>")
  .requiredOption("--content <content>")
  .requiredOption("--source-kind <kind>", userMemorySourceKindSchema.options.join(", "))
  .addOption(new Option("--scope-level <level>").choices(userMemoryScopeSchema.options).default("user"))
  .option("--project-id <id>")
  .option("--scope-ref <reference>")
  .option("--reason <reason>")
  .option("--confidence <number>", "0 through 1", numberOption)
  .option("--supersedes <memory-id>")
  .action(withApp((app, options: Record<string, unknown>) => {
    print(app.rememberUser({
      type: memoryTypeSchema.parse(options.type),
      title: String(options.title),
      content: String(options.content),
      sourceKind: userMemorySourceKindSchema.parse(options.sourceKind),
      scopeLevel: userMemoryScopeSchema.parse(options.scopeLevel),
      ...(options.projectId ? { projectId: String(options.projectId) } : {}),
      ...(options.scopeRef ? { scopeRef: String(options.scopeRef) } : {}),
      ...(options.reason ? { reason: String(options.reason) } : {}),
      ...(options.confidence !== undefined ? { confidence: Number(options.confidence) } : {}),
      ...(options.supersedes ? { supersedesId: String(options.supersedes) } : {}),
    }));
  }));
userMemory.command("list")
  .option("--status <status>", "memory status", "active")
  .option("--limit <number>", "maximum results", numberOption, 50)
  .action(withApp((app, options: { status: string; limit: number }) => {
    print(app.userMemories(memoryStatusSchema.parse(options.status), options.limit));
  }));
userMemory.command("status")
  .argument("<memory-id>")
  .addOption(new Option("--set <status>").choices(memoryStatusSchema.options).makeOptionMandatory())
  .action(withApp((app, memoryId: string, options: { set: string }) => {
    print(app.setUserMemoryStatus(memoryId, memoryStatusSchema.parse(options.set)));
  }));

const task = program.command("task").description("Manage cross-session task checkpoints");
task.command("start")
  .argument("<project-id>")
  .argument("<goal>")
  .action(withApp((app, projectId: string, goal: string) => print(app.startTask(projectId, goal))));
task.command("list")
  .argument("<project-id>")
  .option("--status <status>", "task status", "in_progress")
  .action(withApp((app, projectId: string, options: { status: string }) => {
    print(app.tasks(projectId, options.status));
  }));
task.command("checkpoint")
  .argument("<project-id>")
  .argument("<task-id>")
  .option("--summary <text>")
  .option("--completed <item...>")
  .option("--next <item...>")
  .option("--changed-file <path...>")
  .option("--blocker <item...>")
  .option("--risk <item...>")
  .action(withApp((app, projectId: string, taskId: string, options: Record<string, unknown>) => {
    print(app.checkpoint(projectId, taskId, checkpointFromOptions(options)));
  }));
task.command("complete")
  .argument("<project-id>")
  .argument("<task-id>")
  .action(withApp((app, projectId: string, taskId: string) => print(app.completeTask(projectId, taskId))));
task.command("cancel")
  .argument("<project-id>")
  .argument("<task-id>")
  .action(withApp((app, projectId: string, taskId: string) => print(app.cancelTask(projectId, taskId))));

program.command("context")
  .argument("<project-id>")
  .argument("<task>")
  .option("--budget <tokens>", "approximate token budget", numberOption, 3_000)
  .action(withApp((app, projectId: string, taskText: string, options: { budget: number }) => {
    print(app.context(projectId, taskText, options.budget));
  }));

program.command("doctor")
  .argument("<project-id>")
  .option("--repair", "rebuild derived FTS indexes when inconsistent", false)
  .action(withApp(async (app, projectId: string, options: { repair: boolean }) => {
    print(await app.doctor(projectId, options.repair));
  }));

program.command("health")
  .argument("<project-id>")
  .action(withApp((app, projectId: string) => print(app.health(projectId))));

program.command("backup")
  .argument("<project-id>")
  .argument("<absolute-destination>")
  .action(withApp(async (app, projectId: string, destination: string) => {
    print(await app.backup(projectId, destination));
  }));

program.command("backup-encrypted")
  .argument("<project-id>")
  .argument("<absolute-destination>")
  .requiredOption("--passphrase-env <name>", "environment variable containing the passphrase")
  .action(withApp(async (app, projectId: string, destination: string, options: { passphraseEnv: string }) => {
    print(await app.encryptedBackup(projectId, destination, options.passphraseEnv));
  }));

program.command("export")
  .argument("<project-id>")
  .argument("<absolute-output-directory>")
  .action(withApp(async (app, projectId: string, outputDirectory: string) => {
    print(await app.export(projectId, outputDirectory));
  }));

program.parseAsync().catch((error: unknown) => {
  if (error instanceof ProjectContextError) {
    console.error(JSON.stringify({ code: error.code, message: error.message, details: error.details ?? null }, null, 2));
  } else {
    console.error(errorMessage(error));
  }
  process.exitCode = 1;
});

function withApp<T extends unknown[]>(
  callback: (app: ProjectContextApp, ...args: T) => void | Promise<void>,
): (...args: T) => Promise<void> {
  return async (...args: T) => {
    const app = await ProjectContextApp.create();
    try {
      await callback(app, ...args);
    } finally {
      app.close();
    }
  };
}

async function chooseStorage(storage?: string, projectRoot?: string): Promise<string> {
  if (storage) return resolveStorage(storage, projectRoot);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new ProjectContextError(
      "STORAGE_SELECTION_REQUIRED",
      "Interactive storage selection is unavailable. Use --storage user, --storage project, or an absolute path.",
    );
  }
  const rl = createInterface({ input, output });
  try {
    output.write([
      "Project Context needs a persistent location for indexes, decisions, constraints, and task checkpoints.",
      "Secrets, .env contents, credentials, and full chat transcripts are excluded by default.",
      "",
      "1. User directory (recommended)",
      `   ${defaultUserStorageRoot()}`,
      "2. Current project directory",
      `   ${join(resolve(projectRoot ?? process.cwd()), ".project-context")}`,
      "3. Custom absolute path",
      "",
    ].join("\n"));
    const answer = (await rl.question("Choose 1, 2, 3, or enter an absolute path: ")).trim();
    if (answer === "1" || answer === "") return defaultUserStorageRoot();
    if (answer === "2") return join(resolve(projectRoot ?? process.cwd()), ".project-context");
    if (answer === "3") return resolveStorage((await rl.question("Custom absolute path: ")).trim(), projectRoot);
    return resolveStorage(answer, projectRoot);
  } finally {
    rl.close();
  }
}

function resolveStorage(storage: string, projectRoot?: string): string {
  if (storage === "user") return defaultUserStorageRoot();
  if (storage === "project") return join(resolve(projectRoot ?? process.cwd()), ".project-context");
  if (!isAbsolute(storage)) {
    throw new ProjectContextError("INVALID_STORAGE_PATH", "Custom storage path must be absolute.");
  }
  return storage;
}

function checkpointFromOptions(options: Record<string, unknown>): TaskCheckpoint {
  return {
    ...(options.summary ? { summary: String(options.summary) } : {}),
    completed: (options.completed as string[] | undefined) ?? [],
    next: (options.next as string[] | undefined) ?? [],
    changedFiles: (options.changedFile as string[] | undefined) ?? [],
    verification: [],
    blockers: (options.blocker as string[] | undefined) ?? [],
    risks: (options.risk as string[] | undefined) ?? [],
  };
}

function numberOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ProjectContextError("INVALID_NUMBER", `Invalid number: ${value}`);
  return parsed;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
