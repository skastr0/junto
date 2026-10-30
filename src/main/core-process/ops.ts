import type { Effect } from "effect";

/**
 * The core's operations, by name (Wave 3, protect the main thread). Electron
 * main never runs a core effect itself: it asks the core for an operation by
 * name with a structured-clone input, and gets a structured-clone answer
 * back. Today the core runs in main's own runtime; when every call site goes
 * through `CoreClient`, the core moves into its own utilityProcess and the
 * sites do not change.
 *
 * Each group of operations lives in its own file under `ops/`, one per call
 * site file it replaces, so seats converting different files never edit the
 * same one. A group adds its operations to `CoreOps` by declaration merging:
 *
 *   declare module "../ops" {
 *     interface CoreOps { "work.readTopology": CoreOp<{ canvasName: string }, Topology> }
 *   }
 *
 * and registers their bodies with `coreOps({ ... })` in the same file.
 */

/** An operation: a structured-clone input in, a structured-clone answer out. */
export type CoreOp<I, O> = { readonly input: I; readonly output: O };

// Filled by each group under ./ops by declaration merging.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CoreOps {}

export type CoreOpName = keyof CoreOps & string;
export type CoreInput<K extends CoreOpName> = CoreOps[K] extends CoreOp<infer I, unknown> ? I : never;
export type CoreOutput<K extends CoreOpName> = CoreOps[K] extends CoreOp<unknown, infer O> ? O : never;

/** The body of an operation, run inside the core's runtime. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CoreOpBody<K extends CoreOpName> = (input: CoreInput<K>) => Effect.Effect<CoreOutput<K>, unknown, any>;

export type CoreOpBodies = { readonly [K in CoreOpName]?: CoreOpBody<K> };

const bodies = new Map<string, CoreOpBody<CoreOpName>>();

/** Register a group's operation bodies. A name registered twice is a bug. */
export const coreOps = (group: CoreOpBodies): void => {
  for (const [name, body] of Object.entries(group)) {
    if (body === undefined) continue;
    if (bodies.has(name)) throw new Error(`core operation registered twice: ${name}`);
    bodies.set(name, body as CoreOpBody<CoreOpName>);
  }
};

export const coreOpBody = (name: string): CoreOpBody<CoreOpName> | undefined => bodies.get(name);
