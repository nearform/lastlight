/**
 * Bounded-concurrency map that preserves input order.
 *
 * One implementation, two callers: the eval runner's within-arm case concurrency
 * (`--concurrency N`) and `scripts/aacr-adjudicate.ts`. Order preservation is the
 * load-bearing property — results index-align with `items`, so a caller can zip
 * them back against its own list without threading ids through.
 *
 * `limit <= 1` degenerates to a single worker draining the queue in order, which
 * is exactly a serial `for` loop. That is what makes the default safe: nothing
 * about the surrounding run changes when concurrency is off.
 *
 * Errors are NOT caught here. A caller that must not let one bad item take the
 * batch down returns the failure as a value (both callers do — an eval case
 * records `result.error`, an adjudicated row records an `error` field), which
 * keeps "this item failed" distinguishable from "this item was never attempted".
 */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
