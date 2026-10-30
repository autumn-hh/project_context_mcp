import type { SqliteDatabase } from "../storage/database.js";
import { getMemory, type MemoryRecord } from "./memory-service.js";
import { ProjectContextError } from "../shared/errors.js";

export interface ContentMemoryRelation {
  sourceMemoryId: string;
  targetMemoryId: string;
  sharedTerms: string[];
  excerpts: { source: string; target: string };
  /** Local lexical ordering score, never a truth/confidence estimate. */
  score: number;
}

interface TextPart { text: string; start: number; end: number; compound?: boolean }
interface EvidenceTerm { term: string; source: TextPart; target: TextPart; compound: boolean }
interface ContentText { original: string; latin: TextPart[]; han: TextPart[]; truncated: boolean }

const MAX_TEXT = 8_000;
const MAX_TERMS = 64;
const CHANNEL_LIMIT = 128;
const MAX_SEGMENTS = 160;
const GENERIC = new Set([
  "a", "an", "the", "and", "or", "but", "to", "of", "in", "on", "at", "for", "from", "with",
  "is", "are", "be", "was", "were", "has", "have", "had", "do", "does", "did", "will", "can",
  "could", "should", "must", "may", "not", "no", "yes", "this", "that", "these", "those",
  "it", "its", "we", "our", "you", "your", "they", "their", "as", "by", "than", "then",
  "please", "what", "why", "how", "when", "where", "need", "needs", "use", "using", "used",
  "project", "projects", "task", "tasks", "memory", "memories", "mcp", "api", "apis",
  "code", "implementation", "implement", "implemented", "complete", "completed", "done",
  "test", "tests", "testing", "passed", "check", "checks", "review", "update", "updated",
  "change", "changed", "fix", "fixed", "build", "version", "file", "files", "docs", "document",
  "verify", "verified", "verification", "successful", "success", "full", "regression", "unit", "integration",
  "require", "requires", "required", "rule", "rules", "choice", "notes", "note",
  "candidate", "candidates", "decision", "decisions", "constraint", "constraints", "issue", "issues",
  "fact", "facts", "preference", "preferences", "assumption", "assumptions", "lesson", "lessons",
  "context", "cli", "summary", "summaries", "status", "active", "stale", "conflicted", "superseded",
  "web", "ui", "frontend", "backend", "browser", "interface",
  "reviewed", "generated", "inference", "tool", "tools", "source", "sources", "kind", "scope",
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "thirty",
  "hundred", "thousand", "million", "day", "days", "week", "weeks", "month", "months", "year", "years",
  "hour", "hours", "minute", "minutes", "second", "seconds", "percent", "bytes",
  "local", "server", "client", "service", "support", "supports", "return", "result",
  "项目", "任务", "记忆", "规则", "代码", "实现", "完成", "测试", "通过", "检查", "修改",
  "修复", "更新", "构建", "版本", "文件", "文档", "本地", "服务", "团队", "共享", "使用",
  "支持", "操作", "功能", "模块", "结果", "内容", "关联", "相关", "当前", "之前", "之后",
  "我们", "你们", "这个", "那个", "这些", "那些", "一个", "一下", "已经", "可以", "需要",
  "什么", "怎么", "如何", "是否", "为什么", "应该", "进行", "保持", "所有", "全部",
  "验证", "验收", "成功", "全量", "单元", "集成", "回归", "记忆模块", "项目代码", "测试通过", "开发工作",
  "项目记忆", "候选记忆", "任务摘要", "自动", "仍可能", "经过", "选择", "候选", "数据", "上下文",
  "持久", "长期", "记录", "状态", "活跃", "过期", "来源", "范围", "使用者", "开发者", "建议",
  "客户端", "服务端", "浏览器", "前端", "后端", "界面",
  "可能", "主要", "已有", "仍然", "至少", "最多", "因此", "其中", "目前", "同时", "另外",
]);
const HAN_SEPARATORS = /(?:为什么|是什么|请帮我|请问|关于|之前|之后|我们|你们|这个|那个|这些|那些|一个|一下|已经|可以|需要|应该|必须|不能|不应|不得|禁止|允许|支持|使用|采用|通过|进行|完成|实现|检查|修改|修复|更新|保持|提供|按照|根据|用于|以及|并且|而且|但是|或者|是否|怎么|如何|什么|多久|统一|只会|不会|不再|不要|应当|应为|应当|改为|改成|调整为|的|了|和|与|及|或|在|从|对|将|把|由|为|是|需|要|应|也|都|并|不)/gu;

