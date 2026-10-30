import Database from "better-sqlite3";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { migrateProject } from "../src/storage/schema.js";
import { remember, type MemoryRecord } from "../src/memory/memory-service.js";
import { contentMatchesTask, findContentRelations } from "../src/memory/content-relations.js";

describe("explainable lexical content relations", () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(":memory:"); migrateProject(db); });
  afterEach(() => db.close());
  function memory(input: Partial<Parameters<typeof remember>[1]> = {}): MemoryRecord {
    return remember(db, { type: "decision", title: "Storage choice", content: "Backup retention requires encryption.", sourceKind: "user", ...input });
  }

  it("connects two substantive content clues across unrelated provenance with exact quotations", () => {
    const a = memory({ sourceRef: "meeting:one" });
    const b = memory({ title: "Retention policy", content: "Backup retention uses encryption.", sourceRef: "meeting:two" });
    const before = db.prepare("SELECT total_changes() AS value").get();
    const result = findContentRelations(db, [a.id]);
    expect(result.relations).toHaveLength(1);
    const relation = result.relations[0]!;
    expect(relation.targetMemoryId).toBe(b.id);
    expect(relation.sharedTerms.length).toBeGreaterThanOrEqual(2);
    expect(`${a.title}\n${a.content}`).toContain(relation.excerpts.source);
    expect(`${b.title}\n${b.content}`).toContain(relation.excerpts.target);
    expect(relation.excerpts.source.length).toBeLessThanOrEqual(240);
    expect(db.prepare("SELECT total_changes() AS value").get()).toEqual(before);
  });

  it("finds Chinese independent phrases without counting their overlapping bigrams twice", () => {
    const a = memory({ title: "知识访问", content: "团队服务统一提供共享记忆，开发者在本地工作。" });
    const b = memory({ title: "协作约定", content: "共享记忆通过团队服务访问，个人代码保留本地。" });
    const result = findContentRelations(db, [a.id]);
    expect(result.relations.map((entry) => entry.targetMemoryId)).toEqual([b.id]);
    expect(result.relations[0]!.sharedTerms.sort()).toEqual(["共享记忆", "团队服务"].sort());
    const c = memory({ title: "Archive", content: "数据库备份。" });
    const d = memory({ title: "Restore", content: "数据库备份需要检查。" });
    expect(findContentRelations(db, [c.id]).relations.some((entry) => entry.targetMemoryId === d.id)).toBe(false);
  });

  it("recognizes database backup and retention policy in longer Chinese sentences", () => {
    const a = memory({ title: "存储约定", content: "数据库备份需要加密保存，保留策略是七天。" });
    const b = memory({ title: "运维约定", content: "保留策略由管理员决定，数据库备份不能直接删除。" });
    const result = findContentRelations(db, [a.id]);
    expect(result.relations.map((entry) => entry.targetMemoryId)).toEqual([b.id]);
    expect(result.relations[0]!.sharedTerms).toContain("数据库备份");
    expect(result.relations[0]!.sharedTerms).toContain("保留策略");
    expect(contentMatchesTask(a, "请帮我查一下数据库备份相关的保留策略是什么")).toBe(true);
  });

  it("does not connect generic work reports, metadata, paths, or a shared document", () => {
    const a = memory({ title: "完成测试", content: "MCP API 项目实现完成测试通过。", sourceRef: "docs/shared.md", scope: ["src/memory"] });
    const b = memory({ title: "实现检查", content: "MCP API 项目更新完成测试通过。", sourceRef: "docs/shared.md", scope: ["src/memory"] });
    const c = memory({ title: "Fonts", content: "Typography uses a modular scale.", reason: "Backup retention encryption",
      sourceRef: "backup retention encryption", scope: ["backup", "retention"] });
    expect(findContentRelations(db, [a.id]).relations).toEqual([]);
    expect(contentMatchesTask(c, "backup retention encryption")).toBe(false);
    expect(contentMatchesTask(a, "src/memory MCP API 完成测试")).toBe(false);
    expect(contentMatchesTask(c, "edit docs/typography/modular/scale.ts")).toBe(false);
    expect(contentMatchesTask(memory(), "edit backup.ts retention.md")).toBe(false);
    expect(contentMatchesTask(memory({ title: "索引", content: "索引包含配置。" }), "修改 src/索引/配置.ts")).toBe(false);
    expect(b.id).not.toBe(a.id);
  });

  it("preserves different numbers and negations as separate possible relations, never merges records", () => {
    const a = memory({ title: "Backup retention", content: "Backup retention is seven days. Encryption is required." });
    const b = memory({ title: "Backup retention", content: "Backup retention is not seven days. Encryption is optional." });
    const result = findContentRelations(db, [a.id]);
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0]!.targetMemoryId).toBe(b.id);
    expect(result.relations[0]!.excerpts.target).toContain("not seven days");
    expect(db.prepare("SELECT COUNT(*) AS count FROM memories").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT content FROM memories WHERE id=?").pluck().get(b.id)).toBe(b.content);
  });

  it("uses Latin boundaries and keeps a compound identifier as one independent clue", () => {
    const a = memory({ title: "Parser A", content: "Git checkout uses a narrow index." });
    const b = memory({ title: "Parser B", content: "Digit checkout uses a narrow index." });
    const relations = findContentRelations(db, [a.id]).relations;
    expect(relations[0]?.sharedTerms).not.toContain("git");
    expect(contentMatchesTask(memory({ title: "Digit parser", content: "A digit tokenizer." }), "git")).toBe(false);
    const c = memory({ title: "Rotation", content: "refreshToken validates tokenFamily." });
    const d = memory({ title: "Expiry", content: "REFRESHTOKEN preserves TOKENFAMILY." });
    const pair = findContentRelations(db, [c.id]).relations.find((entry) => entry.targetMemoryId === d.id)!;
    expect(pair.sharedTerms.sort()).toEqual(["refreshtoken", "tokenfamily"]);
    const e = memory({ title: "Rotate", content: "refreshToken." });
    const f = memory({ title: "Verify", content: "refreshToken." });
    expect(findContentRelations(db, [e.id]).relations.some((entry) => entry.targetMemoryId === f.id)).toBe(false);
  });

  it("filters summaries and inactive records before candidate quotas", () => {
    const a = memory();
    const b = memory({ title: "Encryption retention", content: "Backup retention requires encryption." });
    db.prepare("UPDATE memories SET updated_at='2000-01-01' WHERE id=?").run(b.id);
    for (let i = 0; i < 150; i += 1) {
      memory({ title: "Backup retention encryption", type: "task-summary" });
      memory({ title: "Backup retention encryption", status: "stale" });
    }
    expect(findContentRelations(db, [a.id]).relations.map((entry) => entry.targetMemoryId)).toEqual([b.id]);
  });

  it("finds old matching knowledge beyond recent unrelated history", () => {
    const a = memory();
    const b = memory({ title: "Backup policy", content: "Backup retention applies encryption." });
    db.prepare("UPDATE memories SET updated_at='2000-01-01' WHERE id=?").run(b.id);
    for (let i = 0; i < 160; i += 1) memory({ title: `Typography ${i}`, content: "Font spacing and kerning." });
    expect(findContentRelations(db, [a.id]).relations.map((entry) => entry.targetMemoryId)).toEqual([b.id]);
  });

  it("ignores reason-only keyword spam before retrieval limits", () => {
    const seed = memory({ title: "存储约定", content: "数据库备份采用保留策略。" });
    const target = memory({ title: "运维约定", content: "数据库备份需要保留策略。" });
    for (let i = 0; i < 150; i += 1) {
      memory({ title: `Typography ${i}`, content: "Font layout.", reason: "数据库备份采用保留策略。" });
    }
    expect(findContentRelations(db, [seed.id]).relations.map((entry) => entry.targetMemoryId)).toEqual([target.id]);
  });

  it("applies review visibility and acceptance before selecting each seed's result quota", () => {
    const a = memory();
    const stale = memory({ status: "stale" });
    const rejected = memory({ status: "rejected" });
    const excluded = memory({ title: "Backup encryption retention", scope: ["wrong"] });
    const chosen = memory({ title: "Backup encryption retention", scope: ["right"] });
    expect(findContentRelations(db, [a.id], { perSeed: 1, accepts: (item) => !item.scope.includes("wrong") }).relations[0]?.targetMemoryId)
      .toBe(chosen.id);
    const reviewed = findContentRelations(db, [a.id], { includeInactive: true, perSeed: 3 }).relations;
    expect(reviewed.some((entry) => entry.targetMemoryId === stale.id)).toBe(true);
    expect(reviewed.some((entry) => entry.targetMemoryId === rejected.id)).toBe(false);
    expect(excluded.id).not.toBe(chosen.id);
  });

  it("uses accepts only for new target candidates, never to discard an existing seed", () => {
    const seed = memory();
    const peer = memory({ title: "Backup retention", content: "Backup retention needs encryption." });
    const result = findContentRelations(db, [seed.id], { accepts: (item) => item.id !== seed.id });
    expect(result.relations.map((entry) => entry.targetMemoryId)).toEqual([peer.id]);
  });

  it("deduplicates symmetric pairs and reports real bounds deterministically", () => {
    const a = memory();
    const b = memory();
    const c = memory();
    const one = findContentRelations(db, [a.id, b.id, c.id], { limit: 1 });
    const two = findContentRelations(db, [a.id, b.id, c.id], { limit: 1 });
    expect(one).toEqual(two);
    expect(one.relations).toHaveLength(1);
    expect(one.truncated).toBe(true);
    const all = findContentRelations(db, [a.id, b.id, c.id], { limit: 24, perSeed: 3 });
    expect(all.relations).toHaveLength(3);
    expect(new Set(all.relations.map((entry) => [entry.sourceMemoryId, entry.targetMemoryId].sort().join(":"))).size).toBe(3);
    expect(findContentRelations(db, [], {})).toEqual({ relations: [], truncated: false });
    expect(() => findContentRelations(db, [a.id], { limit: 25 })).toThrow();
    expect(() => findContentRelations(db, [a.id], { perSeed: 0 })).toThrow();
    expect(() => findContentRelations(db, [a.id], { limit: Number.NaN })).toThrow();
  });

  it("requires substantive task content instead of one broad term or managed metadata", () => {
    const a = memory();
    expect(contentMatchesTask(a, "backup")).toBe(false);
    expect(contentMatchesTask(a, "MCP 实现完成测试")).toBe(false);
    expect(contentMatchesTask(a, "backup retention")).toBe(true);
    expect(contentMatchesTask(memory({ title: "Rules", content: "refreshToken rejects replay." }), "check refreshToken")).toBe(true);
    expect(contentMatchesTask(memory({ title: "知识约定", content: "团队服务管理共享记忆。" }), "共享记忆")).toBe(true);
  });

  it("retains a short body qualification even when matching clues occur in the title", () => {
    const a = memory({ title: "Database backup retention", content: "Do not retain thirty days." });
    const b = memory({ title: "Database backup retention", content: "Retain thirty days." });
    const relation = findContentRelations(db, [a.id]).relations.find((entry) => entry.targetMemoryId === b.id)!;
    expect(relation.excerpts.source).toContain("Do not retain thirty days.");
    expect(relation.excerpts.target).toContain("Retain thirty days.");
  });

  it("signals text and candidate bounds without exceeding requested result limits", () => {
    const seed = memory({ title: "Backup retention", content: "Backup retention applies encryption." });
    for (let i = 0; i < 140; i += 1) memory({ title: `Backup retention ${i}` });
    const result = findContentRelations(db, [seed.id], { limit: 2, perSeed: 2 });
    expect(result.relations).toHaveLength(2);
    expect(result.truncated).toBe(true);
    const long = memory({ title: "Long evidence", content: "Context ".repeat(2000) });
    expect(findContentRelations(db, [long.id]).truncated).toBe(true);
  });

  it("declines a title-only relation when the body qualification cannot fit intact", () => {
    const seed = memory({ title: "Database backup retention", content: "Do not retain thirty days. " + "Detailed rationale ".repeat(40) });
    const peer = memory({ title: "Database backup retention", content: "A different qualification ".repeat(40) });
    const result = findContentRelations(db, [seed.id]);
    expect(result.relations.some((entry) => entry.targetMemoryId === peer.id)).toBe(false);
  });

  it.each([
    ["project_context", "自动"],
    ["windows", "context"],
    ["candidate", "项目记忆"],
    ["decision", "选择"],
    ["issue", "自动"],
    ["context", "数据"],
    ["候选", "经过"],
    ["仍可能", "索引"],
  ])("rejects administrative or generic evidence pairs: %s / %s", (a, b) => {
    const seed = memory({ title: "Alpha", content: `${a}，${b}。`, sourceRef: "meeting:first" });
    const peer = memory({ title: "Beta", content: `${a}，${b}。`, sourceRef: "meeting:second" });
    expect(findContentRelations(db, [seed.id]).relations.some((entry) => entry.targetMemoryId === peer.id)).toBe(false);
    expect(contentMatchesTask(seed, `${a} ${b}`)).toBe(false);
  });

  it("ignores generated review role scaffolding across distinct task subjects and sources", () => {
    const seed = memory({
      title: "Review decision candidate from task: Storage rollout",
      content: "Windows 自动读取本地状态。", sourceRef: "task:task_first",
    });
    const peer = memory({
      title: "Review decision candidate from task: Typography improvement",
      content: "Windows 自动更新界面。", sourceRef: "task:task_second",
    });
    expect(findContentRelations(db, [seed.id]).relations.some((entry) => entry.targetMemoryId === peer.id)).toBe(false);
  });

  it("preserves real topics after a generated review prefix", () => {
    const seed = memory({
      title: "Review decision candidate from task: 数据库备份与保留策略",
      content: "保存七天。", sourceRef: "task:task_first",
    });
    const peer = memory({ title: "存储约定", content: "数据库备份采用保留策略。", sourceRef: "meeting:second" });
    expect(findContentRelations(db, [seed.id]).relations.map((entry) => entry.targetMemoryId)).toContain(peer.id);
  });

  it("does not use a shared duration alone as two independent topic clues", () => {
    const seed = memory({ title: "Archive", content: "Backup retention is seven days." });
    const peer = memory({ title: "Authentication", content: "Login cooldown is seven days." });
    expect(findContentRelations(db, [seed.id]).relations.some((entry) => entry.targetMemoryId === peer.id)).toBe(false);
  });

  it("ignores generic interface roles shared by unrelated features", () => {
    const seed = memory({ title: "团队共享知识与个人开发分离", content: "客户端通过 Web 访问团队知识，个人代码保持本地。" });
    const peer = memory({ title: "任务动态视图", content: "客户端使用 Web 展示任务进度，浏览器刷新界面。" });
    expect(findContentRelations(db, [seed.id]).relations.some((entry) => entry.targetMemoryId === peer.id)).toBe(false);
    expect(contentMatchesTask(seed, "Web UI 客户端 服务端 浏览器")).toBe(false);
  });

  it("retains concrete infrastructure and authorization topics after filtering interface roles", () => {
    const github = memory({ title: "推送约定", content: "GitHub 需要远端配置。" });
    const remote = memory({ title: "仓库地址", content: "远端配置用于 GitHub。" });
    const ssh = memory({ title: "部署许可", content: "用户授权通过 SSH 访问。" });
    const permission = memory({ title: "运维连接", content: "SSH 连接必须经过用户授权。" });
    expect(findContentRelations(db, [github.id]).relations.map((entry) => entry.targetMemoryId)).toContain(remote.id);
    expect(findContentRelations(db, [ssh.id]).relations.map((entry) => entry.targetMemoryId)).toContain(permission.id);
  });
});
