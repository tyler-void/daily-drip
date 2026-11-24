// Slash commands still being answered. On shutdown (a redeploy), the bot waits for them before
// leaving Discord, so nobody is left with "daily-drip is thinking..." that never finishes.

const running = new Set<Promise<unknown>>();

/** Run `work`, counted as in flight until it settles. Errors are the caller's to handle. */
export function track(work: () => Promise<unknown>): Promise<unknown> {
  const p = work();
  running.add(p);
  const done = () => running.delete(p);
  p.then(done, done);
  return p;
}

export function inFlight(): number {
  return running.size;
}

/** Resolves when nothing is in flight (including work that starts meanwhile), or after `timeoutMs`. */
export async function drain(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (running.size > 0) {
    const left = deadline - Date.now();
    if (left <= 0) return false;
    await Promise.race([Promise.allSettled([...running]), new Promise((r) => setTimeout(r, left))]);
  }
  return true;
}
