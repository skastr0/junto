import { Cause, Effect, Exit } from "effect";
import { coreOpBody, type CoreInput, type CoreOpName, type CoreOutput } from "./ops";

/**
 * How Electron main asks the core for anything (Wave 3). `inProcessCore` runs
 * the operation in main's own runtime, as every call site did before;
 * `portCore` sends it to the core process over a port. A site written against
 * `CoreClient` works the same on either.
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

/** Something that runs a core effect: main's runtime today, the core's own runtime in its process. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CoreRunner = { readonly runPromiseExit: (effect: Effect.Effect<any, any, any>) => Promise<Exit.Exit<any, any>> };

/** Run one named operation on a runner; the answer or a `CoreFailure`. */
export const runCoreOp = async (
  runner: CoreRunner,
  name: string,
  input: unknown,
): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly failure: CoreFailure }> => {
  const body = coreOpBody(name);
  if (body === undefined) return { ok: false, failure: { tag: "UnknownCoreOp", message: `no core operation named ${name}` } };
  const exit = await runner.runPromiseExit(Effect.suspend(() => body(input as never)));
  return Exit.isSuccess(exit) ? { ok: true, value: exit.value } : { ok: false, failure: coreFailureOf(exit.cause) };
};

export const inProcessCore = (runner: CoreRunner): CoreClient => ({
  call: async (name, input) => {
    const answer = await runCoreOp(runner, name, input);
    if (answer.ok) return answer.value as never;
    throw new CoreCallError(name, answer.failure.tag, answer.failure.message);
  },
});
