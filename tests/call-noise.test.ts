import { describe, expect, it } from "vitest";
import { analyzeCode } from "../src/code-intelligence/tree-sitter-analyzer.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/storage/database.js";
import { migrateProject } from "../src/storage/schema.js";
import { indexProject } from "../src/indexing/indexer.js";
import type { ProjectRecord } from "../src/projects/project-service.js";

function calls(content: string, sourcePath = "src/service.ts"): string[] {
  return analyzeCode(sourcePath, content)!.relations
    .filter((item) => item.relationType === "CALLS").map((item) => item.toName);
}

describe("call relation noise filtering", () => {
  it("refreshes unchanged legacy source relations once and rebuilds targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "context-call-noise-"));
    const db = openDatabase(":memory:");
    try {
      migrateProject(db);
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src", "service.ts"), "export function run() { console.log(1); JSON.stringify({}); Math.max(1,2); helper(); } function helper() {}", "utf8");
      const project = { id: "prj_noise", rootPath: root } as ProjectRecord;
      await indexProject(db, project);
      const source = db.prepare("SELECT id, content_hash FROM sources").get() as { id: string; content_hash: string };
      db.prepare("INSERT INTO relations (id, source_id, source_path, from_name, to_name, relation_type, start_line) VALUES ('old-noise', ?, 'src/service.ts', 'src/service.ts#run', 'console.log', 'CALLS', 1)").run(source.id);
      db.prepare("DELETE FROM metadata WHERE key = 'code_analysis_version'").run();
      const refreshed = await indexProject(db, project);
      expect(refreshed.indexed).toBe(1);
      expect(refreshed.errors).toEqual([]);
      expect(db.prepare("SELECT content_hash FROM sources").pluck().get()).toBe(source.content_hash);
      expect(db.prepare("SELECT to_name FROM relations WHERE relation_type = 'CALLS'").pluck().all()).toEqual(["helper"]);
      expect(db.prepare("SELECT count(*) FROM relation_targets").pluck().get()).toBeGreaterThan(0);
      const repeated = await indexProject(db, project);
      expect(repeated.indexed).toBe(0);
      expect(repeated.skipped).toBe(1);
    } finally { db.close(); await rm(root, { recursive: true, force: true }); }
  });
  it("omits console, JSON and Math calls while keeping business calls and heritage", () => {
    const analysis = analyzeCode("src/service.ts", `
      import { Base } from "./base";
      class Service extends Base {
        run() {
          console.log("ready"); console?.warn("warning"); console["error"]("error");
          JSON.stringify({}); JSON?.parse("{}"); Math.max(1, 2); Math["round"](1.5);
          (console).info("info"); globalThis.console.log("global");
          service.run(); this.persist(); helper(); consoleService.log();
        }
      }
    `)!;
    expect(analysis.relations.filter((item) => item.relationType === "CALLS").map((item) => item.toName))
      .toEqual(["service.run", "this.persist", "helper", "consoleService.log"]);
    expect(analysis.relations.map((item) => `${item.relationType}:${item.toName}`))
      .toEqual(expect.arrayContaining(["IMPORTS:./base", "EXTENDS:Base"]));
    expect(analysis.symbols.map((item) => item.name)).toEqual(["Service", "run"]);
  });

  it("drops a very frequent unresolved callee at the threshold and preserves less frequent calls", () => {
    expect(calls(`function run() { ${"external.assert();".repeat(64)} business.run(); }`))
      .toEqual(["business.run"]);
    expect(calls(`function run() { ${"external.assert();".repeat(63)} }`)).toHaveLength(63);
  });

  it("counts optional, bracket and fluent syntax together without changing retained evidence", () => {
    const content = `function run() {
      ${'external.assert(); external?.assert(); external["assert"]();'.repeat(22)}
      ${Array.from({ length: 64 }, (_, index) => `schema.string("${index}").min(1);`).join("\n")}
      service.execute("value");
    }`;
    const analysis = analyzeCode("src/service.ts", content)!;
    const retained = analysis.relations.filter((item) => item.relationType === "CALLS");
    expect(retained.map((item) => item.toName)).toEqual(["service.execute"]);
    expect(retained[0]?.evidence).toBe('service.execute("value")');
    expect(retained[0]?.fromName).toBe("src/service.ts#run");
  });

  it("retains frequently used local functions, classes and instance calls", () => {
    const content = `
      function persist() {}
      class Service { static save() {} run() { ${"this.persist(); Service.save(); persist();".repeat(64)} } }
    `;
    expect(calls(content)).toHaveLength(192);
  });

  it("retains high-frequency project imports including aliases, defaults and namespaces", () => {
    const content = `
      import Service, { persist as save } from "./service";
      import * as business from "../business";
      import { assert } from "third-party";
      function run() { ${"Service.execute(); save(); business.persist(); assert();".repeat(64)} }
    `;
    const retained = calls(content);
    expect(retained).toHaveLength(192);
    expect(retained).not.toContain("assert");
    expect(new Set(retained)).toEqual(new Set(["Service.execute", "save", "business.persist"]));
  });

  it.each(["src/service.ts", "src/service.tsx", "src/service.js", "src/service.jsx"])(
    "applies the same filtering to %s", (sourcePath) => {
      expect(calls("function run() { console.log(1); JSON.stringify({}); Math.max(1,2); persist(); }", sourcePath))
        .toEqual(["persist"]);
    },
  );
});
