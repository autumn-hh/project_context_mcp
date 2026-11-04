import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeCode } from "../src/code-intelligence/tree-sitter-analyzer.js";
import { ANALYZER_VERSIONS } from "../src/code-intelligence/languages.js";
import { indexProject } from "../src/indexing/indexer.js";
import { openDatabase } from "../src/storage/database.js";
import { migrateProject } from "../src/storage/schema.js";
import type { ProjectRecord } from "../src/projects/project-service.js";

describe("additional Tree-sitter languages", () => {
  it("extracts Python definitions, calls, imports and inheritance", () => {
    const result=analyzeCode("service.py","from helpers import helper\nclass Service(Base):\n    def run(self):\n        return helper()\n")!;
    expect(result.language).toBe("python"); expect(result.symbols.map(s=>s.name)).toEqual(["Service","run"]);
    expect(result.relations).toEqual(expect.arrayContaining([expect.objectContaining({relationType:"CALLS",toName:"helper"}),expect.objectContaining({relationType:"EXTENDS",toName:"Base"}),expect.objectContaining({relationType:"IMPORTS",toName:"helpers"})]));
    expect(result.symbols[1]!.qualifiedName).toBe("service.py#Service#run");
  });
  it("extracts Go functions and method calls", () => {
    const result=analyzeCode("main.go",'package main\nimport "fmt"\nfunc helper() {}\nfunc run() { helper(); fmt.Println("x") }\n')!;
    expect(result.language).toBe("go"); expect(result.symbols.map(s=>s.name)).toContain("run");
    expect(result.relations).toEqual(expect.arrayContaining([expect.objectContaining({relationType:"CALLS",toName:"helper"}),expect.objectContaining({relationType:"IMPORTS",toName:"fmt"})]));
  });
  it("extracts Rust functions, impl scopes and trait relationships", () => {
    const result=analyzeCode("lib.rs",'use crate::helpers::helper;\nstruct Service;\nimpl Worker for Service { fn run(&self) { helper(); } }\n')!;
    expect(result.language).toBe("rust"); expect(result.symbols.map(s=>s.qualifiedName)).toContain("lib.rs#Service#run");
    expect(result.relations).toEqual(expect.arrayContaining([expect.objectContaining({relationType:"IMPLEMENTS",toName:"Worker"}),expect.objectContaining({relationType:"CALLS",toName:"helper"})]));
  });
  it("extracts Vue script blocks at their positions in the component", () => {
    const component = [
      "<template>",
      "  <button @click=\"save\">保存实验记录</button>",
      "</template>",
      "<script setup lang=\"ts\" generic=\"T extends Map<string, number>\">",
      "import { persist } from \"./store\";",
      "function save(): void { persist(); }",
      "const total = (items: T) => items.size;",
      "</script>",
      "<script>",
      "export default { methods: { reset() { save(); } } };",
      "</script>",
      "<style>.button { color: red; }</style>",
    ].join("\n");
    const result = analyzeCode("src/views/Lab.vue", component)!;
    expect(result.language).toBe("vue");
    expect(result.symbols.map((symbol) => [symbol.name, symbol.kind, symbol.startLine])).toEqual([
      ["save", "function", 6], ["total", "function", 7], ["reset", "method", 10],
    ]);
    expect(result.symbols[0]!.qualifiedName).toBe("src/views/Lab.vue#save");
    expect(result.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ relationType: "IMPORTS", toName: "./store", startLine: 5 }),
      expect.objectContaining({ relationType: "CALLS", toName: "persist", fromName: "src/views/Lab.vue#save" }),
    ]));
  });

  it("extracts Svelte scripts, skips external ones and keeps template-only components analyzed", () => {
    const svelte = "<script src=\"./legacy.js\"></script>\n<script lang=\"ts\">\n  export function load(id: string) { return id; }\n</script>\n<h1>{title}</h1>\n";
    expect(analyzeCode("Page.svelte", svelte)).toMatchObject({ language: "svelte", symbols: [{ name: "load", startLine: 3 }] });
    expect(analyzeCode("Static.vue", "<template><p>说明</p></template>\n")).toEqual({ language: "vue", symbols: [], relations: [] });
  });

  it("re-extracts unchanged files indexed before their analyzer without rewriting text indexes", async () => {
    const root = await mkdtemp(join(tmpdir(), "context-analyzer-refresh-"));
    const db = openDatabase(":memory:");
    try {
      migrateProject(db);
      await writeFile(join(root, "service.py"), "def run():\n    return helper()\n", "utf8");
      await writeFile(join(root, "app.ts"), "export function start() { return 1; }\n", "utf8");
      const project = { id: "prj_refresh", rootPath: root } as ProjectRecord;
      await indexProject(db, project);
      // Recreate a database indexed before Python support: text only, and just the legacy version key.
      const python = db.prepare("SELECT id FROM sources WHERE path = 'service.py'").pluck().get() as string;
      db.prepare("DELETE FROM search_ngrams WHERE item_kind = 'symbol' AND item_id IN (SELECT id FROM symbols WHERE source_id = ?)").run(python);
      db.prepare("DELETE FROM symbols_fts WHERE symbol_id IN (SELECT id FROM symbols WHERE source_id = ?)").run(python);
      db.prepare("DELETE FROM relations WHERE source_id = ?").run(python);
      db.prepare("DELETE FROM symbols WHERE source_id = ?").run(python);
      db.prepare("DELETE FROM metadata WHERE key = 'code_analyzer_versions'").run();
      const chunks = () => db.prepare("SELECT rowid, id FROM chunks ORDER BY id").all();
      const typeScriptSymbols = () => db.prepare("SELECT rowid, id FROM symbols WHERE source_path = 'app.ts' ORDER BY id").all();
      const [chunksBefore, typeScriptBefore] = [chunks(), typeScriptSymbols()];

      expect(await indexProject(db, project)).toMatchObject({ indexed: 1, errors: [] });
      expect(db.prepare("SELECT name FROM symbols WHERE source_id = ?").pluck().all(python)).toEqual(["run"]);
      expect(db.prepare("SELECT to_name FROM relations WHERE source_id = ? AND relation_type = 'CALLS'").pluck().all(python)).toEqual(["helper"]);
      expect(chunks()).toEqual(chunksBefore);
      expect(typeScriptSymbols()).toEqual(typeScriptBefore);
      expect(JSON.parse(db.prepare("SELECT value FROM metadata WHERE key = 'code_analyzer_versions'").pluck().get() as string)).toEqual(ANALYZER_VERSIONS);
      expect(await indexProject(db, project)).toMatchObject({ indexed: 0, skipped: 2 });
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains TS/JS behavior and handles long Unicode input", () => {
    expect(analyzeCode("a.ts","export function run() { return helper(); }")!.language).toBe("typescript");
    const result=analyzeCode("long.py","# 注释\n".repeat(9000)+"def ending():\n    return 1\n")!;
    expect(result.symbols.map(s=>s.name)).toEqual(["ending"]);
  });
});
