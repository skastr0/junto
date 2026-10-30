/**
 * The terminal process (protect the main thread, phase 1): an Electron
 * utilityProcess that holds every PTY, so a PTY's reads and writes never wait
 * on Electron main's or the core's event loop. It serves the core over its
 * parent port and decides nothing about seats.
 */
import { createRequire } from "node:module";
import type { CoreMessage, CorePort } from "../core-process/port";
import { serveTerminals, type SurfacePort } from "./serve";
import { TerminalSurface, type SurfaceIn, type TerminalSurfaceOpen } from "./protocol";

/** Electron's MessagePortMain, as a utilityProcess is given one. */
type PortMain = {
  readonly postMessage: (message: unknown) => void;
  readonly on: (event: "message", listener: (event: { readonly data: unknown }) => void) => void;
  readonly off: (event: "message", listener: (event: { readonly data: unknown }) => void) => void;
  readonly start: () => void;
  readonly close: () => void;
};

type ParentEvent = { readonly data: unknown; readonly ports?: readonly PortMain[] };

type ParentPort = {
  readonly postMessage: (message: unknown) => void;
  readonly on: (event: "message", listener: (event: ParentEvent) => void) => void;
  readonly off: (event: "message", listener: (event: ParentEvent) => void) => void;
};

const surfacePort = (port: PortMain): SurfacePort => ({
  post: (message) => port.postMessage(message),
  listen: (handler) => {
    const on = (event: { readonly data: unknown }) => handler(event.data as SurfaceIn);
    port.on("message", on);
    port.start();
    return () => port.off("message", on);
  },
  close: () => port.close(),
});

// node-pty stays a runtime load beside the installed file (app-process-plane.ts).
const require = createRequire(typeof __filename === "string" ? __filename : import.meta.url);

const parent = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (parent !== undefined) {
  let openSurface: ((open: TerminalSurfaceOpen, surface: SurfacePort) => void) | undefined;
  const port: CorePort = {
    post: (message) => parent.postMessage(message),
    listen: (handler) => {
      const on = (event: ParentEvent) => {
        const message = event.data as CoreMessage;
        // A surface port rides beside its message; the message alone means nothing.
        if (message.kind === "push" && message.channel === TerminalSurface.open) {
          const surface = event.ports?.[0];
          if (surface !== undefined) openSurface?.(message.payload as TerminalSurfaceOpen, surfacePort(surface));
          return;
        }
        handler(message);
      };
      parent.on("message", on);
      return () => parent.off("message", on);
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePty = require("node-pty") as typeof import("node-pty");
  openSurface = serveTerminals(port, (command, args, options) => nodePty.spawn(command, [...args], options)).openSurface;
}