/**
 * Conservative, bounded lexical evidence. Identical metadata, a shared document,
 * or several overlapping n-grams do not by themselves establish content relation.
 */
export function findContentRelations(
  db: SqliteDatabase,
  seedIds: string[],
  options: {
    limit?: number | undefined;
    perSeed?: number | undefined;
    includeInactive?: boolean | undefined;
    accepts?: ((memory: MemoryRecord) => boolean) | undefined;
  } = {},
): { relations: ContentMemoryRelation[]; truncated: boolean } {
  const limit = bounded(options.limit, 12, 1, 24);
  const perSeed = bounded(options.perSeed, 2, 1, 3);
  if (options.includeInactive !== undefined && typeof options.includeInactive !== "boolean") invalid("includeInactive must be boolean.");
  if (options.accepts !== undefined && typeof options.accepts !== "function") invalid("accepts must be a function.");
  if (!Array.isArray(seedIds) || seedIds.some((id) => typeof id !== "string" || !id || id.length > 200)) {
    invalid("Seed IDs must be nonempty memory IDs of at most 200 characters.");
  }
  const seeds = [...new Set(seedIds)];
  let truncated = seeds.length > 12;
  const status = options.includeInactive ? "m.status IN ('active','stale','conflicted','superseded')" : "m.status='active'";
  const visible = (id: string): boolean => Boolean(db.prepare(
    `SELECT id FROM memories m WHERE id=? AND ${status} AND m.type<>'task-summary'`,
  ).get(id));
  const parsed = new Map<string, ContentText>();
  const textFor = (memory: MemoryRecord): ContentText => {
    let value = parsed.get(memory.id);
    if (!value) {
      value = parseText(`${memory.title}\n${memory.content}`);
      parsed.set(memory.id, value);
      truncated ||= value.truncated;
    }
    return value;
  };
  const all = new Map<string, ContentMemoryRelation>();
  const seedSelections = new Map<string, ContentMemoryRelation[]>();
  for (const seedId of seeds.slice(0, 12)) {
    if (!visible(seedId)) continue;
    const seed = getMemory(db, seedId);
    const source = textFor(seed);
    const candidates = candidateIds(db, source, status);
    truncated ||= candidates.truncated;
    const matches: ContentMemoryRelation[] = [];
    for (const candidateId of candidates.ids) {
      if (candidateId === seedId) continue;
      const target = getMemory(db, candidateId);
      if (options.accepts && !options.accepts(target)) continue;
      const evidence = commonEvidence(source, textFor(target));
      if (evidence.length < 2) continue;
      const terms = evidence.slice(0, 6);
      // A single exact quotation per side must visibly contain two independent
      // clues; retain the entire surrounding sentence when it fits, including "not".
      const excerpts = pairedExcerpts(source.original, textFor(target).original, terms);
      if (!excerpts) continue;
      const relation: ContentMemoryRelation = {
        sourceMemoryId: seedId, targetMemoryId: candidateId,
        sharedTerms: excerpts.terms.map((entry) => entry.term),
        excerpts: { source: excerpts.source, target: excerpts.target },
        score: Math.round(excerpts.terms.reduce((sum, entry) => sum + Math.min(entry.term.length, 12), 0) * 100
          + excerpts.terms.length * 10),
      };
      matches.push(relation);
    }
    matches.sort(compare);
    seedSelections.set(seedId, matches);
  }
  const counts = new Map<string, number>();
  const sorted = [...seedSelections.values()].flat().sort(compare);
  for (const relation of sorted) {
    const key = [relation.sourceMemoryId, relation.targetMemoryId].sort().join("\n");
    if (all.has(key)) continue;
    if ((counts.get(relation.sourceMemoryId) ?? 0) >= perSeed || all.size >= limit) {
      truncated = true;
      continue;
    }
    all.set(key, relation);
    counts.set(relation.sourceMemoryId, (counts.get(relation.sourceMemoryId) ?? 0) + 1);
  }
  return { relations: [...all.values()], truncated };
}

