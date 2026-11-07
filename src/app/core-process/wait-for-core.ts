/**
 * Whether a failure means no core answered, rather than that the core refused.
 *
 * Main asks the core before the window exists: the browser composition reads
 * its profile registry, the canvas is opened, settings are read. A request
 * made while the core is starting again waits on the link for the next core
 * (core-process/host.ts); one in flight when a core exits fails with the RPC
 * client's error. The startup dialog names the core as what did not answer
 * only for those, never for a refusal the core itself answered.
 */
import { RpcClientError } from "effect/rpc";
import { CoreCallError } from "../../contract/core/client";

/** How long a starting core is worth waiting for: its own restart backoff tops out at 30 s. */
export const CORE_STARTUP_WAIT_MS = 60_000;

/** Whether a call failed because no core answered, rather than because the core refused it. */
export const isCoreUnavailable = (error: unknown): boolean => {
  // A caller that wraps the refusal (the browser composition wraps its profile
  // registry failure) still names the core as what did not answer: walk the
  // cause chain to the failure that was actually observed.
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof RpcClientError.RpcClientError) return true;
    if (current instanceof CoreCallError) return current.tag === "CoreStopped" || current.tag === "CoreClientMissing";
    if (typeof current !== "object" || current === null) return false;
    const cause = (current as { readonly cause?: unknown }).cause;
    if (cause === undefined || cause === current) return false;
    current = cause;
  }
  return false;
};
