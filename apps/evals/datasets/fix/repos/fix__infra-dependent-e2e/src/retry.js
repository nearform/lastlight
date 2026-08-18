/** Retry `fn` up to `attempts` times with a fixed delay. */
export async function retry(fn, { attempts = 3, delayMs = 0 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw last;
}
