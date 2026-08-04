# Project Context MCP

**English** | [中文](README.md)

Project Context MCP is a local-first, cross-session project intelligence and memory server for coding agents. It incrementally indexes project text and code, stores sourced decisions and constraints, persists task checkpoints, and assembles task-focused context through MCP.

## Personal Storage Capabilities (v0.8.0)

- User-selected persistent storage; no silent MCP-side initialization
- Project registry shared across Codex, Claude Code, Cursor, and other MCP clients
- Project databases stored with their projects at `<project>/.project-context/project.db`
- SQLite WAL databases with hybrid FTS5, Unicode n-gram, and code-relationship search
- Coverage-normalized n-gram ranking merged with FTS results and exact symbol-name boosts
- Directory-pruned `.gitignore` and `.project-context-ignore` aware incremental indexing
- Per-project index locking, MCP cancellation, and progress notifications
- Deferred legacy n-gram migrations with cancellable, bounded-transaction rebuilds during `project_index`
- Root-aware pruning of Codex runtime sessions, caches, logs, attachments, and local secret stores
- Indexed chunk foreign keys for predictable source cleanup on large existing databases
- Default exclusion of `.env`, credentials, private keys, databases, binaries, generated folders, and large files
- Default exclusion of `.d` dependency files, `.o/.obj` objects, `.a/.lib` static libraries, bytecode, compiler caches, and coverage/profiling artifacts
- Tree-sitter symbol indexing for TypeScript, TSX, JavaScript, JSX, MJS, and CJS
- Import, call, extends, and implements relationships included in search and task context
- Automatic Git, Mercurial (hg), and Subversion (svn) detection with revision, branch, working-copy status, and diff-hash evidence without persisting full diffs
- Reviewable memory candidates from Git, Mercurial, and Subversion changes, indexed knowledge documents, and completed task checkpoints
- Stable candidate deduplication and document-candidate superseding across version-controlled and unversioned projects
- File-source bindings that mark active memories stale when their evidence changes or disappears
- Paragraph fingerprints that keep file memories active when unrelated parts of a large file change
- Structured memory types and lifecycle states, including superseding decisions
- Native user memories with `user`, `workspace`, `project`, `module`, and `task` scopes
- Cross-session tasks and checkpoints
- Local-workbench actions for candidate review, stale-memory cleanup, task completion/cancellation, indexing, and watcher control
- Task-ranked `project_context` assembly with related code symbols and a strictly enforced token budget
- Task-relevant scoped constraints while retaining project-wide constraints with an empty scope
- Deterministic local quality evaluation for retrieval, context selection, memory candidates, and latency
- Explicit project and output root allowlists with symlink-aware output validation
- Structured MCP tool results, output schemas, resources, resource templates, and workflow prompts
- Versioned in-place database migrations, integrity diagnosis, FTS repair, backup, and JSONL export
- Validated restore into a new project or an explicitly confirmed archived project
- Project rename, archive, unarchive, relocation, previewed deletion, and guarded purge
- MCP-managed initial synchronization and process-lifetime tracking with read and task-finalization flushes
- Streaming AES-256-GCM encrypted backup and restore with scrypt-derived keys
- Secure localhost project workspace with project portraits, scoped user rules, and assembled-context preview
- CLI and stdio MCP server built on the same Core

LSP, embeddings, a management UI, remote storage, and team synchronization remain deferred.

## Requirements

- Node.js 22 or newer
- npm 10 or newer

## Install And Build

```powershell
npm install
npm run typecheck
npm test
npm run build
npm run eval
npm run benchmark
```

## Quality Evaluation

`npm run eval` creates isolated temporary projects and measures deterministic English and CJK document
retrieval, exact code-symbol retrieval, active-memory retrieval, scoped context selection, candidate-memory
precision and recall, token-budget compliance, and local latency. It exits non-zero when a quality threshold
is missed. No network service, embedding model, or external project data is used.

`npm run benchmark` runs 100 query and context iterations and prints timing-only JSON. Latency values are
machine-dependent and should be compared on the same host without competing workloads; quality metrics are
the portable regression gate.

