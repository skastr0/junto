/**
 * What the core asks Electron main for, by name (Wave 3): the mirror of
 * `CoreOps`. A core service that needs what only Electron has (a window's
 * pixels, a browser session) calls `host.call(name, input)` with a
 * structured-clone input and gets a structured-clone answer back. Today both
 * run in main and the call is direct; with the core in its own process the
 * call crosses the core port and main answers it.
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

const bodies = new Map<string, HostOpBody<HostOpName>>();

/** Register main's bodies for some host operations; returns their removal. A name registered twice is a bug. */
export const hostOps = (group: HostOpBodies): (() => void) => {
  const names: string[] = [];
  for (const [name, body] of Object.entries(group)) {
    if (body === undefined) continue;
    if (bodies.has(name)) throw new Error(`host operation registered twice: ${name}`);
    bodies.set(name, body as HostOpBody<HostOpName>);
    names.push(name);
  }
  return () => {
    for (const name of names) bodies.delete(name);
  };
};

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

const hostFailureOf = (error: unknown): HostFailure => ({
  tag: typeof error === "object" && error !== null && "_tag" in error ? String((error as { _tag: unknown })._tag) : undefined,
  message: error instanceof Error ? error.message : String(error),
});

/** Run one named host operation in main; the answer or a `HostFailure`. */
export const runHostOp = async (
  name: string,
  input: unknown,
): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly failure: HostFailure }> => {
  const body = bodies.get(name);
  if (body === undefined) return { ok: false, failure: { tag: "UnknownHostOp", message: `no host operation named ${name}` } };
  try {
    return { ok: true, value: await body(input as never) };
  } catch (error) {
    return { ok: false, failure: hostFailureOf(error) };
  }
};

/** The host in the same process: each call runs main's body directly. */
export const inProcessHost: HostClient = {
  call: async (name, input) => {
    const answer = await runHostOp(name, input);
    if (answer.ok) return answer.value as never;
    throw new HostCallError(name, answer.failure.tag, answer.failure.message);
  },
};

let current: HostClient = inProcessHost;

/** The core's one handle on Electron main. */
export const host: HostClient = { call: (name, input) => current.call(name, input) };

/** Core process boot only: route every host call over the core port. */
export const useHostClient = (client: HostClient): void => {
  current = client;
};
