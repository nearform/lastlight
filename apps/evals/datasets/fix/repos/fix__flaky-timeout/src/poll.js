/** Resolve once `check()` returns true, polling every `intervalMs`. */
export async function pollUntil(check, { intervalMs = 10, timeoutMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > deadline) throw new Error("pollUntil: timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
