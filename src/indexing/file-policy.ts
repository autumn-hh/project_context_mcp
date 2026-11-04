import { readFileSync } from "node:fs";
import { extname, basename, join } from "node:path";
import ignore, { type Ignore } from "ignore";
import { sha256 } from "../shared/ids.js";

export const DEFAULT_IGNORE_PATTERNS = [
  // A file in worktrees and submodules, a directory elsewhere.
  ".git",
  ".hg/",
  ".svn/",
  ".project-context/",
  "node_modules/",
  "dist/",
  "build/",
  "out/",
  "target/",
  "CMakeFiles/",
  "cmake-build-*/",
  "coverage/",
  "playwright-report/",
  "test-results/",
  ".playwright-cli/",
  ".next/",
  ".cache/",
  ".gradle/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".pytest_cache/",
  ".mypy_cache/",
  ".ruff_cache/",
  ".tox/",
  "vendor/",
  "*.min.js",
  "*.min.css",
  "*.map",
  "*.lock",
  "package-lock.json",
  ".ninja_deps",
  ".ninja_log",
];

const CODEX_RUNTIME_IGNORE_PATTERNS = [
  ".sandbox/",
  ".sandbox-bin/",
  ".sandbox-secrets/",
  ".tmp/",
  "attachments/",
  "browser/",
  "computer-use/",
  "computer-use-turn-ended/",
  "generated_images/",
  "log/",
  "logs/",
  "mcp-oauth-locks/",
  "node_repl/",
  "plugins/cache/",
  "process_manager/",
  "secrets/",
  "sessions/",
  "sqlite/",
  "tmp/",
  "vendor_imports/",
  "*.jsonl",
  "*.sqlite-*",
  ".codex-global-state.json*",
  "cap_sid",
  "models_cache.json",
];

export function defaultIgnorePatterns(rootPath: string): string[] {
  return basename(rootPath).toLowerCase() === ".codex"
    ? [...DEFAULT_IGNORE_PATTERNS, ...CODEX_RUNTIME_IGNORE_PATTERNS]
    : DEFAULT_IGNORE_PATTERNS;
}

/**
 * Root-level rule files in Git's precedence order: later files win, so .gitignore can re-include
 * what the local exclude file hides. Nested .gitignore files are not read.
 */
export const PROJECT_IGNORE_FILES: readonly string[] = [".git/info/exclude", ".gitignore", ".project-context-ignore"];

/** Default patterns plus the project's root ignore files. The indexer and watcher must share this. */
export function projectIgnoreMatcher(rootPath: string): Ignore {
  const matcher = ignore().add(defaultIgnorePatterns(rootPath));
  for (const fileName of PROJECT_IGNORE_FILES) {
    try {
      matcher.add(readFileSync(join(rootPath, fileName), "utf8"));
    } catch (error) {
      // ENOTDIR: in worktrees and submodules .git is a file; their shared exclude file is not read.
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return matcher;
}

const secretNames = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  "auth.json",
  "credentials.json",
  "secrets.json",
  "id_rsa",
  "id_ed25519",
]);

const secretExtensions = new Set([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"]);
const binaryExtensions = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".7z",
  ".exe", ".dll", ".so", ".dylib", ".wasm", ".db", ".sqlite", ".sqlite3", ".woff", ".woff2",
]);
const generatedArtifactExtensions = new Set([
  // Native toolchains and coverage/profiling output.
  ".o", ".obj", ".a", ".lib", ".lo", ".la", ".pdb", ".ilk", ".exp",
  ".idb", ".iobj", ".ipdb", ".tlog", ".res", ".pch", ".gch", ".dwo", ".dwp",
  ".bc", ".pcm", ".ifc", ".mod", ".smod",
  ".gcda", ".gcno", ".profraw", ".profdata",
  // Managed-language and compiler cache output.
  ".class", ".jar", ".pyc", ".pyo", ".beam", ".hi", ".dyn_hi", ".dyn_o", ".rlib", ".rmeta",
]);

export function isSensitivePath(relativePath: string): boolean {
  const name = basename(relativePath).toLowerCase();
  const extension = extname(name);
  return secretNames.has(name)
    || name.startsWith(".env.")
    || secretExtensions.has(extension)
    || relativePath.toLowerCase().includes("/.ssh/");
}

