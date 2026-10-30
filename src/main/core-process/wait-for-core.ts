/**
 * A core call that outlives a core that is starting again.
 *
 * Main asks the core before the window exists: the browser composition reads
 * its profile registry, the canvas is opened, settings are read. The host
 * starts the core again on its own when it exits (core-process/host.ts), but a
 * call made in that gap is refused at once, and a caller that treats the
 * refusal as a product failure takes the app down with no window and no
 * message. So a transport refusal is waited out here, for as long as the core
 * coming back is plausible; a refusal the core itself answered is not.
 */
import { CoreCallError } from "./client";

/** How long a starting core is worth waiting for: its own restart backoff tops out at 30 s. */
export const CORE_STARTUP_WAIT_MS = 60_000;
const RETRY_MS = 250;

/** Whether a call failed because no core answered, rather than because the core refused it. */
export const isCoreUnavailable = (error: unknown): boolean =>
  error instanceof CoreCallError && (error.tag === "CoreStopped" || error.tag === "CoreClientMissing");

export type AwaitCoreOptions = {
  readonly deadlineMs?: number;
  readonly retryMs?: number;
  /** Test seam: wait between attempts. */
  readonly wait?: (ms: number) => Promise<void>;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const awaitCore = async <A>(call: () => Promise<A>, options: AwaitCoreOptions = {}): Promise<A> => {
  const deadlineMs = options.deadlineMs ?? CORE_STARTUP_WAIT_MS;
  const retryMs = options.retryMs ?? RETRY_MS;
  const wait = options.wait ?? sleep;
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      return await call();
    } catch (error) {
      if (!isCoreUnavailable(error) || Date.now() >= deadline) throw error;
      await wait(retryMs);
    }
  }
};
