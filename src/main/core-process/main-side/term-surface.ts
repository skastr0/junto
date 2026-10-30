/**
 * Main's side of a view's terminal surface (Plan B): the terminal plane is
 * the core's, so a surface port rides from main to the core beside a
 * `surfaceOpen` message, and the core hands it on to the terminal process.
 * The core says whether it opened on a push, and main closes it by name.
 */
import type { ControlLease } from "../../junto/term/local-host";
import { SURFACE_OPENED } from "../channels";
import type { SurfaceOpenMessage } from "../ops/term-surface";

/** What main posts to the core with a port beside it: a surface, or a push (pty.connect). */
export type PortedCoreMessage = SurfaceOpenMessage | { readonly kind: "push"; readonly channel: string; readonly payload: unknown };

const SURFACE_ANSWER_MS = 10_000;
type SurfaceOpened = { readonly id: number; readonly opened: boolean };

/** What main's terminal IPC asks of the plane for a surface port, wherever the plane is. */
export type SurfacePlane = {
  /** The stop, or undefined (and the port closed) when it did not open. */
  readonly open: (lease: ControlLease, port: { readonly close: () => void }, read?: bigint) => Promise<(() => void) | undefined>;
};

/** Main side: the core process's plane, reached over its port. */
export const coreSurfacePlane = (client: {
  readonly postSurface: (message: PortedCoreMessage, port: unknown) => boolean;
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
