/** Pure, conservative recommendations for reducing an index. */

export interface ProjectTypeEvidence {
  name: string;
  evidence: string[];
}

export interface IndexRecommendation {
  recommended: boolean;
  reason: string;
}

export interface IndexRecommendationAnalysis {
  projectTypes: ProjectTypeEvidence[];
  recommendations: Record<string, IndexRecommendation>;
}

const slash = (value: string) => value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
const lower = (value: string) => slash(value).toLowerCase();
const base = (value: string) => lower(value).split("/").pop() ?? "";
const under = (file: string, dir: string) => {
  const f = lower(file); const d = lower(dir);
  return f === d || f.startsWith(`${d}/`);
};
const hasFile = (files: string[], dir: string, names: string[]) => files.some(f => under(f, dir) && names.includes(base(f)));
const hasExtension = (files: string[], extensions: string[]) => files.some(f => extensions.some(e => lower(f).endsWith(e)));
const evidence = (files: string[], predicate: (f: string) => boolean) => files.filter(predicate).slice(0, 3).map(slash);
const hasOrdinarySource = (files: string[]) => files.some(f => /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|cs|fs|vb|java|kt|kts|py|rs|go|vue|svelte|jsx|tsx|ts)$/i.test(lower(f)));

/**
 * Analyze indexed paths without reading the filesystem. Recommendations are
 * deliberately conservative: an ordinary directory called bin/lib/include/
 * src is never selected merely because of its name.
 */
export function analyzeIndexRecommendations(sourcePaths: string[], directoryPaths: string[]): IndexRecommendationAnalysis {
  const files = [...new Set(sourcePaths.map(slash).filter(Boolean))];
  const projectTypes: ProjectTypeEvidence[] = [];
  const addType = (name: string, matches: string[]) => { if (matches.length) projectTypes.push({ name, evidence: matches.slice(0, 3) }); };

  addType("C/C++", evidence(files, f => ["cmakelists.txt", "makefile", "meson.build", ".sln"].includes(base(f)) || /\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/.test(lower(f))));
  addType("Keil/IAR", evidence(files, f => /\.(uvprojx?|uvoptx?|ewp|eww|ewd)$/.test(lower(f))));
  addType("JavaScript/TypeScript", evidence(files, f => ["package.json", "pnpm-lock.yaml", "yarn.lock", "package-lock.json", "tsconfig.json"].includes(base(f)) || /\.(js|jsx|ts|tsx)$/.test(lower(f))));
  addType("Vue", evidence(files, f => base(f) === "vue.config.js" || base(f) === "vite.config.ts" || /\.vue$/.test(lower(f))));
  addType("React", evidence(files, f => base(f) === "next.config.js" || base(f) === "next.config.mjs" || /\.(jsx|tsx)$/.test(lower(f))));
  addType("Angular", evidence(files, f => base(f) === "angular.json" || base(f) === ".angular-cli.json"));
  addType("Svelte", evidence(files, f => base(f) === "svelte.config.js" || /\.svelte$/.test(lower(f))));
  addType("Python", evidence(files, f => ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "poetry.lock", "pipfile"].includes(base(f)) || /\.py$/.test(lower(f))));
  addType("Java/Kotlin", evidence(files, f => ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradlew"].includes(base(f)) || /\.(java|kt|kts)$/.test(lower(f))));
  addType("Rust", evidence(files, f => ["cargo.toml", "cargo.lock"].includes(base(f)) || /\.rs$/.test(lower(f))));
  addType("Go", evidence(files, f => base(f) === "go.mod" || base(f) === "go.sum" || /\.go$/.test(lower(f))));
  addType(".NET", evidence(files, f => /\.(csproj|fsproj|vbproj|sln)$/.test(lower(f)) || ["global.json", "packages.config"].includes(base(f)) || /\.(cs|fs|vb)$/.test(lower(f))));

  const candidates = [...new Set(directoryPaths.map(slash).filter(Boolean))];
  const raw: Array<[string, IndexRecommendation]> = [];
  for (const dir of candidates) {
    const name = base(dir);
    const filesHere = files.filter(f => under(f, dir));
    const namesHere = new Set(filesHere.map(base));
    let reason: string | undefined;

    if ([".kilo/worktrees", ".claude/worktrees", ".codex/worktrees", ".worktrees"].some(root => lower(dir) === root || lower(dir).endsWith(`/${root}`))) {
      reason = "工作树容器，包含重复检出内容";
    } else if (["node_modules", ".pnpm", ".yarn", ".gradle", ".idea", "__pycache__", ".pytest_cache", ".mypy_cache", ".venv", "venv"].includes(name)) {
      reason = "工具或依赖缓存目录";
    } else if ([".nuxt", ".output", ".next", ".angular", ".angular/cache", ".svelte-kit", ".vite", ".turbo", ".parcel-cache", ".webpack-cache"].some(cache => name === cache || lower(dir).endsWith(`/${cache}`))) {
      const frontend = projectTypes.some(type => ["JavaScript/TypeScript", "Vue", "React", "Angular", "Svelte"].includes(type.name));
      if (frontend && filesHere.length > 0) reason = "前端框架生成目录或构建缓存（依据项目类型与目录内容）";
    } else if (["storybook-static", "coverage", "playwright-report", "test-results"].includes(name)) {
      if (filesHere.length > 0) reason = "测试或文档构建产物目录";
    } else if (namesHere.has("cmakecache.txt") && [...namesHere].some(n => n === "cmakefiles" || filesHere.some(f => under(f, `${dir}/CMakeFiles`)))) {
      const ordinary = filesHere.some(f => /\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/.test(lower(f)) && !under(f, `${dir}/cmakefiles`));
      if (!ordinary) reason = "CMake 生成目录（CMakeCache 与 CMakeFiles）";
    } else if (/^cmake-build[-_]/.test(name) && hasFile(files, dir, ["cmakecache.txt"])) {
      reason = "CMake 生成目录";
    } else if (["dist", "out"].includes(name) && filesHere.some(f => /\.(map|min\.js|min\.css)$/.test(lower(f))) && !hasOrdinarySource(filesHere)) {
      reason = "构建输出（含压缩或 source map 文件）";
    } else if (name === "target" && filesHere.some(f => base(f) === "cargo.toml" || /\/debug\//.test(lower(f)) || /\/release\//.test(lower(f)))) {
      reason = "Rust 构建输出目录";
    } else if (["obj", "bin"].includes(name) && filesHere.some(f => /\.(dll|pdb|deps\.json|runtimeconfig\.json)$/.test(lower(f))) && !hasOrdinarySource(filesHere)) {
      reason = ".NET 构建输出目录（含编译产物）";
    } else if (name === "build" && filesHere.some(f => /\.(o|obj|class|jar|dll|so|a|lib)$/.test(lower(f))) && !hasOrdinarySource(filesHere)) {
      // A build directory is only selected with concrete generated binaries.
      reason = "构建输出目录（含编译产物）";
    }
    if (reason) raw.push([dir, { recommended: true, reason }]);
  }

  // Avoid recommending both a container and its generated child. Keep the
  // shallowest explicitly selected container (the smallest rule set).
  const recommendations: Record<string, IndexRecommendation> = {};
  for (const [dir, rec] of raw.sort((a, b) => a[0].length - b[0].length)) {
    if (!raw.some(([parent]) => parent !== dir && under(dir, parent))) recommendations[dir] = rec;
  }
  for (const dir of candidates) if (!recommendations[dir]) recommendations[dir] = { recommended: false, reason: "未发现明确的生成或重复内容证据" };
  return { projectTypes, recommendations };
}
