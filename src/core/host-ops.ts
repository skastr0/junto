/**
 * The host operations' protocol (Wave 3): what the core may ask Electron main
 * for, by name, the mirror of `CoreOps`. Types and the failure class only;
 * this module holds no state and runs nothing. Main's end, the bodies, is
 * `main-side/host-op-bodies.ts`; the core's end, the client, is
 * `core-host.ts`.
 *
 * A host operation is declared by merging into `HostOps`:
 *
 *   declare module "../host-ops" {
 *     interface HostOps { "window.capturePage": HostOp<Record<string, never>, Uint8Array | undefined> }
 *   }
 *
 * and main registers its body with `hostOps({ ... })` once it has what the
 * body needs. A body is a plain async function: main runs no core effect.
 */

/** A host operation: a structured-clone input in, a structured-clone answer out. */
export type HostOp<I, O> = { readonly input: I; readonly output: O };

// Filled by each declaring module by declaration merging.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface HostOps {}

export type HostOpName = keyof HostOps & string;
export type HostInput<K extends HostOpName> = HostOps[K] extends HostOp<infer I, unknown> ? I : never;
export type HostOutput<K extends HostOpName> = HostOps[K] extends HostOp<unknown, infer O> ? O : never;

export type HostOpBody<K extends HostOpName> = (input: HostInput<K>) => Promise<HostOutput<K>>;
export type HostOpBodies = { readonly [K in HostOpName]?: HostOpBody<K> };

/** A failed host operation, as the core sees it: the operation, the failure's tag if it had one, and its message. */
export class HostCallError extends Error {
  constructor(
    readonly operation: string,
    readonly tag: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "HostCallError";
  }
}

export type HostClient = {
  readonly call: <K extends HostOpName>(name: K, input: HostInput<K>) => Promise<HostOutput<K>>;
};

/** A failure as it crosses a port: its tag and message, nothing else. */
export type HostFailure = { readonly tag: string | undefined; readonly message: string };

/** One host operation's outcome, as main's end answers it. */
export type HostAnswer =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly failure: HostFailure };

/** What answers the host calls arriving on a port. */
export type AnswerHost = (name: string, input: unknown) => Promise<HostAnswer>;
