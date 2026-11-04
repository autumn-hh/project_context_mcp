const STOP_WORDS = new Set([
  "the", "and", "for", "with", "this", "that", "task", "project", "change", "fix",
  "任务", "项目", "修改", "修复", "实现", "检查", "需要", "进行", "相关", "工作", "一下",
]);

export function taskTokens(value: string): string[] {
  const normalized = value.normalize("NFKC").toLowerCase();
  const result = new Set<string>();
  // Technical identifiers adjacent to Han text remain independent terms.
  const separated = normalized.replace(/(\p{Script=Han})([\p{Script=Latin}\p{N}_-])/gu, '$1 $2')
    .replace(/([\p{Script=Latin}\p{N}_-])(\p{Script=Han})/gu, '$1 $2');
  for (const word of separated.match(/[\p{L}\p{N}_-]+/gu) ?? []) {
    if (word.length >= 2 && !STOP_WORDS.has(word)) result.add(word);
  }
  // Han text commonly has no spaces; meaningful bigrams also match substrings.
  for (const run of normalized.match(/\p{Script=Han}+/gu) ?? []) {
    const chars = [...run];
    for (let index = 0; index < chars.length - 1; index += 1) {
      const term = chars.slice(index, index + 2).join("");
      if (!STOP_WORDS.has(term)) result.add(term);
    }
  }
  return [...result];
}

export function taskOverlap(terms: string[], text: string): number {
  const textTerms = new Set(taskTokens(text));
  return terms.filter((term) => textTerms.has(term)).length;
}
