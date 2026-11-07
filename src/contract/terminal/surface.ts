/**
 * A surface port: one MessagePort per renderer control lease, joining the
 * renderer to one PTY in the terminal process with nothing between them.
 * Keys go in and output comes out on it; the core still holds every gate.
 *
 * Both directions are hot, typed and never decoded, and keyed on `t`. No
 * correctness rests on arrival order: output carries the PTY's `seq` (the
 * same count as the core's `data`), so a view applies it by number and drops
 * a chunk it already has; each key carries the view's own `key` number, and
 * `took` names the key it answers.
 */
import { Schema } from "effect";

/** Chunk `seq` of the PTY's output. */
export const SurfaceOutput = Schema.Struct({ t: Schema.Literal("out"), seq: Schema.Number, data: Schema.String });
/** The chunks from the asked `fromSeq` are gone from the ring: read the screen again. The port closes. */
export const SurfaceGap = Schema.Struct({ t: Schema.Literal("gap") });
/**
 * Key `key` arrived here. A key the view posted that never got this was lost
 * with the port (it closed under it), and the view sends it again over IPC.
 */
export const SurfaceTook = Schema.Struct({ t: Schema.Literal("took"), key: Schema.Number });
/** The lease ended or the PTY exited. The port closes. */
export const SurfaceEnd = Schema.Struct({ t: Schema.Literal("end") });

/** The terminal process to the renderer. */
export const SurfaceOut = Schema.Union([SurfaceOutput, SurfaceGap, SurfaceTook, SurfaceEnd]);
export type SurfaceOut = typeof SurfaceOut.Type;

/** The renderer to the terminal process: key `key`, the view's own count. */
export const SurfaceIn = Schema.Struct({ t: Schema.Literal("in"), key: Schema.Number, data: Schema.String });
export type SurfaceIn = typeof SurfaceIn.Type;

/** A handler for every `t` the renderer can be told, required. */
export type SurfaceOutHandlers = { readonly [M in SurfaceOut as M["t"]]: (message: M) => void };
/** A handler for every `t` the terminal process can be told, required. */
export type SurfaceInHandlers = { readonly [M in SurfaceIn as M["t"]]: (message: M) => void };
