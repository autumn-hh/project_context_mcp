import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectContextApp } from "../src/core/app.js";
import { matchingNgramItems } from "../src/search/ngram-index.js";
import { rrfMerge } from "../src/search/rank-fusion.js";
import { searchProject } from "../src/search/search-service.js";
import { rebuildRelationTargets } from "../src/code-intelligence/relation-targets.js";

describe("search ranking and recall", () => {
  it("fuses ranked lists without comparing heterogeneous raw scores", () => {
    const merged = rrfMerge(
      [
        { items: [{ id: "fts-only", raw: 0.99 }, { id: "shared", raw: 0.02 }] },
        { items: [{ id: "shared", raw: 0.11 }, { id: "ngram-only", raw: 0.98 }] },
      ],
      (item) => item.id,
    );

    expect(merged.map((item) => item.item.id)).toEqual(["shared", "fts-only", "ngram-only"]);
    expect(merged[0]!.score).toBeGreaterThan(merged[1]!.score);
  });

  it("counts a duplicated item once per retrieval channel", () => {
    const merged = rrfMerge(
      [{ items: [{ id: "same" }, { id: "same" }, { id: "other" }] }],
      (item) => item.id,
    );

    expect(merged.map((item) => item.item.id)).toEqual(["same", "other"]);
    expect(merged[0]!.score).toBeCloseTo(1 / 61);
  });
});