/** A graph neighbor must share real content with the task, never just its scope/path. */
export function contentMatchesTask(memory: MemoryRecord, task: string): boolean {
  const evidence = commonEvidence(parseText(`${memory.title}\n${memory.content}`), parseText(task));
  if (evidence.length >= 2) return true;
  return evidence.some((entry) => entry.compound || /^\p{Script=Han}{4,}$/u.test(entry.term));
}

function candidateIds(db: SqliteDatabase, seed: ContentText, status: string): { ids: string[]; truncated: boolean } {
  const exactTerms = [...new Set([...seed.latin, ...seed.han].map((part) => part.text))]
    .filter((term) => term.length > 1 && !GENERIC.has(term));
  const hanTerms = [...new Set(seed.han.flatMap((part) => {
    const result: string[] = [];
    for (let i = 0; i + 2 <= part.text.length; i += 1) {
      const term = part.text.slice(i, i + 2);
      if (!GENERIC.has(term)) result.push(term);
    }
    return result;
  }))];
  let truncated = exactTerms.length > MAX_TERMS || hanTerms.length > MAX_TERMS;
  const ids = new Set<string>();
  if (exactTerms.length) {
    const rows = db.prepare(`SELECT m.id FROM memories_fts f JOIN memories m ON m.id=f.memory_id
      WHERE memories_fts MATCH ? AND ${status} AND m.type<>'task-summary'
      ORDER BY bm25(memories_fts,0,2,1,0),m.id LIMIT ?`).all(
        `{title content}: (${exactTerms.slice(0, MAX_TERMS).map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ")})`,
        CHANNEL_LIMIT + 1,
      ) as Array<{ id: string }>;
    truncated ||= rows.length > CHANNEL_LIMIT;
    rows.slice(0, CHANNEL_LIMIT).forEach(({ id }) => ids.add(id));
  }
  if (hanTerms.length) {
    const terms = hanTerms.slice(0, MAX_TERMS);
    const rows = db.prepare(`SELECT m.id FROM search_ngrams n JOIN memories m ON m.id=n.item_id
      WHERE n.item_kind='memory' AND n.term IN (${terms.map(() => "?").join(",")})
        AND ${status} AND m.type<>'task-summary'
        AND instr(lower(m.title || char(10) || m.content), n.term)>0
      GROUP BY m.id ORDER BY COUNT(*) DESC,m.id LIMIT ?`).all(...terms, CHANNEL_LIMIT + 1) as Array<{ id: string }>;
    truncated ||= rows.length > CHANNEL_LIMIT;
    rows.slice(0, CHANNEL_LIMIT).forEach(({ id }) => ids.add(id));
  }
  return { ids: [...ids], truncated };
}

