import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { authorizeExistingPath, authorizeOutputPath } from "../src/security/path-policy.js";

describe("path policy", () => {
  const roots: string[] = [];
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

  // A junction (Windows) or symlink stands in for any non-canonical spelling of an allowed root,
  // such as the 8.3 short names GitHub's Windows runners use for the temp directory.
  it("accepts files inside an allowed root given through a link, and still rejects outside paths", async () => {
    const base = await mkdtemp(join(tmpdir(), "path-policy-"));
    roots.push(base);
    const real = join(base, "real");
    const outside = join(base, "outside");
    await mkdir(join(real, "project"), { recursive: true });
    await mkdir(outside, { recursive: true });
    const link = join(base, "linked");
    await symlink(real, link, "junction");

    await expect(authorizeExistingPath(join(link, "project"), [link], "ROOT", "Project root")).resolves.toBe(join(real, "project"));
    await expect(authorizeExistingPath(join(real, "project"), [link], "ROOT", "Project root")).resolves.toBe(join(real, "project"));
    await expect(authorizeOutputPath(join(link, "project", "out.json"), [link])).resolves.toBe(join(real, "project", "out.json"));
    await expect(authorizeExistingPath(outside, [link], "ROOT", "Project root")).rejects.toMatchObject({ code: "ROOT" });
  });
});
