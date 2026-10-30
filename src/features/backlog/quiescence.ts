// Work in flight in the Backlog feature (backlog.md 8): message queues, debounced reads and
// redraws, rescans. Each part registers a check that says whether it is busy; whenQuiet() waits
// until none is, so tests wait for the work itself instead of for a guessed number of
// milliseconds (which fails on a loaded machine).

const checks = new Set<() => boolean>();

/** Registers a busy check; the returned function removes it (on dispose). */
export function trackBusy(check: () => boolean): () => void {
  checks.add(check);
  return () => void checks.delete(check);
}

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const busy = (): boolean => [...checks].some((check) => check());

/**
 * Resolves once no registered part is busy, checked on two event-loop turns in a row (work may
 * start a timer or a promise that the first turn has not seen yet). Gives up after `timeoutMs`.
 */
export async function whenQuiet(timeoutMs = 20_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    await turn();
    if (!busy()) {
      await turn();
      if (!busy()) return;
    }
    if (Date.now() > end) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
