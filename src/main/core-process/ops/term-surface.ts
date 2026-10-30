import { Effect } from "effect";
import type { ControlLease } from "../../junto/term/local-host";
import { injectionSupervisor } from "../../junto/term/injection-supervisor";
import { termPlane } from "../../junto/term/plane";
import { SURFACE_OPENED } from "../channels";
import { coreOps, type CoreOp } from "../ops";

/**
 * Plan B: the terminal plane is the core's, so a view's surface port rides
 * from main to the core beside a `surfaceOpen` message, and the core's plane
 * hands it on to the terminal process. Output reaches the renderer on the
 * port, never through main. The core says whether it opened on a push, and
 * main closes it by name.
 */

/** Main to core, with the port transferred beside it. */
export type SurfaceOpenMessage = {
  readonly kind: "surfaceOpen";
  readonly id: number;
  readonly lease: ControlLease;
  readonly read?: bigint;
};
type SurfaceOpened = { readonly id: number; readonly opened: boolean };

declare module "../ops" {
  interface CoreOps {
    "term.surface.close": CoreOp<{ readonly lease: ControlLease }, void>;
  }
}

const stops = new Map<string, () => void>();

/** Core side: open the port on this core's plane, and say whether it opened. */
export const openCoreSurface = (
  message: SurfaceOpenMessage,
  port: { readonly close: () => void },
  push: (channel: string, payload: unknown) => void,
): void => {
  stops.get(message.lease.leaseId)?.();
  stops.delete(message.lease.leaseId);
  const stop = termPlane.host.openSurface(message.lease, port, {
    ...(message.read === undefined ? {} : { read: message.read }),
    // Input-origin tagging, as for an IPC write that landed.
    onInput: (data) => injectionSupervisor.noteUserInput(message.lease.bindingId, undefined, data),
  });
  if (stop !== undefined) stops.set(message.lease.leaseId, stop);
  push(SURFACE_OPENED, { id: message.id, opened: stop !== undefined } satisfies SurfaceOpened);
};

coreOps({
  "term.surface.close": ({ lease }) =>
    Effect.sync(() => {
      stops.get(lease.leaseId)?.();
      stops.delete(lease.leaseId);
      termPlane.host.closeSurface(lease);
    }),
});
