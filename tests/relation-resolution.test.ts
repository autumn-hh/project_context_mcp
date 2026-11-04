import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { indexProject } from "../src/indexing/indexer.js";
import { openDatabase, type SqliteDatabase } from "../src/storage/database.js";
import { migrateProject } from "../src/storage/schema.js";
import type { ProjectRecord } from "../src/projects/project-service.js";

const roots: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function indexed(files: Record<string, string>): Promise<SqliteDatabase> {
  const root = await mkdtemp(join(tmpdir(), "context-relations-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content, "utf8");
  }
  const db = openDatabase(":memory:");
  databases.push(db);
  migrateProject(db);
  await indexProject(db, { id: "prj_relations", rootPath: root } as ProjectRecord);
  return db;
}

/** Each relation of a type as `to_name -> target`, where the target is a qualified symbol name or a path. */
function targets(db: SqliteDatabase, sourcePath: string, type: string): Record<string, string | null> {
  const rows = db.prepare(`
    SELECT r.to_name AS name, COALESCE(s.qualified_name, t.to_source_path) AS target
    FROM relations r LEFT JOIN relation_targets t ON t.relation_id = r.id LEFT JOIN symbols s ON s.id = t.to_symbol_id
    WHERE r.source_path = ? AND r.relation_type = ?`).all(sourcePath, type) as Array<{ name: string; target: string | null }>;
  return Object.fromEntries(rows.map((row) => [row.name, row.target]));
}

describe("cross-file relation targets", () => {
  it("resolves Java calls through imports, packages, field types, supertypes and overloads", async () => {
    const base = "src/main/java/com/app";
    const db = await indexed({
      [`${base}/base/BaseService.java`]: "package com.app.base;\npublic interface BaseService<T> { T queryByKey(String id); }\n",
      [`${base}/service/UserService.java`]: "package com.app.service;\nimport com.app.base.BaseService;\npublic interface UserService extends BaseService<Object> { void lock(String id); void lock(int id); }\n",
      [`${base}/dao/UserMapper.java`]: "package com.app.dao;\npublic interface UserMapper { int insertSelective(Object row); }\n",
      [`${base}/web/BaseController.java`]: "package com.app.web;\npublic class BaseController { protected void render() {} }\n",
      [`${base}/web/Helper.java`]: "package com.app.web;\npublic class Helper { static String label(String s) { return s; } }\n",
      [`${base}/web/UserController.java`]: [
        "package com.app.web;",
        "import com.app.service.UserService;",
        "import com.app.dao.*;",
        "import java.util.List;",
        "public class UserController extends BaseController {",
        "  private UserService userService;",
        "  private UserMapper userMapper;",
        "  public void handle(String id) {",
        "    userService.queryByKey(id); this.userService.lock(id); userMapper.insertSelective(id);",
        "    render(); Helper.label(id); new Helper();",
        "  }",
        "}",
      ].join("\n"),
    });
    const controller = `${base}/web/UserController.java`;
    expect(targets(db, controller, "CALLS")).toEqual({
      "UserService.queryByKey": `${base}/base/BaseService.java#BaseService#queryByKey`,
      "UserService.lock": `${base}/service/UserService.java#UserService#lock`,
      "UserMapper.insertSelective": `${base}/dao/UserMapper.java#UserMapper#insertSelective`,
      render: `${base}/web/BaseController.java#BaseController#render`,
      "Helper.label": `${base}/web/Helper.java#Helper#label`,
      "new Helper": `${base}/web/Helper.java#Helper`,
    });
    expect(targets(db, controller, "IMPORTS")).toEqual({
      "com.app.service.UserService": `${base}/service/UserService.java`, "com.app.dao.*": null, "java.util.List": null,
    });
    expect(targets(db, controller, "EXTENDS")).toEqual({ BaseController: `${base}/web/BaseController.java#BaseController` });
  });

  it("resolves PHP use clauses and includes and C quoted includes, leaving system headers alone", async () => {
    const db = await indexed({
      "lib/db.php": "<?php\nfunction db_connect() {}\n",
      "app/Models/User.php": "<?php\nnamespace App\\Models;\nclass User { public static function find($id) {} }\n",
      "index.php": "<?php\nrequire_once __DIR__ . '/lib/db.php';\nuse App\\Models\\User;\ndb_connect();\nUser::find(1);\n",
      "src/util.h": "int add(int a, int b);\n",
      "src/util.c": "#include \"util.h\"\nint add(int a, int b) { return a + b; }\n",
      "src/main.c": "#include \"util.h\"\n#include <stdio.h>\nint main(void) { return add(1, 2); }\n",
    });
    expect(targets(db, "index.php", "IMPORTS")).toEqual({ "/lib/db.php": "lib/db.php", "App\\Models\\User": "app/Models/User.php" });
    expect(targets(db, "index.php", "CALLS")).toEqual({ db_connect: "lib/db.php#db_connect", "User.find": "app/Models/User.php#User#find" });
    expect(targets(db, "src/main.c", "IMPORTS")).toEqual({ "util.h": "src/util.h", "stdio.h": null });
    expect(targets(db, "src/main.c", "CALLS")).toEqual({ add: "src/util.c#add" });
  });
});