The captured reports are stored in `docs/baselines/v0.3.1.json` and `docs/baselines/v0.4.0.json`. On the deterministic fixture,
v0.4.0 improves search MRR from `0.707` to `0.900`, Top-1 recall from `0.600` to `0.800`, and selected-memory
precision from `0.667` to `1.000`, while preserving Recall@5, required-memory recall, candidate precision,
candidate recall, and candidate type accuracy at `1.000`.

## Choose Memory Storage

Run the interactive initializer:

```powershell
node dist/cli.js init
```

It chooses where shared registry data and recovery backups are stored. Project databases themselves always
live at `<project>/.project-context/project.db`. The initializer offers:

1. User directory, recommended: `%USERPROFILE%\.project-context`
2. Current project: `<project>\.project-context`
3. A custom absolute path

For automation:

```powershell
node dist/cli.js init --storage user --allow-project-root D:\project
node dist/cli.js init --storage project --project-root D:\project\my-app
node dist/cli.js init --storage D:\ProjectMemory --allow-project-root D:\project --allow-output-root D:\ProjectMemory
```

`PROJECT_CONTEXT_HOME` overrides the shared registry and recovery location for temporary or isolated environments.
When using it, configure semicolon-separated `PROJECT_CONTEXT_ALLOWED_ROOTS` and
`PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS` on Windows (`:`-separated on POSIX). Existing registered
projects remain usable after upgrading; registering a new project requires an allowed root.

## CLI Workflow

```powershell
# Register a project and retain the returned project ID
node dist/cli.js project open D:\project\my-app

# Incrementally index it
node dist/cli.js index <project-id>

# Or keep an explicit process-lifetime watcher running
node dist/cli.js watch <project-id> --debounce 300

# Open the local rule manager in the system browser
node dist/cli.js ui

# Search indexed content, symbols, and active memories
node dist/cli.js search <project-id> "refresh token"

# Review sourced candidates after indexing documents or completing tasks
node dist/cli.js memory candidates <project-id>
node dist/cli.js memory accept <project-id> <candidate-id>

# Cancel obsolete cross-session work while retaining its latest checkpoint
node dist/cli.js task cancel <project-id> <task-id>

# Store a sourced decision
node dist/cli.js memory add <project-id> `
  --type decision `
  --title "Rotate refresh tokens" `
  --content "Refresh tokens rotate after every successful use." `
  --source-kind user

# Store a preference shared across projects
node dist/cli.js user-memory add `
  --type preference `
  --title "Test runner" `
  --content "Prefer Vitest for TypeScript projects." `
  --source-kind user `
  --scope-level user

# Start and later resume a task
node dist/cli.js task start <project-id> "Implement token reuse detection"
node dist/cli.js task checkpoint <project-id> <task-id> `
  --completed "Added token family" `
  --next "Add reuse test" `
  --changed-file "src/auth/auth.service.ts"

# Assemble context for a new session
node dist/cli.js context <project-id> "Continue token reuse detection"

# Diagnose and repair derived FTS indexes
node dist/cli.js doctor <project-id> --repair

# Create durable operational copies; destinations must be absolute and new/empty
node dist/cli.js backup <project-id> D:\ProjectMemoryBackups\my-app.db
node dist/cli.js export <project-id> D:\ProjectMemoryExports\my-app

# Keep the passphrase out of command history and process arguments
$env:PROJECT_CONTEXT_BACKUP_PASSPHRASE = "<a strong private passphrase>"
node dist/cli.js backup-encrypted <project-id> D:\ProjectMemoryBackups\my-app.pcmb `
  --passphrase-env PROJECT_CONTEXT_BACKUP_PASSPHRASE
node dist/cli.js project restore-encrypted D:\ProjectMemoryBackups\my-app.pcmb `
  --passphrase-env PROJECT_CONTEXT_BACKUP_PASSPHRASE `
  --root D:\project\restored-app
