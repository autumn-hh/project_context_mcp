import { describe, expect, it } from "vitest";
import { analyzeIndexRecommendations } from "../src/maintenance/index-recommendations.js";

describe("analyzeIndexRecommendations", () => {
  it("detects languages from manifests in their own evidence", () => {
    const result = analyzeIndexRecommendations([
      "firmware/CMakeLists.txt", "firmware/main.c", "firmware/include/main.h",
      "web/package.json", "web/src/app.ts", "tools/pyproject.toml", "tools/a.py",
    ], ["firmware/build", "web/node_modules", "tools/.venv"]);
    expect(result.projectTypes.map(x => x.name)).toEqual(expect.arrayContaining(["C/C++", "JavaScript/TypeScript", "Python"]));
    expect(result.projectTypes.find(x => x.name === "C/C++")?.evidence).toContain("firmware/CMakeLists.txt");
    expect(result.recommendations["web/node_modules"].recommended).toBe(true);
    expect(result.recommendations["tools/.venv"].recommended).toBe(true);
  });

  it("protects C/C++ source and headers in an in-source CMake tree", () => {
    const result = analyzeIndexRecommendations([
      "src/CMakeCache.txt", "src/CMakeFiles/cmake.check_cache", "src/main.c", "src/include/api.h",
    ], ["src"]);
    expect(result.recommendations.src.recommended).toBe(false);
  });

  it("does not infer generated output from ordinary bin/lib names or Makefile", () => {
    const result = analyzeIndexRecommendations([
      "Makefile", "bin/tool.c", "lib/math.c", "include/math.h",
    ], ["bin", "lib", "include"]);
    expect(result.projectTypes.map(x => x.name)).toContain("C/C++");
    expect(result.recommendations.bin.recommended).toBe(false);
    expect(result.recommendations.lib.recommended).toBe(false);
  });

  it("recognizes generated outputs with concrete evidence", () => {
    const result = analyzeIndexRecommendations([
      "app/package.json", "app/dist/main.min.js", "app/dist/main.js.map",
      "service/Cargo.toml", "service/target/debug/app", "service/target/release/app",
      "dotnet/App.csproj", "dotnet/bin/Debug/App.dll", "dotnet/bin/Debug/App.pdb",
    ], ["app/dist", "service/target", "dotnet/bin"]);
    expect(result.recommendations["app/dist"].recommended).toBe(true);
    expect(result.recommendations["service/target"].recommended).toBe(true);
    expect(result.recommendations["dotnet/bin"].recommended).toBe(true);
  });

  it("keeps worktree containers and avoids parent-child duplicate recommendations", () => {
    const result = analyzeIndexRecommendations([
      ".kilo/worktrees/a/package.json", ".kilo/worktrees/a/dist/app.min.js",
    ], [".kilo/worktrees", ".kilo/worktrees/a", ".kilo/worktrees/a/dist"]);
    expect(result.recommendations[".kilo/worktrees"].recommended).toBe(true);
    expect(result.recommendations[".kilo/worktrees/a"].recommended).toBe(false);
    expect(result.recommendations[".kilo/worktrees/a/dist"].recommended).toBe(false);
  });

  it("does not recommend a directory without evidence, including mixed projects", () => {
    const result = analyzeIndexRecommendations([
      "cpp/CMakeLists.txt", "cpp/main.cpp", "frontend/package.json", "frontend/src/main.ts",
      "shared/bin/readme.txt", "shared/lib/README.md",
    ], ["shared", "shared/bin", "shared/lib"]);
    expect(result.projectTypes.map(x => x.name)).toEqual(expect.arrayContaining(["C/C++", "JavaScript/TypeScript"]));
    expect(result.recommendations.shared.recommended).toBe(false);
    expect(result.recommendations["shared/bin"].recommended).toBe(false);
  });

  it("recognizes common frontend frameworks and recommends their generated caches", () => {
    const result = analyzeIndexRecommendations([
      "vue/package.json", "vue/src/App.vue", "vue/.nuxt/routes.mjs", "vue/.output/server/index.mjs", "vue/dist/app.min.js",
      "react/package.json", "react/src/App.tsx", "react/.next/server/pages-manifest.json",
      "angular/angular.json", "angular/src/app/app.component.ts", "angular/.angular/cache/17/file",
      "svelte/svelte.config.js", "svelte/src/App.svelte", "svelte/.svelte-kit/output/server.js",
    ], ["vue/src", "vue/.nuxt", "vue/.output", "vue/dist", "react/src", "react/.next", "angular/.angular/cache", "svelte/src", "svelte/.svelte-kit"]);
    expect(result.projectTypes.map(x => x.name)).toEqual(expect.arrayContaining(["Vue", "React", "Angular", "Svelte"]));
    for (const directory of ["vue/.nuxt", "vue/.output", "vue/dist", "react/.next", "angular/.angular/cache", "svelte/.svelte-kit"]) {
      expect(result.recommendations[directory].recommended).toBe(true);
    }
    for (const directory of ["vue/src", "react/src", "svelte/src"]) {
      expect(result.recommendations[directory].recommended).toBe(false);
    }
  });

  it("protects mixed source and generated output directories", () => {
    const result = analyzeIndexRecommendations([
      "web/dist/app.vue", "web/dist/app.js.map", "dotnet/bin/Program.cs", "dotnet/bin/Program.dll",
      "native/build/main.cpp", "native/build/main.o",
    ], ["web/dist", "dotnet/bin", "native/build"]);
    expect(result.recommendations["web/dist"].recommended).toBe(false);
    expect(result.recommendations["dotnet/bin"].recommended).toBe(false);
    expect(result.recommendations["native/build"].recommended).toBe(false);
  });
});
