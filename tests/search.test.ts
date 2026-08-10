import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectContextApp } from "../src/core/app.js";
import { matchingNgramItems } from "../src/search/ngram-index.js";
import { rrfMerge } from "../src/search/rank-fusion.js";

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
});
