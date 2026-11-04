import { extname } from "node:path";

export type AnalysisLanguage = "typescript" | "tsx" | "javascript" | "jsx" | "python" | "go" | "rust" | "vue" | "svelte";

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, AnalysisLanguage>> = {
  ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "jsx",
  ".py": "python", ".go": "go", ".rs": "rust", ".vue": "vue", ".svelte": "svelte",
};

/**
 * Extensions the Tree-sitter analyzers turn into symbols. Keep in sync with
 * languageForPath() in tree-sitter-analyzer.ts and analyzeAdditionalLanguage()
 * in multilanguage-analyzer.ts; tests/symbol-coverage.test.ts checks both.
 */
export const ANALYZED_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(LANGUAGE_BY_EXTENSION));

/**
 * Extraction-rule version per language. Bump one when that analyzer's output changes:
 * the next index re-extracts symbols and relations for unchanged files of that language
 * only, leaving their text indexes in place.
 */
export const ANALYZER_VERSIONS: Readonly<Record<AnalysisLanguage, string>> = {
  typescript: "3", tsx: "3", javascript: "3", jsx: "3", python: "3", go: "3", rust: "3", vue: "1", svelte: "1",
};

export function analysisLanguage(path: string): AnalysisLanguage | null {
  return LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()] ?? null;
}
