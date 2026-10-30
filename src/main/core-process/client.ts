import { Cause } from "effect";
import type { CoreInput, CoreOpName, CoreOutput } from "./ops";

/**
 * How a core operation is asked for, on either side of the port: by name,
 * with a structured-clone input, answering a structured-clone result. Main
 * holds a `CoreClient` (`main-client.ts`); the core runs the bodies.
 *
 * A failed operation rejects with a `CoreCallError` carrying the failure's
 * `_tag` when it had one, so a site can tell the failures it handles apart
 * without the error object crossing the process boundary.
 */

export class CoreCallError extends Error {
  constructor(
    readonly operation: string,
    readonly tag: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "CoreCallError";
  }
}

export type CoreClient = {
  readonly call: <K extends CoreOpName>(name: K, input: CoreInput<K>) => Promise<CoreOutput<K>>;
};

/** A failure as it crosses a port: its tag and message, nothing else. */
export type CoreFailure = { readonly tag: string | undefined; readonly message: string };

export const coreFailureOf = (cause: Cause.Cause<unknown>): CoreFailure => {
  const error = Cause.squash(cause);
  const tag = typeof error === "object" && error !== null && "_tag" in error ? String((error as { _tag: unknown })._tag) : undefined;
  const message = error instanceof Error ? error.message : typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : String(error);
  return { tag, message };
};
