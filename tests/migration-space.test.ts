import { describe, expect, it } from "vitest";
import { checkMigrationSpace, migrationFailureMessage, probeSpace } from "../src/maintenance/migration-space.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MiB = 1024 * 1024;
const input = { databasePath: join(tmpdir(), "db", "project.db"), databaseBytes: 100 * MiB, walBytes: 20 * MiB, backupDirectory: join(tmpdir(), "backups"), temporaryDirectory: tmpdir() };

describe("migration disk space preflight", () => {
  it("combines database, backup and temporary demands sharing a volume", async () => {
    const result = await checkMigrationSpace(input, async () => ({ volume: "same", availableBytes: 500 * MiB }));
    expect(result.sufficient).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ requiredBytes: (120 * 4 + 64) * MiB, shortfallBytes: 44 * MiB });
    expect(result.checks[0]!.roles).toHaveLength(3);
  });

  it("checks temporary disk separately instead of assuming database disk has all the space", async () => {
    const result = await checkMigrationSpace(input, async path => ({ volume: path, availableBytes: path === tmpdir() ? MiB : 1e12 }));
    expect(result.sufficient).toBe(false);
    expect(result.checks).toHaveLength(3);
    expect(result.checks.find(row => row.path === tmpdir())!.shortfallBytes).toBeGreaterThan(0);
  });

  it("blocks when any filesystem cannot be checked", async () => {
    const result = await checkMigrationSpace(input, async () => { throw new Error("access denied"); });
    expect(result.sufficient).toBe(false);
    expect(result.checks.every(row => row.availableBytes === null && row.shortfallBytes === null)).toBe(true);
    expect(result.warnings.join(" ")).toContain("access denied");
  });

  it("compaction reserves no backup or index WAL allocation", async () => {
    const result = await checkMigrationSpace({ ...input, mode: "compact" }, async () => ({ volume: "same", availableBytes: 400 * MiB }));
    expect(result.sufficient).toBe(true);
    expect(result.checks[0]!.requiredBytes).toBe((120 * 2 + 64) * MiB);
    expect(result.checks[0]!.roles).toHaveLength(2);
  });

  it("probes an existing ancestor without creating the backup directory", async () => {
    const result = await probeSpace(join(tmpdir(), `not-created-${Date.now()}`, "backups"));
    expect(result.availableBytes).toBeGreaterThanOrEqual(0);
    expect(result.volume).toBeTruthy();
  });

  it("translates SQLITE_FULL while retaining its diagnostic", () => {
    expect(migrationFailureMessage(new Error("database or disk is full"))).toContain("磁盘空间不足");
    expect(migrationFailureMessage(new Error("database or disk is full"))).toContain("database or disk is full");
  });
});
