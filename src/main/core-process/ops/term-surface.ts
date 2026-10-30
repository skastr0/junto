import { Effect } from "effect";
import type { ControlLease } from "../../junto/term/local-host";
import { injectionSupervisor } from "../../junto/term/injection-supervisor";
import { termPlane } from "../../junto/term/plane";
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
export const SURFACE_OPENED = "term.surfaceOpened";
const SURFACE_ANSWER_MS = 10_000;
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

/** What main's terminal IPC asks of the plane for a surface port, wherever the plane is. */
export type SurfacePlane = {
  /** The stop, or undefined (and the port closed) when it did not open. */
  readonly open: (lease: ControlLease, port: { readonly close: () => void }, read?: bigint) => Promise<(() => void) | undefined>;
};

/** Main side: the core process's plane, reached over its port. */
export const coreSurfacePlane = (client: {
  readonly postSurface: (message: SurfaceOpenMessage, port: unknown) => boolean;
  readonly onPush: (channel: string, listener: (payload: unknown) => void) => () => void;
  readonly call: (name: "term.surface.close", input: { readonly lease: ControlLease }) => Promise<void>;
}): SurfacePlane => {
  let nextId = 1;
  const waiting = new Map<number, (opened: boolean) => void>();
  client.onPush(SURFACE_OPENED, (payload) => {
    const { id, opened } = payload as SurfaceOpened;
    waiting.get(id)?.(opened);
    waiting.delete(id);
  });
  return {
    open: (lease, port, read) => {
      const id = nextId++;
      // A core that stops before it answers never will: the port is then given up.
      const answered = new Promise<boolean>((resolve) => {
        const late = setTimeout(() => {
          waiting.delete(id);
          resolve(false);
        }, SURFACE_ANSWER_MS);
        late.unref?.();
        waiting.set(id, (opened) => {
          clearTimeout(late);
          resolve(opened);
        });
      });
      if (!client.postSurface({ kind: "surfaceOpen", id, lease, ...(read === undefined ? {} : { read }) }, port)) {
        waiting.delete(id);
        port.close();
        return Promise.resolve(undefined);
      }
      return answered.then((opened) =>
        opened ? () => void client.call("term.surface.close", { lease }).catch(() => undefined) : undefined);
    },
  };
};

let current: SurfacePlane | undefined;
/** Boot only: surface ports go to the core process. */
export const useCoreSurfacePlane = (plane: SurfacePlane | undefined): void => {
  current = plane;
};
export const coreSurfacePlaneInUse = (): SurfacePlane | undefined => current;
