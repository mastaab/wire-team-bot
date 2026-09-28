import type { QualifiedId } from "../../domain/ids/QualifiedId";
import type { Logger } from "../ports/Logger";
import type { WireOutboundPort } from "../ports/WireOutboundPort";

/** How often a shown typing indicator is sent again; Wire clients expire it after about 10 seconds. */
export const TYPING_REFRESH_MS = 8_000;

/**
 * Runs `work` while the conversation shows the app as typing: started at once, refreshed every
 * `TYPING_REFRESH_MS`, and cleared when the work ends, however it ends. Typing calls are never
 * awaited before the work starts and their failures are logged by error name only, so the
 * indicator can never delay, block or break the answer.
 */
export async function withTyping<T>(
  outbound: WireOutboundPort,
  conversationId: QualifiedId,
  work: () => Promise<T>,
  logger?: Logger,
  refreshMs: number = TYPING_REFRESH_MS,
): Promise<T> {
  let failed = false;
  // Wrapped in a promise so even a synchronous throw from the transport is caught here.
  const send = (typing: boolean): Promise<void> =>
    Promise.resolve().then(() => outbound.setTyping(conversationId, typing)).catch((err: unknown) => {
      // One warning per piece of work, so a backend refusing typing does not flood the log.
      if (!failed) logger?.warn("Typing indicator failed", { err: err instanceof Error ? err.name : "UnknownError" });
      failed = true;
    });
  const started = send(true);
  const refresh = setInterval(() => void send(true), refreshMs);
  refresh.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(refresh);
    // Stopped after the start has gone out, so a slow "started" never arrives after "stopped".
    void started.then(() => send(false));
  }
}
