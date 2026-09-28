import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface SearchRankingSettings {
  businessChunk: number;
  businessSymbol: number;
  memory: number;
  lowRelevanceChunk: number;
  lowRelevanceSymbol: number;
}

export const DEFAULT_SEARCH_RANKING: SearchRankingSettings = {
  businessChunk: 1,
  businessSymbol: 1.12,
  memory: 0.78,
  lowRelevanceChunk: 0.48,
  lowRelevanceSymbol: 0.62,
};

const SETTINGS_FILE = join(".project-context", "search-ranking.json");

export function normalizeSearchRanking(input: unknown): SearchRankingSettings {
  const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
  return Object.fromEntries(Object.keys(DEFAULT_SEARCH_RANKING).map((key) => {
    const fallback = DEFAULT_SEARCH_RANKING[key as keyof SearchRankingSettings];
    const candidate = Number(value[key]);
    return [key, Number.isFinite(candidate) && candidate >= 0 && candidate <= 2 ? candidate : fallback];
  })) as unknown as SearchRankingSettings;
}

export function searchRankingPath(projectRoot: string): string {
  return join(projectRoot, SETTINGS_FILE);
}

export function readSearchRankingSync(projectRoot: string): SearchRankingSettings {
  try {
    return normalizeSearchRanking(JSON.parse(readFileSync(searchRankingPath(projectRoot), "utf8")));
  } catch {
    return { ...DEFAULT_SEARCH_RANKING };
  }
}

export async function readSearchRanking(projectRoot: string): Promise<SearchRankingSettings> {
  try {
    return normalizeSearchRanking(JSON.parse(await readFile(searchRankingPath(projectRoot), "utf8")));
  } catch {
    return { ...DEFAULT_SEARCH_RANKING };
  }
}

export async function writeSearchRanking(projectRoot: string, input: unknown): Promise<SearchRankingSettings> {
  const settings = normalizeSearchRanking(input);
  const path = searchRankingPath(projectRoot);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try { await rename(temporaryPath, path); }
  catch (error) { await rm(temporaryPath, { force: true }); throw error; }
  return settings;
}
