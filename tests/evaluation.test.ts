import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS, passesThresholds, runEvaluation } from "../src/evaluation/evaluator.js";

describe("quality evaluation", () => {
  it("evaluates deterministic retrieval, context, candidate, and performance scenarios", async () => {
    const report = await runEvaluation(5);
    expect(report.schemaVersion).toBe(1);
    expect(report.quality.search.cases).toBeGreaterThanOrEqual(9);
    expect(report.quality.search.recallAt5).toBe(1);
    expect(report.quality.search.mrr).toBeGreaterThanOrEqual(0.8);
    expect(report.quality.context.requiredRecall).toBe(1);
    expect(report.quality.context.budgetRespected).toBe(true);
    expect(report.quality.candidates.expected).toBe(2);
    expect(report.quality.candidates.recall).toBe(1);
    expect(report.performance.files).toBeGreaterThanOrEqual(40);
    expect(report.performance.queryLatencyMs.p95).toBeGreaterThanOrEqual(0);
    expect(report.passed).toBe(true);
  });

  it("enforces all quality thresholds", () => {
    const quality = {
      search: { cases: 1, recallAt1: 1, recallAt5: 1, mrr: 1, results: [] },
      context: { requiredRecall: 1, selectedMemoryPrecision: 1, budgetRespected: true },
      candidates: { expected: 1, generated: 1, precision: 1, recall: 1, typeAccuracy: 1 },
    };
    expect(passesThresholds(quality, DEFAULT_THRESHOLDS)).toBe(true);
    expect(passesThresholds(
      { ...quality, search: { ...quality.search, recallAt5: 0 } },
      DEFAULT_THRESHOLDS,
    )).toBe(false);
  });
});