function parseText(value: string): ContentText {
  let original = value.slice(0, MAX_TEXT);
  if (value.length > MAX_TEXT) {
    // Do not expose a cut-off final clause as a complete evidence quotation.
    const boundary = Math.max(...["\n", "。", "!", "?"].map((mark) => original.lastIndexOf(mark)));
    original = boundary >= 0 ? original.slice(0, boundary + 1) : "";
  }
  // Mask metadata-like identifiers and filesystem/URL paths at their original
  // length so evidence still points into the unmodified original text.
  const safe = original.replace(
    /(?:^|\n)\s*Review\s+(?:fact|decision|constraint|preference|lesson|issue|assumption|task-summary)(?:\s+candidate)?\s+from\s+(?:task:\s*)?/giu,
    (match) => " ".repeat(match.length),
  ).replace(
    /(?:https?:\/\/\S+|[\p{L}\p{N}_@~-]+\.(?:[cm]?[jt]sx?|py|go|rs|md|json|ya?ml|sql|toml|txt|html|css)\b|(?:[A-Za-z]:)?(?:[./\\][\p{L}\p{N}_.@~+-]+)+|[\p{L}\p{N}_.@~+-]+[\\/][\p{L}\p{N}_./\\@~+-]+|\b(?:mem|task|prj|cand)_[a-z0-9]+\b)/gu,
    (match) => " ".repeat(match.length),
  );
  const latin: TextPart[] = [];
  for (const match of safe.matchAll(/[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)*/gu)) {
    const raw = match[0];
    const start = match.index;
    const components = [...raw.matchAll(/[A-Z]+(?=[A-Z][a-z]|\d|[_-]|$)|[A-Z]?[a-z]+|[A-Z]+/gu)]
      .filter((part) => part[0].length > 1 && !GENERIC.has(part[0].toLowerCase()));
    const named = /[_-]|[a-z][A-Z]/u.test(raw);
    if (raw.length >= 3 && raw.length <= 96 && !GENERIC.has(raw.toLowerCase()) && (!named || components.length > 0)) {
      latin.push({ text: raw.toLowerCase(), start, end: start + raw.length, compound: components.length >= 2 });
    }
    if (named) for (const part of components.filter((entry) => entry[0].length >= 3)) latin.push({
      text: part[0].toLowerCase(), start: start + part.index, end: start + part.index + part[0].length,
    });
    if (latin.length >= MAX_SEGMENTS) break;
  }
  const han: TextPart[] = [];
  let hanClipped = false;
  for (const run of safe.matchAll(/\p{Script=Han}+/gu)) {
    const raw = run[0];
    let offset = 0;
    for (const split of raw.matchAll(HAN_SEPARATORS)) {
      hanClipped = addHan(raw.slice(offset, split.index), run.index + offset, han) || hanClipped;
      offset = split.index + split[0].length;
    }
    hanClipped = addHan(raw.slice(offset), run.index + offset, han) || hanClipped;
    if (han.length >= MAX_SEGMENTS) break;
  }
  return {
    original, latin: latin.slice(0, MAX_SEGMENTS), han: han.slice(0, MAX_SEGMENTS),
    truncated: value.length > MAX_TEXT || latin.length >= MAX_SEGMENTS || han.length >= MAX_SEGMENTS || hanClipped,
  };
}

function addHan(raw: string, start: number, parts: TextPart[]): boolean {
  if (raw.length < 3 || GENERIC.has(raw) || /^[零一二三四五六七八九十百千万亿两]+$/u.test(raw)) return false;
  // Segments remain original spans. Long unbroken prose is bounded explicitly.
  parts.push({ text: raw.slice(0, 80), start, end: start + Math.min(raw.length, 80) });
  return raw.length > 80;
}

