import { extname, basename } from "node:path";

export const DEFAULT_IGNORE_PATTERNS = [
  ".git/",
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

export function isGeneratedTextArtifact(relativePath: string, content: string): boolean {
  if (extname(relativePath).toLowerCase() !== ".d") return false;
  // GCC/Clang dependency files normally begin with one or more object targets.
  // Content inspection preserves real D-language source files that share the extension.
  return /(?:^|\n)[^\r\n:]*\.(?:o|obj)\s*:\s*\S/im.test(content.slice(0, 16_384));
}

export function detectKind(relativePath: string): string {
  const extension = extname(relativePath).toLowerCase();
  if ([".md", ".mdx", ".rst", ".txt"].includes(extension)) return "document";
  if ([".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".xml"].includes(extension)) return "config";
  return "code";
}

/** Files kept for text search but too noisy for symbol, relation and n-gram indexes. */
export function isLowRelevanceSourcePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/").toLowerCase();
  const segments = normalized.split("/");
  if (["vendor", "vendors", "plugin", "plugins", "static", "dist", "assets", "build"].some((segment) => segments.includes(segment))) {
    return true;
  }
  return /\.(svg|eot|ttf|otf|woff2?|map|min\.(?:js|css))$/u.test(normalized);
}

export function containsLikelySecret(content: string): boolean {
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) return true;
  return /(?:api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key|password)\s*[:=]\s*["']?[A-Za-z0-9_\-/.+=]{16,}/i
    .test(content);
}
