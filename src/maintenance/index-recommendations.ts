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
// All comparisons use already normalized, lowercase paths. Keep the original
// spelling separately for evidence and recommendation keys.
const base = (value: string) => value.slice(value.lastIndexOf("/") + 1);
const cppSource = /\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/;
const ordinarySource = /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|cs|fs|vb|java|kt|kts|py|rs|go|vue|svelte|jsx|tsx|ts)$/;
interface DirectoryEvidence {
  count: number;
  cmakeCache: boolean;
  cmakeFiles: boolean;
  ordinaryCpp: boolean;
  ordinarySource: boolean;
  compressed: boolean;
  rust: boolean;
  dotnet: boolean;
  binary: boolean;
}
const emptyEvidence = (): DirectoryEvidence => ({
  count: 0, cmakeCache: false, cmakeFiles: false, ordinaryCpp: false,
  ordinarySource: false, compressed: false, rust: false, dotnet: false, binary: false,
});

/**
 * Analyze indexed paths without reading the filesystem. Recommendations are
 * deliberately conservative: an ordinary directory called bin/lib/include/
 * src is never selected merely because of its name.
 */
export function analyzeIndexRecommendations(sourcePaths: string[], directoryPaths: string[]): IndexRecommendationAnalysis {
  const files = [...new Set(sourcePaths.map(slash).filter(Boolean))];
  const candidates = [...new Set(directoryPaths.map(slash).filter(Boolean))];
  const normalizedDirectories = new Map(candidates.map(dir => [dir, dir.toLowerCase()]));
  const directoryEvidence = new Map<string, DirectoryEvidence>();
  for (const dir of normalizedDirectories.values()) directoryEvidence.set(dir, emptyEvidence());
  const types = new Map<string, string[]>();
  for (const original of files) {
    const f = original.toLowerCase();
    const name = base(f);
    const collectType = (type: string, matches: boolean) => {
      if (!matches) return;
      const paths = types.get(type) ?? [];
      if (paths.length < 3) paths.push(original);
      types.set(type, paths);
    };
    collectType("C/C++", ["cmakelists.txt", "makefile", "meson.build", ".sln"].includes(name) || /\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/.test(f));
    collectType("Keil/IAR", /\.(uvprojx?|uvoptx?|ewp|eww|ewd)$/.test(f));
    collectType("JavaScript/TypeScript", ["package.json", "pnpm-lock.yaml", "yarn.lock", "package-lock.json", "tsconfig.json"].includes(name) || /\.(js|jsx|ts|tsx)$/.test(f));
    collectType("Vue", name === "vue.config.js" || name === "vite.config.ts" || /\.vue$/.test(f));
    collectType("React", name === "next.config.js" || name === "next.config.mjs" || /\.(jsx|tsx)$/.test(f));
    collectType("Angular", name === "angular.json" || name === ".angular-cli.json");
    collectType("Svelte", name === "svelte.config.js" || /\.svelte$/.test(f));
    collectType("Python", ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "poetry.lock", "pipfile"].includes(name) || /\.py$/.test(f));
    collectType("Java/Kotlin", ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradlew"].includes(name) || /\.(java|kt|kts)$/.test(f));
    collectType("Rust", ["cargo.toml", "cargo.lock"].includes(name) || /\.rs$/.test(f));
    collectType("Go", name === "go.mod" || name === "go.sum" || /\.go$/.test(f));
    collectType(".NET", /\.(csproj|fsproj|vbproj|sln)$/.test(f) || ["global.json", "packages.config"].includes(name) || /\.(cs|fs|vb)$/.test(f));
    const isCpp = cppSource.test(f);
    const isOrdinary = ordinarySource.test(f);
    const compressed = /\.(map|min\.js|min\.css)$/.test(f);
    const rust = name === "cargo.toml" || /\/(debug|release)\//.test(f);
    const dotnet = /\.(dll|pdb|deps\.json|runtimeconfig\.json)$/.test(f);
    const binary = /\.(o|obj|class|jar|dll|so|a|lib)$/.test(f);
    // Visit only this file's ancestors, never the complete file list for each
    // candidate directory. Cost is proportional to paths and their depth.
    for (let dir = f; dir; ) {
      const stats = directoryEvidence.get(dir);
      if (stats) {
        const relative = f.slice(dir.length + 1);
        const inCmakeFiles = relative === "cmakefiles" || relative.startsWith("cmakefiles/");
        stats.count++;
        stats.cmakeCache ||= name === "cmakecache.txt";
        stats.cmakeFiles ||= name === "cmakefiles" || inCmakeFiles;
        stats.ordinaryCpp ||= isCpp && !inCmakeFiles;
        stats.ordinarySource ||= isOrdinary;
        stats.compressed ||= compressed;
        stats.rust ||= rust;
        stats.dotnet ||= dotnet;
        stats.binary ||= binary;
      }
      const separator = dir.lastIndexOf("/");
      if (separator < 0) break;
      dir = dir.slice(0, separator);
    }
  }
  // Preserve the public ordering independent of which manifest was seen first.
  const typeOrder = ["C/C++", "Keil/IAR", "JavaScript/TypeScript", "Vue", "React", "Angular", "Svelte", "Python", "Java/Kotlin", "Rust", "Go", ".NET"];
  const projectTypes = typeOrder.flatMap(name => types.has(name) ? [{ name, evidence: types.get(name)! }] : []);
  const frontend = projectTypes.some(type => ["JavaScript/TypeScript", "Vue", "React", "Angular", "Svelte"].includes(type.name));
  const raw: Array<[string, IndexRecommendation]> = [];
  for (const dir of candidates) {
    const normalized = normalizedDirectories.get(dir)!;
    const name = base(normalized);
    const stats = directoryEvidence.get(normalized)!;
    let reason: string | undefined;

    if ([".kilo/worktrees", ".claude/worktrees", ".codex/worktrees", ".worktrees"].some(root => normalized === root || normalized.endsWith(`/${root}`))) {
      reason = "工作树容器，包含重复检出内容";
    } else if (["node_modules", ".pnpm", ".yarn", ".gradle", ".idea", "__pycache__", ".pytest_cache", ".mypy_cache", ".venv", "venv"].includes(name)) {
      reason = "工具或依赖缓存目录";
    } else if ([".nuxt", ".output", ".next", ".angular", ".angular/cache", ".svelte-kit", ".vite", ".turbo", ".parcel-cache", ".webpack-cache"].some(cache => name === cache || normalized.endsWith(`/${cache}`))) {
      if (frontend && stats.count > 0) reason = "前端框架生成目录或构建缓存（依据项目类型与目录内容）";
    } else if (["storybook-static", "coverage", "playwright-report", "test-results"].includes(name)) {
      if (stats.count > 0) reason = "测试或文档构建产物目录";
    } else if (stats.cmakeCache && stats.cmakeFiles) {
      if (!stats.ordinaryCpp) reason = "CMake 生成目录（CMakeCache 与 CMakeFiles）";
    } else if (/^cmake-build[-_]/.test(name) && stats.cmakeCache) {
      reason = "CMake 生成目录";
    } else if (["dist", "out"].includes(name) && stats.compressed && !stats.ordinarySource) {
      reason = "构建输出（含压缩或 source map 文件）";
    } else if (name === "target" && stats.rust) {
      reason = "Rust 构建输出目录";
    } else if (["obj", "bin"].includes(name) && stats.dotnet && !stats.ordinarySource) {
      reason = ".NET 构建输出目录（含编译产物）";
    } else if (name === "build" && stats.binary && !stats.ordinarySource) {
      reason = "构建输出目录（含编译产物）";
    }
    if (reason) raw.push([dir, { recommended: true, reason }]);
  }

  // Avoid recommending both a container and its generated child. Keep the
  // shallowest explicitly selected container (the smallest rule set).
  const recommendations: Record<string, IndexRecommendation> = {};
  const selected = new Map<string, number>();
  for (const [dir] of raw) {
    const normalized = normalizedDirectories.get(dir)!;
    selected.set(normalized, (selected.get(normalized) ?? 0) + 1);
  }
  for (const [dir, rec] of raw.sort((a, b) => a[0].length - b[0].length)) {
    const normalized = normalizedDirectories.get(dir)!;
    // Case-only aliases retain the existing conservative suppression behavior.
    let covered = selected.get(normalized)! > 1;
    for (let separator = normalized.lastIndexOf("/"); !covered && separator >= 0; separator = normalized.lastIndexOf("/", separator - 1)) {
      covered = selected.has(normalized.slice(0, separator));
      if (separator === 0) break;
    }
    if (!covered) recommendations[dir] = rec;
  }
  for (const dir of candidates) if (!recommendations[dir]) recommendations[dir] = { recommended: false, reason: "未发现明确的生成或重复内容证据" };
  return { projectTypes, recommendations };
}
