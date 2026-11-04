/**
 * Hosted CI runners (GitHub sets CI=true) are several times slower than a development machine,
 * notably Windows with real-time scanning, so explicit per-test timeouts scale with the same
 * factor as the global limits in vitest.config.ts. Local runs keep the strict limits.
 */
export const TIMEOUT_SCALE = process.env.CI ? 4 : 1;

export function timeout(milliseconds: number): number {
  return milliseconds * TIMEOUT_SCALE;
}
