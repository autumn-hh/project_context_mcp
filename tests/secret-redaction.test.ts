import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ProjectContextApp } from "../src/core/app.js";
import { redactLikelySecretLines } from "../src/indexing/file-policy.js";
import { readContentProtection } from "../src/indexing/content-protection.js";
import { indexProject } from "../src/indexing/indexer.js";
import { openDatabase, type SqliteDatabase } from "../src/storage/database.js";
import { migrateProject } from "../src/storage/schema.js";
import type { ProjectRecord } from "../src/projects/project-service.js";

const directories: string[] = [];
const databases: SqliteDatabase[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const rootPath = await mkdtemp(join(tmpdir(), "pcm-redaction-"));
  directories.push(rootPath);
  const db = openDatabase(join(rootPath, ".project-context", "project.db"));
  databases.push(db);
  migrateProject(db);
  const project: ProjectRecord = {
    id: "prj_redaction", name: "redaction", rootPath, remoteUrl: null,
    createdAt: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:00:00.000Z",
    lastOpenedAt: "2026-10-12T00:00:00.000Z", archivedAt: null,
  };
  return { db, project };
}

describe("index secret line redaction", () => {
  it("preserves CRLF and positions while masking assignments, multiline values and complete key blocks", () => {
    const lines = [
      "safe heading",
      "api_key =",
      "  abcdefghijklmnopqrstuvwxyz123456",
      "safe middle",
      "-----BEGIN RSA PRIVATE KEY-----",
      "fixture-only-private-material",
      "-----END RSA PRIVATE KEY-----",
      "safe footer",
    ];
    const content = lines.join("\r\n");
    const result = redactLikelySecretLines(content);
    expect(result.redactedLines).toEqual([2, 3, 5, 6, 7]);
    expect(result.content.length).toBe(content.length);
    expect(result.content.split("\r\n")).toHaveLength(lines.length);
    expect(result.content).toContain("safe middle");
    expect(result.content).not.toContain("abcdefghijklmnop");
    expect(result.content).not.toContain("fixture-only-private-material");
    expect(redactLikelySecretLines("api_key=short\nsafe")).toEqual({ content: "api_key=short\nsafe", redactedLines: [] });
    const unclosedKey = "safe\n-----BEGIN ENCRYPTED " + "PRIVATE KEY-----\nfixture";
    expect(redactLikelySecretLines(unclosedKey).redactedLines).toEqual([2, 3]);
  });

  it("indexes safe fragments and symbols without retaining secrets in any derived index", async () => {
    const { db, project } = await fixture();
    const source = [
      "export function beforeSecret() { return 1; }",
      'const api_key = "abcdefghijklmnopqrstuvwxyz123456";',
      "export function afterSecret() { return beforeSecret(); }",
    ].join("\n");
    await writeFile(join(project.rootPath, "mixed.ts"), source);
    await writeFile(join(project.rootPath, ".env"), "fixture-only-sensitive-path");
    await writeFile(join(project.rootPath, "only-secret.txt"), "password=abcdefghijklmnopqrstuvwxyz123456");
    await indexProject(db, project);
    const rows = db.prepare("SELECT * FROM chunks").all();
    expect(JSON.stringify(rows)).toContain("afterSecret");
    const signature = db.prepare("SELECT name, start_line FROM symbols WHERE name = ?").get("afterSecret");
    expect(signature).toMatchObject({ name: "afterSecret", start_line: 3 });
    for (const table of ["chunks", "chunks_fts", "symbols", "symbols_fts", "relations", "search_ngrams", "metadata", "index_runs"]) {
      expect(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    }
    const report = readContentProtection(db)!;
    expect(report.completed).toBe(true);
    expect(report.redacted).toEqual(expect.arrayContaining([{ path: "mixed.ts", lines: [2] }]));
    expect(report.skipped).toEqual(expect.arrayContaining([
      { path: ".env", reason: "sensitive-path" },
      { path: "only-secret.txt", reason: "no-safe-content" },
    ]));
    expect(await readFile(join(project.rootPath, "mixed.ts"), "utf8")).toBe(source);
    const second = await indexProject(db, project);
    expect(second.indexed).toBe(0);
    expect(readContentProtection(db)?.redacted).toContainEqual({ path: "mixed.ts", lines: [2] });
    await writeFile(join(project.rootPath, "mixed.ts"), "export function afterSecret() { return 2; }");
    await rm(join(project.rootPath, "only-secret.txt"));
    await indexProject(db, project);
    expect(readContentProtection(db)?.redacted).toEqual([]);
    expect(readContentProtection(db)?.skipped).not.toContainEqual({ path: "only-secret.txt", reason: "no-safe-content" });
  });

  it("keeps previously excluded repository test fixtures searchable and reports paths through health and doctor", async () => {
    const { db, project } = await fixture();
    await mkdir(join(project.rootPath, "tests"));
    for (const name of ["integration.test.ts", "storage-maintenance.test.ts"]) {
      const sourcePath = fileURLToPath(new URL(`./${name}`, import.meta.url));
      await writeFile(join(project.rootPath, "tests", name), await readFile(sourcePath));
    }
    await indexProject(db, project);
    expect(db.prepare("SELECT path FROM sources ORDER BY path").pluck().all()).toEqual([
      "tests/integration.test.ts", "tests/storage-maintenance.test.ts",
    ]);
    const report = readContentProtection(db)!;
    expect(report.redacted.map((item) => item.path).sort()).toEqual([
      "tests/integration.test.ts", "tests/storage-maintenance.test.ts",
    ]);
    const app = Object.create(ProjectContextApp.prototype) as ProjectContextApp;
    Object.assign(app, {
      projects: { get: () => project },
      withDb: (_id: string, callback: (connection: SqliteDatabase) => unknown) => callback(db),
      withDbAsync: (_id: string, callback: (connection: SqliteDatabase) => unknown) => callback(db),
    });
    expect(app.health(project.id)).toMatchObject({ contentProtection: report });
    expect(await app.doctor(project.id)).toMatchObject({ ok: true, contentProtection: report });
  });
});
