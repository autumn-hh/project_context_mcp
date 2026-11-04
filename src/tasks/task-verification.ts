export interface VerificationResult { command: string; status: string; summary?: string }

/** Shared with the browser: attempts stay ordered, latest exact command wins. */
export function summarizeVerification(items: VerificationResult[]) {
  const latest = new Map<string, number>();
  items.forEach((item, index) => latest.set(item.command.trim(), index));
  const current = items.flatMap((item, index) => latest.get(item.command.trim()) === index ? [{
    ...item, passed: !!item.command.trim() && ['passed', 'pass', 'success', 'succeeded', 'ok'].includes(item.status.trim().toLowerCase()),
  }] : []);
  return { current, superseded: items.filter((item, index) => latest.get(item.command.trim()) !== index),
    unresolved: current.filter(item => !item.passed).length };
}