```

Project deletion is deliberately two-step. Archive first, call `project delete` without `--purge` to inspect
the counts, then purge with an exact project-ID confirmation. Purge is blocked while active memories,
in-progress tasks, or pending candidates remain. A missing project directory never causes automatic deletion.

## Local Rule Manager

`project-context ui` starts an ephemeral HTTP server bound only to `127.0.0.1`, chooses an available port,
and opens the system browser. Its project portrait summarizes indexing health, code intelligence, file types,
Git state, memories, candidates, tasks, and primary indexed sources. It can run incremental indexing, control
the process-lifetime watcher, review candidates, clean up stale memories, and close historical tasks. The index
filter editor provides common-rule shortcuts, Windows-path normalization, and a read-only impact preview before
atomically saving `.project-context-ignore` and immediately updating the index. The UI also manages `user`,
`workspace`, `project`, `module`, and `task` scoped rules.

### One-click startup on Windows

Double-click [`start-web.cmd`](start-web.cmd) in the repository root to start the local workbench and open the
system browser. The launcher resolves the project directory from its own location. If `dist/cli.js` does not
exist yet, it builds the project using the installed dependencies; first-time setup still requires running
`npm install` once in the repository.

For a desktop entry, right-click `start-web.cmd` and choose **Send to > Desktop (create shortcut)**. Keep the
command window open while using the workbench. Press `Ctrl+C` or close the window to stop the service. Do not
bookmark a full URL from a previous launch: its port and launch token belong to that server process. Use the
launcher again for each new session.

### One-click startup on macOS

Double-click [`start-web.command`](start-web.command) in the repository root to start the local workbench and
open the default browser. The launcher recognizes the common Apple Silicon and Intel Homebrew Node.js paths
and, like the Windows launcher, builds from the installed dependencies when `dist/cli.js` is missing.

If the file is not executable, run `chmod +x start-web.command` once in Terminal. If macOS blocks the first
launch, Control-click the file in Finder, choose **Open**, and confirm. Keep the Terminal window open while the
workbench is running; press `Control+C` or close the window to stop the service. First-time setup still requires
one `npm install` in the repository. Do not bookmark the temporary full URL from a launch.

The portrait includes an interactive Cytoscape.js relationship graph. Its file-level view aggregates project
dependencies without sending every raw relation to the browser; selecting or searching a file or symbol can
expand one or two symbol neighborhoods on demand. Nodes are draggable, and the canvas supports pan, zoom,
fit, force-directed, layered, and circular layouts. `IMPORTS`, `CALLS`, `EXTENDS`, and `IMPLEMENTS` relations
can be filtered independently, while node details remain tied to indexed source paths and line numbers.
Editing an active rule creates a new version and marks the previous version `superseded`; stopping a rule uses
the auditable `deleted` lifecycle state rather than physically deleting it. Superseded history cannot be
reactivated into a second active version.

The context-preview view runs the real `project_context` pipeline for a selected project and simulated task.
It shows the selected user rules, project constraints and decisions, active task checkpoints, indexed evidence,
warnings, and actual token-budget usage.

The browser session uses a random launch token exchanged for an `HttpOnly`, `SameSite=Strict` cookie. API
requests validate `Host`, same-origin state-changing requests, a custom UI header, JSON schemas, and a 64 KiB
body limit. The server sends a restrictive Content Security Policy and never listens on `0.0.0.0`. Use
`project-context ui --no-open` only for automation; it prints the one-time launch URL to the terminal.

## Beginner Setup: Connect an MCP Client and Initialize Projects Automatically

Project Context MCP is not tied to one AI client. Codex, Claude Code, Cursor, and any other client that supports stdio MCP can connect to the same local project data.

“Default startup” has two layers: register the MCP server in the client you use, then add a client-level global instruction that tells it to call `project_open` and `project_context` during the first task in a repository. `project_open` performs the initial or incremental index and starts change tracking inside MCP, so clients do not need separate `project_index` or `project_watch_start` instructions. Merely opening a client without starting a task does not scan disks in the background.

### Step 1: Install and build

```powershell
git clone https://github.com/hh357418341-create/project_context_mcp.git D:\tools\project-context-mcp
cd D:\tools\project-context-mcp
npm install
npm run typecheck
npm test
npm run build
```

Node.js 22 or newer is required. Replace the installation and project-root paths below with your own absolute paths.

### Step 2: Initialize personal storage once

Windows:

```powershell
node dist/cli.js init --storage user --allow-project-root D:\project
```

macOS/Linux:

```bash
node dist/cli.js init --storage user --allow-project-root "$HOME/code"
```

Run this step only once. `--allow-project-root` defines the security boundary for projects that may be registered; add more absolute roots to the same command when needed. The MCP never silently chooses a storage directory.

### Step 3: Add the MCP to your client

Configure only the clients you actually use.

#### Codex

Using the Codex CLI is recommended because it avoids hand-editing TOML:

```powershell
codex mcp add project-context -- node D:/tools/project-context-mcp/dist/mcp/server.js
codex mcp get project-context
```

`codex mcp get project-context` should report `enabled: true`. Alternatively, edit `~/.codex/config.toml` manually:

```toml
[mcp_servers.project-context]
type = "stdio"
command = "node"
args = ["D:/tools/project-context-mcp/dist/mcp/server.js"]
```

If `node` is not on `PATH`, use the absolute path to the Node executable as `command`. Restart Codex or begin a new session after changing the configuration.

#### Claude Code

Use user scope to make the server available across the current user's Claude Code projects:

```powershell
claude mcp add --scope user project-context -- node D:/tools/project-context-mcp/dist/mcp/server.js
claude mcp get project-context
```

For another stdio MCP client, set the command to `node` and the argument to the absolute path of the built `dist/mcp/server.js` file.

### Step 4: Add a global client instruction

Create or edit the file used by your client:

- Codex: `%USERPROFILE%\.codex\AGENTS.md` on Windows or `~/.codex/AGENTS.md` on macOS/Linux;
- Claude Code: `%USERPROFILE%\.claude\CLAUDE.md` on Windows or `~/.claude/CLAUDE.md` on macOS/Linux;
- Cursor or another client: add the block to its global User Rules rather than only to one repository's local rules.

Add the following startup rules. If the file already contains personal instructions, append this block instead of replacing the file.

```markdown
<!-- project-context-mcp:start -->
# Cross-session Project Context (project-context-mcp)

