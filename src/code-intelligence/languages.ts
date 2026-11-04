import { extname } from "node:path";

export type AnalysisLanguage = "typescript" | "tsx" | "javascript" | "jsx" | "python" | "go" | "rust" | "vue" | "svelte"
  | "java" | "c" | "cpp" | "csharp" | "php";

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, AnalysisLanguage>> = {
  ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "jsx",
  ".py": "python", ".go": "go", ".rs": "rust", ".vue": "vue", ".svelte": "svelte",
  ".java": "java", ".c": "c", ".cs": "csharp", ".php": "php",
  // Headers are shared by C and C++; the C++ grammar parses both.
  ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".h": "cpp", ".hh": "cpp", ".hpp": "cpp", ".hxx": "cpp", ".ino": "cpp",
};

/**
 * Extensions the Tree-sitter analyzers turn into symbols: tree-sitter-analyzer.ts (TS/JS and
 * components), multilanguage-analyzer.ts and c-family-analyzer.ts. tests/symbol-coverage.test.ts
 * checks this list against their actual output.
 */
export const ANALYZED_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(LANGUAGE_BY_EXTENSION));

/**
 * Extraction-rule version per language. Bump one when that analyzer's output changes:
 * the next index re-extracts symbols and relations for unchanged files of that language
 * only, leaving their text indexes in place.
 */
export const ANALYZER_VERSIONS: Readonly<Record<AnalysisLanguage, string>> = {
  typescript: "3", tsx: "3", javascript: "3", jsx: "3", python: "3", go: "3", rust: "3", vue: "1", svelte: "1",
  java: "1", c: "1", cpp: "1", csharp: "1", php: "1",
};

export function analysisLanguage(path: string): AnalysisLanguage | null {
  return LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()] ?? null;
}