export function isCandidateTextFile(relativePath: string): boolean {
  const extension = extname(relativePath).toLowerCase();
  return !binaryExtensions.has(extension) && !generatedArtifactExtensions.has(extension);
}

// GCC/Clang dependency files normally begin with one or more object targets.
const DEPENDENCY_FILE_TARGET = /(?:^|\n)[^\r\n:]*\.(?:o|obj)\s*:\s*\S/im;
const DOCUMENT_EXTENSIONS = [".md", ".mdx", ".rst", ".txt"];
const CONFIG_EXTENSIONS = [".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".xml"];
const LOW_RELEVANCE_SEGMENTS = ["vendor", "vendors", "plugin", "plugins", "static", "dist", "assets", "build"];
const LOW_RELEVANCE_FILE = /\.(svg|eot|ttf|otf|woff2?|map|min\.(?:js|css))$/u;

export function isGeneratedTextArtifact(relativePath: string, content: string): boolean {
  if (extname(relativePath).toLowerCase() !== ".d") return false;
  // Content inspection preserves real D-language source files that share the extension.
  return DEPENDENCY_FILE_TARGET.test(content.slice(0, 16_384));
}

export function detectKind(relativePath: string): string {
  const extension = extname(relativePath).toLowerCase();
  if (DOCUMENT_EXTENSIONS.includes(extension)) return "document";
  if (CONFIG_EXTENSIONS.includes(extension)) return "config";
  return "code";
}

/** Files kept for text search but too noisy for symbol, relation and n-gram indexes. */
export function isLowRelevanceSourcePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/").toLowerCase();
  const segments = normalized.split("/");
  if (LOW_RELEVANCE_SEGMENTS.some((segment) => segments.includes(segment))) return true;
  return LOW_RELEVANCE_FILE.test(normalized);
}

const PRIVATE_KEY_BEGIN = /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/;
const PRIVATE_KEY_BLOCK = "-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\\s\\S]*?(?:-----END (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|$)";
const CREDENTIAL_ASSIGNMENT = /(?:api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key|password)\s*[:=]\s*["']?[A-Za-z0-9_\-/.+=]{16,}/i;

export function containsLikelySecret(content: string): boolean {
  return PRIVATE_KEY_BEGIN.test(content) || CREDENTIAL_ASSIGNMENT.test(content);
}

/** Mask entire matching lines before any text or code analysis, preserving source positions. */
export function redactLikelySecretLines(content: string): { content: string; redactedLines: number[] } {
  const ranges: Array<{ start: number; end: number }> = [];
  const credentials = new RegExp(CREDENTIAL_ASSIGNMENT.source, "gi");
  const privateKeys = new RegExp(PRIVATE_KEY_BLOCK, "g");
  for (const pattern of [credentials, privateKeys]) {
    for (const match of content.matchAll(pattern)) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  if (ranges.length === 0) return { content, redactedLines: [] };
  ranges.sort((left, right) => left.start - right.start);
  const redactedLines: number[] = [];
  let offset = 0;
  let rangeIndex = 0;
  const lines = content.split("\n").map((line, index) => {
    const start = offset;
    offset += line.length + 1;
    while (rangeIndex < ranges.length && ranges[rangeIndex]!.end <= start) rangeIndex++;
    if (rangeIndex >= ranges.length || ranges[rangeIndex]!.start >= offset) return line;
    redactedLines.push(index + 1);
    return line.replace(/[^\r]/g, " ");
  });
  return { content: lines.join("\n"), redactedLines };
}

// Bump when the logic (not only the patterns) of redaction, tiering, artifact or kind detection changes.
const CONTENT_RULES_REVISION = 1;

/** Identifies the rules that shape stored text and its tier; a change makes the indexer re-read unchanged files. */
export const CONTENT_RULES_FINGERPRINT = sha256(JSON.stringify([
  CONTENT_RULES_REVISION, PRIVATE_KEY_BEGIN.source, PRIVATE_KEY_BLOCK, CREDENTIAL_ASSIGNMENT.source,
  LOW_RELEVANCE_SEGMENTS, LOW_RELEVANCE_FILE.source, DEPENDENCY_FILE_TARGET.source, DOCUMENT_EXTENSIONS, CONFIG_EXTENSIONS,
]));
