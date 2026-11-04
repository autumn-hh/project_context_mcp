import { describe, expect, it } from "vitest";
import {
  SYMBOL_SUPPORTED_EXTENSIONS,
  UNANALYZED_CODE_EXTENSIONS,
  symbolCoverage,
} from "../src/code-intelligence/symbol-coverage.js";
import { analyzeCode } from "../src/code-intelligence/tree-sitter-analyzer.js";

describe("symbol coverage", () => {
  it("separates analyzed code, unanalyzed code, low-relevance code and other text", () => {
    expect(symbolCoverage([
      "src/app.ts", "src/view.tsx", "src/util.py",
      "src/Main.java", "src/SERVICE.JAVA", "web/App.vue",
      "src/main/resources/static/js/page.js", "plugins/legacy/Legacy.java",
      "styles/app.scss", "index.html", "package.json", "README.md", "db/schema.sql", "deploy.sh", "Makefile",
    ])).toEqual({
      analyzedSources: 6,
      unanalyzedCodeSources: 0,
      unanalyzedCodeShare: 0,
      unanalyzed: [],
      lowRelevanceCodeSources: 2,
      otherTextSources: 7,
    });
    expect(symbolCoverage(["src/App.kt", "src/Main.swift", "src/Tool.KT", "src/app.ts"])).toMatchObject({
      analyzedSources: 1, unanalyzedCodeSources: 3, unanalyzedCodeShare: 0.75,
      unanalyzed: [{ extension: ".kt", sources: 2 }, { extension: ".swift", sources: 1 }],
    });
  });

  it("does not count styles, markup, data, scripts or vendored code as a gap", () => {
    const result = symbolCoverage(["a.css", "b.html", "c.json", "d.svg", "e.sql", "f.ps1", "static/g.php", "h.ts"]);
    expect(result).toMatchObject({ analyzedSources: 1, unanalyzedCodeSources: 0, unanalyzedCodeShare: 0, lowRelevanceCodeSources: 1, otherTextSources: 6 });
  });

  it("rounds the share, orders ties by extension and caps the listed extensions", () => {
    const kinds = [".dart", ".fs", ".go", ".groovy", ".kt", ".kts", ".lua", ".m", ".mm", ".pl", ".rb", ".scala", ".swift", ".vue"];
    const result = symbolCoverage(kinds.map((extension) => `src/file${extension}`));
    expect(result.analyzedSources).toBe(2);
    expect(result.unanalyzedCodeSources).toBe(12);
    expect(result.unanalyzedCodeShare).toBe(0.8571);
    expect(result.unanalyzed.map((item) => item.extension)).toEqual([".dart", ".fs", ".groovy", ".kt", ".kts", ".lua", ".m", ".mm", ".pl", ".rb"]);
  });

  it("returns a zero share for a project without code", () => {
    expect(symbolCoverage([])).toEqual({
      analyzedSources: 0, unanalyzedCodeSources: 0, unanalyzedCodeShare: 0, unanalyzed: [], lowRelevanceCodeSources: 0, otherTextSources: 0,
    });
  });

  it("matches the extensions the analyzers actually parse", () => {
    const snippets: Record<string, string> = {
      ".ts": "export function a() {}",
      ".tsx": "export function A() { return null; }",
      ".js": "function a() {}",
      ".jsx": "function A() { return null; }",
      ".mjs": "export function a() {}",
      ".cjs": "function a() {}",
      ".py": "def a():\n    return 1\n",
      ".go": "package main\nfunc a() {}\n",
      ".rs": "fn a() {}\n",
      ".vue": "<template><p /></template>\n<script setup>\nfunction a() {}\n</script>\n",
      ".svelte": "<script>\nfunction a() {}\n</script>\n<p />\n",
      ".java": "class A { void a() {} }",
      ".c": "int a(void) { return 0; }",
      ".cs": "class A { void B() {} }",
      ".php": "<?php function a() {}",
      ".cc": "void a() {}", ".cpp": "void a() {}", ".cxx": "void a() {}", ".ino": "void setup() {}",
      ".h": "int a(void);\nstruct A { int x; };", ".hh": "class A {};", ".hpp": "class A {};", ".hxx": "class A {};",
    };
    for (const extension of SYMBOL_SUPPORTED_EXTENSIONS) {
      const source = snippets[extension];
      expect(source, extension).toBeDefined();
      expect(analyzeCode(`sample${extension}`, source!)?.symbols.length, extension).toBeGreaterThan(0);
    }
    for (const extension of UNANALYZED_CODE_EXTENSIONS) {
      expect(analyzeCode(`sample${extension}`, "class Sample {}"), extension).toBeNull();
    }
  });
});
