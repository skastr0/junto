import { Schema } from "effect";
import { injectionSupervisor } from "../term/injection-supervisor";
import { termPlane } from "../term/plane";
import { SURFACE_OPENED } from "../../contract/core/channels";
import { ControlLease } from "../../contract/core/term-ipc";

/**
 * Plan B: the terminal plane is the core's, so a view's surface port rides
 * from main to the core beside a `surfaceOpen` message, and the core's plane
 * hands it on to the terminal process. Output reaches the renderer on the
 * port, never through main. The core says whether it opened on a push, and
 * main closes it with `TermSurfaceClose` (src/contract/core/term-ipc.ts).
 *
 * The message rides beside a transferred port, so it is not an RPC; it is
 * decoded closed here, at the core's edge, and one of another shape opens
 * nothing.
 */
export const SurfaceOpenMessage = Schema.Struct({
  kind: Schema.Literal("surfaceOpen"),
  id: Schema.Number,
  lease: ControlLease,
  /** The journal entry the view's screen already holds; the port starts after it. */
  read: Schema.optionalKey(Schema.BigInt),
});
export type SurfaceOpenMessage = typeof SurfaceOpenMessage.Type;

type SurfaceOpened = { readonly id: number; readonly opened: boolean };

const decodeOpen = Schema.decodeUnknownOption(SurfaceOpenMessage, { onExcessProperty: "error" });

/** Core side: open the port on this core's plane, and say whether it opened. */
export const openCoreSurface = (
  message: unknown,
  port: { readonly close: () => void },
  push: (channel: string, payload: unknown) => void,
): void => {
  const decoded = decodeOpen(message);
  if (decoded._tag === "None") {
    port.close();
    const id = (message as { readonly id?: unknown } | undefined)?.id;
    if (typeof id === "number") push(SURFACE_OPENED, { id, opened: false } satisfies SurfaceOpened);
    return;
  }
  const open = decoded.value;
  const opened = termPlane.host.openSurface(open.lease, port, {
    ...(open.read === undefined ? {} : { read: open.read }),
    // Input-origin tagging, as for an IPC write that landed.
    onInput: (data) => injectionSupervisor.noteUserInput(open.lease.bindingId, undefined, data),
  });
  push(SURFACE_OPENED, { id: open.id, opened: opened !== undefined } satisfies SurfaceOpened);
};
