import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ProjectContextApp } from "../core/app.js";
import type { SearchHit } from "../search/search-service.js";

export interface QualityMetrics {
  search: {
    cases: number;
    recallAt1: number;
    recallAt5: number;
    mrr: number;
    results: Array<{
      id: string;
      query: string;
      rank: number | null;
      top: Array<{ kind: SearchHit["kind"]; title: string; source: string | null; score: number }>;
    }>;
  };
  context: {
    requiredRecall: number;
    selectedMemoryPrecision: number;
    budgetRespected: boolean;
  };
  candidates: {
    expected: number;
    generated: number;
    precision: number;
    recall: number;
    typeAccuracy: number;
  };
}

export interface PerformanceMetrics {
  files: number;
  initialIndexMs: number;
  incrementalIndexMs: number;
  queryLatencyMs: { p50: number; p95: number };
  contextLatencyMs: { p50: number; p95: number };
}

export interface EvaluationReport {
  schemaVersion: 1;
  implementationVersion: string;
  generatedAt: string;
  environment: { node: string; platform: NodeJS.Platform; arch: string };
  quality: QualityMetrics;
  performance: PerformanceMetrics;
  thresholds: EvaluationThresholds;
  passed: boolean;
}

export interface EvaluationThresholds {
  searchRecallAt5: number;
  searchMrr: number;
  contextRequiredRecall: number;
  contextMemoryPrecision: number;
  candidatePrecision: number;
  candidateRecall: number;
  candidateTypeAccuracy: number;
}

export const DEFAULT_THRESHOLDS: EvaluationThresholds = {
  searchRecallAt5: 1,
  searchMrr: 0.8,
  contextRequiredRecall: 1,
  contextMemoryPrecision: 1,
  candidatePrecision: 1,
  candidateRecall: 1,
  candidateTypeAccuracy: 1,
};

interface SearchCase {
  id: string;
  query: string;
  matches: (hit: SearchHit) => boolean;
}