describe("project graph recall", () => {
  let tempRoot: string;
  let projectRoot: string;
  let previousHome: string | undefined;
  let previousAllowedRoots: string | undefined;
  let previousOutputRoots: string | undefined;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "project-context-search-"));
    projectRoot = join(tempRoot, "project");
    await mkdir(join(projectRoot, "src"), { recursive: true });
    await mkdir(join(projectRoot, "static"), { recursive: true });
    previousHome = process.env.PROJECT_CONTEXT_HOME;
    previousAllowedRoots = process.env.PROJECT_CONTEXT_ALLOWED_ROOTS;
    previousOutputRoots = process.env.PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS;
    process.env.PROJECT_CONTEXT_HOME = join(tempRoot, "memory");
    process.env.PROJECT_CONTEXT_ALLOWED_ROOTS = tempRoot;
    process.env.PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS = tempRoot;
    await writeFile(join(projectRoot, "src", "entry.ts"), [
      "import { helper } from './helper';",
      "export function entryPoint() { return helper(); }",
    ].join("\n"), "utf8");
    await writeFile(join(projectRoot, "src", "helper.ts"), [
      "import { leaf } from './leaf';",
      "export function helper() { return leaf(); }",
    ].join("\n"), "utf8");
    await writeFile(join(projectRoot, "src", "leaf.ts"),
      "export function leaf() { return 'leaf'; }\n", "utf8");
    await writeFile(join(projectRoot, "src", "local-entry.ts"), [
      "export function helper() { return 'local'; }",
      "export function localEntry() { return helper(); }",
    ].join("\n"), "utf8");
    await writeFile(join(projectRoot, "src", "other-helper.ts"),
      "export function helper() { return 'other'; }\n", "utf8");
    await writeFile(join(projectRoot, "src", "config.ts"),
      "export function config() { return 'local'; }\n", "utf8");
    await writeFile(join(projectRoot, "src", "consumer.ts"), [
      "import './config';",
      "export function consumer() { return true; }",
    ].join("\n"), "utf8");
    await writeFile(join(projectRoot, "src", "business.ts"),
      "export function businessToken() { return 'application'; }\n", "utf8");
    await writeFile(join(projectRoot, "static", "vendor-copy.js"),
      "export function businessToken() { return 'generated'; }\n", "utf8");
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.PROJECT_CONTEXT_HOME;
    else process.env.PROJECT_CONTEXT_HOME = previousHome;
    if (previousAllowedRoots === undefined) delete process.env.PROJECT_CONTEXT_ALLOWED_ROOTS;
    else process.env.PROJECT_CONTEXT_ALLOWED_ROOTS = previousAllowedRoots;
    if (previousOutputRoots === undefined) delete process.env.PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS;
    else process.env.PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS = previousOutputRoots;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("keeps direct symbol hits ahead of graph-related results", async () => {
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      await app.index(project.id);
      const hits = app.search(project.id, "entryPoint", 4);
      expect(hits[0]).toMatchObject({ kind: "symbol", source: "src/entry.ts" });
      expect(hits.filter((hit) => hit.kind === "symbol")).toHaveLength(2);
      expect(hits.findIndex((hit) => hit.title.includes("#helper"))).toBeGreaterThan(0);
    } finally {
      app.close();
    }
  });

  it("uses hop decay and a bounded related quota for two-hop recall", async () => {
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      await app.index(project.id);
      const first = app.search(project.id, "entryPoint", 12);
      const second = app.search(project.id, "entryPoint", 12);
      const firstIds = first.map((hit) => hit.id);
      expect(firstIds).toEqual(second.map((hit) => hit.id));

      const helperIndex = first.findIndex((hit) => hit.title.includes("#helper"));
      const leafIndex = first.findIndex((hit) => hit.title.includes("#leaf"));
      expect(helperIndex).toBeGreaterThanOrEqual(0);
      expect(leafIndex).toBeGreaterThan(helperIndex);
      expect(first.filter((hit) => hit.kind === "symbol").length).toBeLessThanOrEqual(4);
      expect(first.length).toBeLessThanOrEqual(12);
    } finally {
      app.close();
    }
  });

  it("returns no results for non-positive limits", async () => {
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      await app.index(project.id);
      expect(app.search(project.id, "entryPoint", 0)).toEqual([]);
      expect(app.search(project.id, "entryPoint", -1)).toEqual([]);
    } finally {
      app.close();
    }
  });

  it("resolves relative import relations to symbols in the imported module", async () => {
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      await app.index(project.id);
      const hits = app.search(project.id, "consumer", 8);
      expect(hits[0]).toMatchObject({ kind: "symbol", source: "src/consumer.ts" });
      expect(hits.some((hit) => hit.source === "src/config.ts" && hit.title.includes("#config"))).toBe(true);
    } finally {
      app.close();
    }
  });

  it("prefers a same-file symbol when another file defines the same name", async () => {
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      await app.index(project.id);
      const hits = app.search(project.id, "localEntry", 8);
      const relatedHelpers = hits.filter((hit) => hit.kind === "symbol" && hit.title.includes("#helper"));
      expect(relatedHelpers).toHaveLength(1);
      expect(relatedHelpers[0]!.source).toBe("src/local-entry.ts");
    } finally {
      app.close();
    }
  });

  it("ranks application symbols above matching static resources", async () => {
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      await app.index(project.id);
      const hits = app.search(project.id, "businessToken", 6);
      expect(hits[0]).toMatchObject({ kind: "symbol", source: "src/business.ts" });
      expect(hits.some((hit) => hit.source === "static/vendor-copy.js")).toBe(true);
      expect(hits.findIndex((hit) => hit.source === "static/vendor-copy.js")).toBeGreaterThan(0);
    } finally {
      app.close();
    }
  });

  it("persists ESM import targets and resolves method receivers and aliases without same-name collisions", async () => {
    await writeFile(join(projectRoot, "src", "receivers.ts"), [
      "import { helper as renamed } from './helper.js';",
      "import * as tools from './helper.js';",
      "class First { run() { return this.finish(); } finish() { return renamed(); } }",
      "class Second { finish() { return tools.helper(); } }",
      "export function receiverEntry() { return First.run(); }",
      "export function unknownReceiver(value: any) { return value.finish(); }",
    ].join("\n"), "utf8");
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      await app.index(project.id);
      const db = app.projects.projectDatabase(project.id);
      try {
        const resolved = db.prepare("SELECT relation.to_name AS name, symbol.qualified_name AS target " +
          "FROM relations relation JOIN relation_targets resolved ON resolved.relation_id = relation.id " +
          "JOIN symbols symbol ON symbol.id = resolved.to_symbol_id " +
          "WHERE relation.source_path = 'src/receivers.ts' ORDER BY relation.start_line").all();
        expect(resolved).toEqual(expect.arrayContaining([
          { name: "this.finish", target: "src/receivers.ts#First#finish" },
          { name: "renamed", target: "src/helper.ts#helper" },
          { name: "tools.helper", target: "src/helper.ts#helper" },
          { name: "First.run", target: "src/receivers.ts#First#run" },
        ]));
        expect(resolved).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "value.finish" })]));
        expect(db.prepare("SELECT to_source_path FROM relation_targets target JOIN relations relation " +
          "ON relation.id = target.relation_id WHERE relation.source_path = 'src/receivers.ts' " +
          "AND relation.relation_type = 'IMPORTS'").pluck().all()).toEqual(["src/helper.ts", "src/helper.ts"]);
      } finally { db.close(); }
    } finally { app.close(); }
  });

  it("refreshes relation targets when only the imported file changes or disappears", async () => {
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      await writeFile(join(projectRoot, "src", "config.ts"), "export function replacementConfig() { return true; }\n", "utf8");
      await app.index(project.id);
      expect(app.search(project.id, "consumer", 8)).toEqual(expect.arrayContaining([
        expect.objectContaining({ title: "function src/config.ts#replacementConfig" }),
      ]));
      await rm(join(projectRoot, "src", "config.ts"));
      await app.index(project.id);
      expect(app.search(project.id, "consumer", 8).some(hit => hit.source === "src/config.ts")).toBe(false);
      const db = app.projects.projectDatabase(project.id);
      try {
        expect(db.prepare("SELECT * FROM relation_targets WHERE to_source_path = 'src/config.ts'").all()).toEqual([]);
      } finally { db.close(); }
    } finally { app.close(); }
  });

  it("backfills migrated targets once and traverses indexed neighbors without full graph scans", async () => {
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      await app.index(project.id);
      const db = app.projects.projectDatabase(project.id);
      try {
        db.exec("DELETE FROM relation_targets; DELETE FROM metadata WHERE key = 'relation_targets_version'");
        await rebuildRelationTargets(db, false);
        expect(db.prepare("SELECT count(*) FROM relation_targets").pluck().get()).toBeGreaterThan(0);
        // A large unrelated graph must not become part of each frontier lookup.
        const sourceId = db.prepare("SELECT id FROM sources WHERE path = 'src/business.ts'").pluck().get() as string;
        db.transaction(() => {
          const symbol = db.prepare("INSERT INTO symbols (id, source_id, source_path, name, qualified_name, kind, start_line, end_line, content_hash) VALUES (?, ?, ?, ?, ?, 'function', 1, 1, 'fixture')");
          const relation = db.prepare("INSERT INTO relations (id, source_id, source_path, from_symbol_id, from_name, to_name, relation_type, start_line) VALUES (?, ?, ?, ?, ?, ?, 'CALLS', 1)");
          const target = db.prepare("INSERT INTO relation_targets (relation_id, to_symbol_id, to_source_path) VALUES (?, ?, ?)");
          for (let index = 0; index < 10_000; index += 1) {
            const id = "unrelated-symbol-" + index;
            const path = "unrelated/" + index + ".ts";
            symbol.run(id, sourceId, path, "unrelated", path + "#unrelated");
            relation.run("unrelated-relation-" + index, sourceId, path, id, path + "#unrelated", "unrelated");
            target.run("unrelated-relation-" + index, id, path);
          }
        }).immediate();
        const prepared: string[] = [];
        const prepare = db.prepare.bind(db);
        const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
          prepared.push(sql);
          return prepare(sql);
        });
        await rebuildRelationTargets(db, false);
        expect(prepared).toHaveLength(1);
        prepared.length = 0;
        const hits = searchProject(db, "entryPoint", 12);
        expect(hits.some(hit => hit.title === "function src/helper.ts#helper")).toBe(true);
        spy.mockRestore();
        const queries = [...new Set(prepared.filter(sql => sql.includes("JOIN relation_targets")))];
        expect(queries).toHaveLength(2);
        const seed = db.prepare("SELECT id FROM symbols WHERE name = 'entryPoint'").pluck().get() as string;
        for (const query of queries) {
          const parameters = Array.from({ length: query.split("?").length - 1 }, () => seed);
          const plan = prepare("EXPLAIN QUERY PLAN " + query).all(...parameters) as Array<{ detail: string }>;
          const details = plan.map(row => row.detail).join("\n");
          expect(details).not.toMatch(/SCAN (?:relation|resolved|source|target)(?:\s|$)/u);
          expect(details).toContain("USING INDEX");
        }
      } finally { db.close(); }
    } finally { app.close(); }
  });

  it("filters inactive n-gram rows before applying the candidate limit", async () => {
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      await app.index(project.id);
      const staleIds: string[] = [];
      for (let index = 0; index < 30; index += 1) {
        const stale = app.remember(project.id, {
          type: "fact",
          title: `旧令牌家族撤销 ${index}`,
          content: "令牌家族撤销历史记录。",
          sourceKind: "user",
        });
        staleIds.push(stale.id);
        app.setMemoryStatus(project.id, stale.id, "stale");
      }
      const active = app.remember(project.id, {
        type: "decision",
        title: "当前令牌策略",
        content: "令牌家族撤销必须记录审计事件。",
        sourceKind: "user",
      });
      const db = app.projects.projectDatabase(project.id);
      try {
        const candidates = matchingNgramItems(db, "令牌家族撤销", 20);
        expect(candidates.map((item) => item.id)).toContain(active.id);
        expect(candidates.map((item) => item.id)).not.toEqual(expect.arrayContaining(staleIds));
      } finally {
        db.close();
      }
      expect(app.search(project.id, "令牌家族撤销", 10).map((hit) => hit.id)).toContain(active.id);
    } finally {
      app.close();
    }
  });

  it("filters task summaries before FTS and fuzzy limits when assembling task context", async () => {
    const app = await ProjectContextApp.create();
    try {
      const project = await app.openProject(projectRoot);
      const summaryIds: string[] = [];
      for (let index = 0; index < 70; index += 1) {
        summaryIds.push(app.remember(project.id, {
          type: "task-summary", title: "History recap " + index,
          content: "ledgerexceptionpolicy", sourceKind: "user",
        }).id);
      }
      const decision = app.remember(project.id, {
        type: "decision", title: "Stable ledger policy",
        content: "ledgerexceptionpolicy", sourceKind: "user",
      });
      const db = app.projects.projectDatabase(project.id);
      try {
        const options = { excludeTaskSummaries: true };
        expect(matchingNgramItems(db, "ledgerexceptionpolicy", 2, options).map(item => item.id)).toEqual([decision.id]);
        expect(searchProject(db, "ledgerexceptionpolicy", 4, undefined, options).map(hit => hit.id)).toEqual([decision.id]);
        expect(searchProject(db, "ledgerexceptionpolicy", 4).some(hit => summaryIds.includes(hit.id))).toBe(true);
      } finally { db.close(); }
    } finally { app.close(); }
  });
});
