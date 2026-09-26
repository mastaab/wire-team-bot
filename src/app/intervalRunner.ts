import type { Logger } from "../application/ports/Logger";

export interface IntervalRunner {
  stop(): void;
}

/**
 * Runs `task` every `intervalMs`, one run at a time: a tick while a run is still going is
 * skipped. A failed run is logged by error name and the next tick tries again.
 */
export function startIntervalRunner(
  name: string,
  task: () => Promise<unknown>,
  intervalMs: number,
  logger: Logger,
): IntervalRunner {
  let running = false;
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      await task();
    } catch (err) {
      logger.warn(`${name}: run failed`, { err: err instanceof Error ? err.name : "UnknownError" });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
