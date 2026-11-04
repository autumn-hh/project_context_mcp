import { extname } from "node:path";
import { isLowRelevanceSourcePath } from "../indexing/file-policy.js";
import { ANALYZED_EXTENSIONS } from "./languages.js";

export const SYMBOL_SUPPORTED_EXTENSIONS = ANALYZED_EXTENSIONS;

/**
 * Application source files that are full-text indexed but produce no symbols.
 * Scripts, SQL, styles, markup, data and documents stay searchable and are not
 * counted as a code-intelligence gap.
 */
export const UNANALYZED_CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".java", ".kt", ".kts", ".scala", ".groovy",
  ".cs", ".fs", ".vb",
  ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx", ".ino", ".m", ".mm",
  ".php", ".rb", ".swift", ".dart", ".lua", ".pl", ".r",
]);

const MAX_LISTED_EXTENSIONS = 10;

export interface SymbolCoverage {
  /** Code files sent to a Tree-sitter analyzer during indexing. */
  analyzedSources: number;
  /** Code files in languages without an analyzer. */
  unanalyzedCodeSources: number;
  /** unanalyzedCodeSources / (analyzedSources + unanalyzedCodeSources), rounded to 4 decimals. */
  unanalyzedCodeShare: number;
  /** Most common unanalyzed extensions, largest first. */
  unanalyzed: Array<{ extension: string; sources: number }>;
  /** Code under vendor, plugins, static, assets, dist or build paths, kept for text search only. */
  lowRelevanceCodeSources: number;
  /** Documents, configuration, styles, markup, scripts and other text. */
  otherTextSources: number;
}

/** Report which indexed sources yield symbols, without reading file contents. */
export function symbolCoverage(paths: Iterable<string>): SymbolCoverage {
  const unanalyzedCounts = new Map<string, number>();
  let analyzedSources = 0;
  let lowRelevanceCodeSources = 0;
  let otherTextSources = 0;
  for (const path of paths) {
    const extension = extname(path).toLowerCase();
    const supported = SYMBOL_SUPPORTED_EXTENSIONS.has(extension);
    if (!supported && !UNANALYZED_CODE_EXTENSIONS.has(extension)) otherTextSources += 1;
    // The indexer never analyzes low-relevance paths, whatever their language.
    else if (isLowRelevanceSourcePath(path)) lowRelevanceCodeSources += 1;
    else if (supported) analyzedSources += 1;
    else unanalyzedCounts.set(extension, (unanalyzedCounts.get(extension) ?? 0) + 1);
  }
  let unanalyzedCodeSources = 0;
  for (const count of unanalyzedCounts.values()) unanalyzedCodeSources += count;
  const codeSources = analyzedSources + unanalyzedCodeSources;
  return {
    analyzedSources,
    unanalyzedCodeSources,
    unanalyzedCodeShare: codeSources === 0 ? 0 : Math.round((unanalyzedCodeSources / codeSources) * 10_000) / 10_000,
    unanalyzed: [...unanalyzedCounts]
      .map(([extension, sources]) => ({ extension, sources }))
      .sort((left, right) => right.sources - left.sources || left.extension.localeCompare(right.extension))
      .slice(0, MAX_LISTED_EXTENSIONS),
    lowRelevanceCodeSources,
    otherTextSources,
  };
}