function commonEvidence(source: ContentText, target: ContentText): EvidenceTerm[] {
  const possible: EvidenceTerm[] = [];
  const byLatin = new Map<string, TextPart[]>();
  for (const part of target.latin) {
    const parts = byLatin.get(part.text) ?? [];
    parts.push(part);
    byLatin.set(part.text, parts);
  }
  for (const part of source.latin) for (const peer of (byLatin.get(part.text) ?? []).slice(0, 4)) {
    possible.push({ term: part.text, source: part, target: peer, compound: Boolean(part.compound || peer.compound) });
  }
  const hanPositions = new Map<string, Array<{ part: TextPart; offset: number }>>();
  for (const part of target.han) for (let offset = 0; offset + 2 <= part.text.length; offset += 1) {
    const key = part.text.slice(offset, offset + 2);
    const positions = hanPositions.get(key) ?? [];
    if (positions.length < 16) positions.push({ part, offset });
    hanPositions.set(key, positions);
  }
  for (const part of source.han) for (let offset = 0; offset + 2 <= part.text.length; offset += 1) {
    for (const peer of hanPositions.get(part.text.slice(offset, offset + 2)) ?? []) {
      if (offset > 0 && peer.offset > 0 && part.text[offset - 1] === peer.part.text[peer.offset - 1]) continue;
      let length = 2;
      while (offset + length < part.text.length && peer.offset + length < peer.part.text.length
        && part.text[offset + length] === peer.part.text[peer.offset + length]) length += 1;
      const term = part.text.slice(offset, offset + length);
      if (term.length < 3 || GENERIC.has(term) || /^[零一二三四五六七八九十百千万亿两]+$/u.test(term)) continue;
      possible.push({
        term, source: { text: term, start: part.start + offset, end: part.start + offset + length },
        target: { text: term, start: peer.part.start + peer.offset, end: peer.part.start + peer.offset + length },
        compound: false,
      });
    }
  }
  possible.sort((a, b) => b.term.length - a.term.length || a.source.start - b.source.start
    || a.target.start - b.target.start || a.term.localeCompare(b.term));
  const selected: EvidenceTerm[] = [];
  for (const item of possible) {
    // One word/phrase contributes once: nested/overlapping n-grams and identifier
    // components cannot count as multiple independent pieces of evidence.
    if (selected.some((old) => old.term.includes(item.term) || item.term.includes(old.term)
      || overlap(old.source, item.source) || overlap(old.target, item.target))) continue;
    selected.push(item);
    if (selected.length >= 8) break;
  }
  return selected;
}

function pairedExcerpts(source: string, target: string, terms: EvidenceTerm[]): {
  source: string; target: string; terms: EvidenceTerm[];
} | null {
  // Choose an evidence pair that can be shown together within exact 240-char
  // quotations on both sides. Do not splice clauses and accidentally omit negation.
  for (let left = 0; left < terms.length; left += 1) for (let right = left + 1; right < terms.length; right += 1) {
    const pair = [terms[left]!, terms[right]!];
    const a = excerpt(source, pair.map((term) => term.source));
    const b = excerpt(target, pair.map((term) => term.target));
    if (a && b) return { source: a, target: b, terms: pair };
  }
  return null;
}

function excerpt(original: string, spans: TextPart[]): string | null {
  // Most memories fit as a whole. Include the body even when both matched terms
  // were in the title, so a following qualification or negation remains visible.
  if (original.length <= 240) return original;
  const first = Math.min(...spans.map((part) => part.start));
  const last = Math.max(...spans.map((part) => part.end));
  const titleEnd = original.indexOf("\n");
  if (titleEnd >= 0 && last <= titleEnd) {
    // Title-only agreement can hide a contrary body. Include the first complete
    // body sentence as well, or decline the edge if that cannot fit faithfully.
    const bodyEnd = /[\n。!?]/u.exec(original.slice(titleEnd + 1));
    const end = bodyEnd ? titleEnd + 1 + bodyEnd.index + 1 : original.length;
    return end <= 240 ? original.slice(0, end) : null;
  }
  const sentenceStart = Math.max(original.lastIndexOf("\n", first - 1), original.lastIndexOf("。", first - 1),
    original.lastIndexOf("!", first - 1), original.lastIndexOf("?", first - 1)) + 1;
  // Always include the sentence prefix: negation may precede the shared phrase.
  if (last - sentenceStart > 240) return null;
  const endMatch = /[\n。!?]/u.exec(original.slice(last));
  const sentenceEnd = endMatch ? last + endMatch.index + 1 : original.length;
  if (sentenceEnd - sentenceStart > 240) return null;
  return original.slice(sentenceStart, sentenceEnd);
}

function overlap(a: TextPart, b: TextPart): boolean { return a.start < b.end && b.start < a.end; }
function compare(a: ContentMemoryRelation, b: ContentMemoryRelation): number {
  return b.score - a.score || a.sourceMemoryId.localeCompare(b.sourceMemoryId)
    || a.targetMemoryId.localeCompare(b.targetMemoryId);
}
function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) invalid(`Expected integer ${minimum}..${maximum}.`);
  return value;
}
function invalid(message: string): never { throw new ProjectContextError("INVALID_CONTENT_RELATIONS", message); }