Use project-context-mcp to retain sourced project knowledge across AI coding sessions.

## Session Workflow
1. At the beginning of the first user turn in a repository, call `storage_status`.
2. Call `project_open` with the repository's absolute root path and reuse the returned project ID. The MCP server synchronizes the index and manages change tracking for the current process.
3. Before substantial implementation work, call `project_context` with the current task.
4. Use `project_search` for indexed text, symbols, memories, and code relationships instead of guessing. Managed pending changes are flushed before reads.
5. For non-trivial work, call `task_start`, save progress with `task_checkpoint`, and call `task_complete` when finished. Completion flushes pending project changes.

## Memory Rules
- Review `memory_candidates` after indexing Git changes. Accept or reject candidates explicitly; never accept them automatically.
- Use `memory_remember` only for durable decisions, constraints, lessons, or facts with a clear source.
- Never store credentials, private keys, tokens, full chat transcripts, or full Git diffs.
- Run `project_doctor` when stored context appears incomplete or inconsistent.
<!-- project-context-mcp:end -->
```

The bootstrap workflow belongs in a user-level global instruction that the client reads before starting a task, not only in the Project Context workbench's global rules. Workbench rules are returned only after `project_context` has already been called, so they cannot bootstrap the first MCP calls.

### Step 5: Verify first-project initialization

Open a repository under an allowed root that has not been registered before, start the configured MCP client, and send the first normal task message. The global instructions should make the client call:

```text
storage_status
project_open
project_context
```

Expected results:

- `project_open` returns a stable `prj_...` project ID;
- `.project-context/project.db` appears in the repository;
- `project_open` completes the initial or incremental index and starts managed change tracking for the MCP process;
- `project_context` returns memories, rules, task checkpoints, and indexed evidence relevant to the current task.

Add `.project-context/` to the repository's `.gitignore`. If the repository is outside the roots allowed during storage initialization, `project_open` refuses to register it; rerun `init` and explicitly add the correct root.

### Managed indexing is not a permanent background service

The client starts the server from its MCP configuration and follows its global instructions to call `project_open` during the session's first task. MCP completes an incremental index and starts a process-lifetime watcher for that project. `project_search`, `project_context`, `task_complete`, and `task_cancel` flush pending changes before continuing. Restarting the client or MCP process discards the old watcher, while the next `project_open` synchronizes and starts a new one. CLI workflows retain explicit `index` and `watch` controls.

For client-specific configuration, see the official Codex documentation for [MCP](https://developers.openai.com/codex/mcp/) and [Customization / AGENTS.md](https://developers.openai.com/codex/concepts/customization/), or the Claude Code [MCP](https://docs.anthropic.com/en/docs/claude-code/mcp) documentation.

## MCP Tools (35)

- `storage_status`
- `project_open`, `project_list`, `project_update`, `project_archive`, `project_unarchive`, `project_relocate`
- `project_delete`, `project_restore`, `project_restore_encrypted`
- `project_index`, `project_search`, `project_context`, `project_health`
- `project_watch_start`, `project_watch_stop`, `project_watch_list`
- `project_doctor`, `project_backup`, `project_backup_encrypted`, `project_export`
- `memory_remember`, `memory_list`, `memory_update_status`
- `memory_candidates`, `memory_candidate_accept`, `memory_candidate_reject`
- `user_memory_remember`, `user_memory_list`, `user_memory_update_status`
- `task_start`, `task_checkpoint`, `task_list`, `task_complete`, `task_cancel`

`project_index` returns symbol/relation totals, stale memory IDs, newly generated candidates, and Git metadata. The indexer and watcher skip common cross-language compiler artifacts, including C/C++ `.d` dependency files, `.o/.obj` objects, `.a/.lib` static libraries, precompiled headers, Java/Python bytecode, and coverage or profiling output. Git evidence is preferred when available; projects without Git can still generate candidates from added or changed indexed knowledge documents. Each completed task generates at most one candidate, preferring its summary, then its first risk, then its first explicitly durable completed item, so routine execution records do not become multiple review items. It never returns or stores the full diff. Candidate memories remain review-only until `memory_candidate_accept` is called.

Opening a database created before schema v4 only creates the n-gram table and returns immediately. Existing
content is rebuilt in small committed batches during the next `project_index`, where MCP cancellation and
progress reporting remain active. An interrupted rebuild stays marked incomplete and is safely retried by a
later index run. `project_doctor` reports this state and can also repair it explicitly.

Schema v5 adds an index on `chunks(source_id)`. This keeps source removal and foreign-key checks proportional
to the affected chunks instead of repeatedly scanning the entire chunk table.

Project schema v6 adds paragraph excerpts and excerpt hashes to file-source memory bindings. When a whole-file
hash changes but the normalized source paragraph still exists, the binding refreshes its file hash and line
range and remains active. A changed or missing paragraph becomes `stale`; legacy bindings without an excerpt
retain conservative whole-file invalidation. Registry schema v2 adds project archival state and user memories.

MCP `project_open` synchronizes the index and starts controlled change tracking automatically. Explicit
`project_watch_start`, `project_watch_stop`, and `project_index` tools remain available for diagnostics and
manual control. The watcher ignores internal databases, VCS metadata, dependencies, and common build output,
debounces other events, and runs the same incremental index. It never accepts candidates and is released when
the MCP connection closes.

Encrypted backups use a versioned authenticated format with a random salt and IV, scrypt key derivation, and
AES-256-GCM. MCP and CLI calls accept only an environment-variable name (`passphraseEnv`), never a raw
passphrase. The passphrase is not stored, so losing it makes the backup unrecoverable. Plaintext temporary
backup files are removed after success or failure.

When the registered project root itself is named `.codex`, runtime-only directories such as `sessions`,
`.tmp`, `plugins/cache`, logs, attachments, SQLite state, and secret stores are excluded automatically.
Directories with the same names remain indexable in ordinary application repositories.

All tools return both backward-compatible JSON TextContent and validated `structuredContent`.

## MCP Resources And Prompts

- Static project registry: `project-context://projects`
- Templates for project health, individual memories, tasks, and indexed sources
- `resume-project-task` prompt for task-focused context and checkpoints
- `review-memory-candidates` prompt for explicit candidate review

## Storage Layout

```text
<storage-root>/
├── registry.db
└── recovery/
    └── <project-id>-<timestamp>.db

<project-root>/
└── .project-context/
    └── project.db
```

`registry.db` contains project registrations and user-level memories. Per-project databases contain indexes,
project memories, candidate audit records, and task checkpoints. The recovery directory receives an internal
safety backup before an archived project database is overwritten or a legacy central database is migrated.
Registry schema v3 migrates existing `<storage-root>/projects/<project-id>/project.db` files into their registered
project roots after taking a validated recovery snapshot. `.project-context/` is always excluded from indexing
and is included in the repository `.gitignore`. Full chat transcripts, full Git diffs,
detected secret values, and encryption passphrases are not stored.
