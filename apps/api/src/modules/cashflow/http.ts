export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * fetch + JSON with a timeout and exponential backoff on 429/5xx. Provider
 * API keys live in URLs, so error messages never include the URL itself.
 */
export async function fetchJsonWithRetry<T = unknown>(
  url: string,
  init: RequestInit,
  label: string,
  { retries = 5, timeoutMs = 30_000 }: { retries?: number; timeoutMs?: number } = {},
): Promise<T> {
  let lastError = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(1000 * 2 ** attempt, 30_000));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (res.status === 429 || res.status >= 500) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 300);
        throw new NonRetryableError(`${label} failed (HTTP ${res.status}): ${body}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof NonRetryableError) throw err;
      lastError = (err as Error).name === 'AbortError' ? `timeout after ${timeoutMs}ms` : (err as Error).message;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${label} failed after ${retries + 1} attempts: ${lastError}`);
}

export class NonRetryableError extends Error {}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