export async function runEvaluation(iterations = 30): Promise<EvaluationReport> {
  const tempRoot = await mkdtemp(join(tmpdir(), "project-context-eval-"));
  const previousEnvironment = captureEnvironment();
  process.env.PROJECT_CONTEXT_HOME = join(tempRoot, "memory");
  process.env.PROJECT_CONTEXT_ALLOWED_ROOTS = tempRoot;
  process.env.PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS = tempRoot;

  try {
    const qualityProject = join(tempRoot, "quality-project");
    const candidateProject = join(tempRoot, "candidate-project");
    const performanceProject = join(tempRoot, "performance-project");
    await createQualityFixture(qualityProject);
    const fileCount = await createQualityFixture(performanceProject);
    await createCandidateFixture(candidateProject);
    const app = await ProjectContextApp.create();
    try {
      const quality = await evaluateQuality(app, qualityProject, candidateProject);
      const performanceMetrics = await measurePerformance(app, performanceProject, fileCount, iterations);
      const report: EvaluationReport = {
        schemaVersion: 1,
        implementationVersion: await implementationVersion(),
        generatedAt: new Date().toISOString(),
        environment: { node: process.version, platform: process.platform, arch: process.arch },
        quality,
        performance: performanceMetrics,
        thresholds: DEFAULT_THRESHOLDS,
        passed: passesThresholds(quality, DEFAULT_THRESHOLDS),
      };
      return report;
    } finally {
      app.close();
    }
  } finally {
    restoreEnvironment(previousEnvironment);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export function passesThresholds(quality: QualityMetrics, thresholds: EvaluationThresholds): boolean {
  return quality.search.recallAt5 >= thresholds.searchRecallAt5
    && quality.search.mrr >= thresholds.searchMrr
    && quality.context.requiredRecall >= thresholds.contextRequiredRecall
    && quality.context.selectedMemoryPrecision >= thresholds.contextMemoryPrecision
    && quality.context.budgetRespected
    && quality.candidates.precision >= thresholds.candidatePrecision
    && quality.candidates.recall >= thresholds.candidateRecall
    && quality.candidates.typeAccuracy >= thresholds.candidateTypeAccuracy;
}

async function evaluateQuality(
  app: ProjectContextApp,
  qualityRoot: string,
  candidateRoot: string,
): Promise<QualityMetrics> {
  const project = await app.openProject(qualityRoot);
  await app.index(project.id);
  const rotationDecision = app.remember(project.id, {
    type: "decision",
    title: "Refresh token rotation",
    content: "Refresh tokens rotate after every successful use.",
    scope: ["src/auth.ts"],
    sourceKind: "user",
  });
  const auditConstraint = app.remember(project.id, {
    type: "constraint",
    title: "Local audit storage",
    content: "Authentication audit records must remain on the local machine.",
    scope: ["src/auth.ts"],
    sourceKind: "user",
  });
  app.remember(project.id, {
    type: "constraint",
    title: "Authentication audit scope check",
    content: "Authentication audit records must remain on the local machine.",
    scope: ["src/images.ts"],
    sourceKind: "user",
  });
  app.remember(project.id, {
    type: "constraint",
    title: "Image cache limit",
    content: "Image cache entries must be evicted after one hour.",
    scope: ["src/images.ts"],
    sourceKind: "user",
  });

  const cases: SearchCase[] = [
    { id: "document-en", query: "refresh token rotation", matches: (hit) => hit.source === "README.md" },
    { id: "document-cjk", query: "刷新令牌重用检测", matches: (hit) => hit.source === "docs/authentication.md" },
    { id: "document-cjk-substring", query: "令牌家族撤销", matches: (hit) => hit.source === "docs/authentication.md" },
    {
      id: "document-cjk-task",
      query: "刷新令牌重用检测后撤销令牌家族",
      matches: (hit) => hit.source === "docs/authentication.md",
    },
    {
      id: "function-symbol",
      query: "refreshToken",
      matches: (hit) => hit.kind === "symbol" && hit.source === "src/auth.ts" && hit.title.includes("refreshToken"),
    },
    {
      id: "interface-symbol",
      query: "SessionStore",
      matches: (hit) => hit.kind === "symbol" && hit.source === "src/session.ts" && hit.title.includes("SessionStore"),
    },
    { id: "active-memory", query: "audit records local", matches: (hit) => hit.id === auditConstraint.id },
    {
      id: "graph-seed-symbol",
      query: "entryPoint",
      matches: (hit) => hit.kind === "symbol" && hit.title.includes("#entryPoint"),
    },
    {
      id: "graph-related-symbol",
      query: "entryPoint",
      matches: (hit) => hit.kind === "symbol" && hit.title.includes("#helper"),
    },
  ];
  const caseHits = cases.map((item) => app.search(project.id, item.query, 10));
  const ranks = cases.map((item, caseIndex) => {
    const hits = caseHits[caseIndex]!;
    const index = hits.findIndex(item.matches);
    return index === -1 ? Number.POSITIVE_INFINITY : index + 1;
  });

  const context = app.context(
    project.id,
    "refresh token rotation and local authentication audit records in src/auth.ts",
    2_000,
  );
  const selectedIds = new Set([
    ...context.constraints.map((memory) => memory.id),
    ...context.decisions.map((memory) => memory.id),
    ...context.lessons.map((memory) => memory.id),
  ]);
  const requiredIds = [rotationDecision.id, auditConstraint.id];
  const requiredFound = requiredIds.filter((id) => selectedIds.has(id)).length;
  const smallContext = app.context(project.id, "refresh token rotation", 500);

  const candidate = await app.openProject(candidateRoot);
  const indexed = await app.index(candidate.id);
  const expectedCandidates = [
    { sourceRef: "docs/architecture.md", type: "decision" },
    { sourceRef: "docs/security.md", type: "constraint" },
  ];
  const expectedMatches = expectedCandidates.filter((expected) => indexed.generatedCandidates.some((item) => (
    item.sourceRef === expected.sourceRef && item.type === expected.type
  ))).length;
  const expectedSources = new Set(expectedCandidates.map((item) => item.sourceRef));
  const relevantGenerated = indexed.generatedCandidates.filter((item) => expectedSources.has(item.sourceRef ?? ""));
  const typeMatches = relevantGenerated.filter((item) => expectedCandidates.some((expected) => (
    expected.sourceRef === item.sourceRef && expected.type === item.type
  ))).length;

  return {
    search: {
      cases: cases.length,
      recallAt1: fraction(ranks.filter((rank) => rank <= 1).length, cases.length),
      recallAt5: fraction(ranks.filter((rank) => rank <= 5).length, cases.length),
      mrr: average(ranks.map((rank) => Number.isFinite(rank) ? 1 / rank : 0)),
      results: cases.map((item, index) => ({
        id: item.id,
        query: item.query,
        rank: Number.isFinite(ranks[index]!) ? ranks[index]! : null,
        top: caseHits[index]!.slice(0, 3).map((hit) => ({
          kind: hit.kind,
          title: hit.title,
          source: hit.source,
          score: hit.score,
        })),
      })),
    },
    context: {
      requiredRecall: fraction(requiredFound, requiredIds.length),
      selectedMemoryPrecision: fraction(requiredFound, selectedIds.size),
      budgetRespected: smallContext.budget.usedTokens <= smallContext.budget.requestedTokens,
    },
    candidates: {
      expected: expectedCandidates.length,
      generated: indexed.generatedCandidates.length,
      precision: fraction(relevantGenerated.length, indexed.generatedCandidates.length),
      recall: fraction(expectedMatches, expectedCandidates.length),
      typeAccuracy: fraction(typeMatches, relevantGenerated.length),
    },
  };
}

async function measurePerformance(
  app: ProjectContextApp,
  projectRoot: string,
  files: number,
  iterations: number,
): Promise<PerformanceMetrics> {
  const performanceProject = await app.openProject(projectRoot);
  const initialStart = performance.now();
  await app.index(performanceProject.id);
  const initialIndexMs = performance.now() - initialStart;
  const incrementalStart = performance.now();
  await app.index(performanceProject.id);
  const incrementalIndexMs = performance.now() - incrementalStart;
  const querySamples: number[] = [];
  const contextSamples: number[] = [];
  const queries = ["refresh token rotation", "刷新令牌重用检测", "SessionStore", "audit records local"];
  for (let index = 0; index < Math.max(5, iterations); index += 1) {
    const query = queries[index % queries.length]!;
    const queryStart = performance.now();
    app.search(performanceProject.id, query, 10);
    querySamples.push(performance.now() - queryStart);
    const contextStart = performance.now();
    app.context(performanceProject.id, query, 2_000);
    contextSamples.push(performance.now() - contextStart);
  }
  return {
    files,
    initialIndexMs: round(initialIndexMs),
    incrementalIndexMs: round(incrementalIndexMs),
    queryLatencyMs: { p50: percentile(querySamples, 0.5), p95: percentile(querySamples, 0.95) },
    contextLatencyMs: { p50: percentile(contextSamples, 0.5), p95: percentile(contextSamples, 0.95) },
  };
}

async function createQualityFixture(root: string): Promise<number> {
  const files: Record<string, string> = {
    "README.md": "# Authentication\n\nArchitecture decision: refresh tokens rotate after every successful use.\n",
    "docs/authentication.md": "# 认证设计\n\n刷新令牌重用检测会撤销整个令牌家族。\n",
    "docs/images.md": "# Images\n\nThe image thumbnail cache is stored in memory for fast rendering.\n",
    "src/token.ts": "export function rotateToken(value: string) { return `${value}:rotated`; }\n",
    "src/auth.ts": "import { rotateToken } from './token';\nexport function refreshToken(value: string) { return rotateToken(value); }\n",
    "src/session.ts": "export interface SessionStore { find(id: string): string | undefined; }\nexport class LocalSessionStore implements SessionStore { find(id: string) { return id; } }\n",
    "src/entry.ts": "import { helper } from './helper';\nexport function entryPoint() { return helper(); }\n",
    "src/helper.ts": "import { leaf } from './leaf';\nexport function helper() { return leaf(); }\n",
    "src/leaf.ts": "export function leaf() { return 'leaf'; }\n",
    "src/images.ts": "export function cacheThumbnail(id: string) { return `thumbnail:${id}`; }\n",
  };
  for (let index = 0; index < 40; index += 1) {
    files[`docs/reference-${index}.md`] = `# Reference ${index}\n\nBackground material for module ${index} and routine maintenance.\n`;
  }
  await writeFixture(root, files);
  return Object.keys(files).length;
}

async function createCandidateFixture(root: string): Promise<void> {
  await writeFixture(root, {
    "docs/architecture.md": "# Architecture\n\nDecision: Session identifiers use opaque random values across all clients.\n",
    "docs/security.md": "# Security\n\nConstraint: Authentication audit records must remain on the local machine.\n",
    "docs/guide.md": "# User guide\n\nRun the application and open the settings page to configure a profile.\n",
  });
}

async function writeFixture(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const destination = join(root, ...path.split("/"));
    await mkdir(join(destination, ".."), { recursive: true });
    await writeFile(destination, content, "utf8");
  }
}

function fraction(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : round(numerator / denominator);
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1);
  return round(sorted[index]!);
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function captureEnvironment(): Record<string, string | undefined> {
  return {
    PROJECT_CONTEXT_HOME: process.env.PROJECT_CONTEXT_HOME,
    PROJECT_CONTEXT_ALLOWED_ROOTS: process.env.PROJECT_CONTEXT_ALLOWED_ROOTS,
    PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS: process.env.PROJECT_CONTEXT_ALLOWED_OUTPUT_ROOTS,
  };
}

function restoreEnvironment(previous: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

async function implementationVersion(): Promise<string> {
  const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
    version?: unknown;
  };
  return typeof packageJson.version === "string" ? packageJson.version : "unknown";
}
