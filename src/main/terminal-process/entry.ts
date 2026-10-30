/**
 * The terminal process (protect the main thread, phase 1): an Electron
 * utilityProcess that holds every PTY, so a PTY's reads and writes never wait
 * on Electron main's or the core's event loop. It serves the core over its
 * parent port when the core runs in main, and over a port main hands it
 * (`pty.connect`) when the core runs in its own process. It decides nothing
 * about seats.
 */
import { createRequire } from "node:module";
import type { CoreMessage, CorePort } from "../core-process/port";
import { serveTerminals, type SurfacePort } from "./serve";
import { TERMINAL_CONNECT, TerminalSurface, type SurfaceIn, type TerminalSurfaceOpen } from "./protocol";

/** Electron's MessagePortMain, as a utilityProcess is given one. */
type PortMain = {
  readonly postMessage: (message: unknown) => void;
  readonly on: (event: "message" | "close", listener: (event: PortEvent) => void) => void;
  readonly off: (event: "message", listener: (event: PortEvent) => void) => void;
  readonly start: () => void;
  readonly close: () => void;
};

type PortEvent = { readonly data: unknown; readonly ports?: readonly PortMain[] };

type ParentPort = {
  readonly postMessage: (message: unknown) => void;
  readonly on: (event: "message", listener: (event: PortEvent) => void) => void;
  readonly off: (event: "message", listener: (event: PortEvent) => void) => void;
};

const surfacePort = (port: PortMain): SurfacePort => ({
  post: (message) => port.postMessage(message),
  listen: (handler) => {
    const on = (event: PortEvent) => handler(event.data as SurfaceIn);
    port.on("message", on);
    port.start();
    return () => port.off("message", on);
  },
  close: () => port.close(),
});

// node-pty stays a runtime load beside the installed file (app-process-plane.ts).
const require = createRequire(typeof __filename === "string" ? __filename : import.meta.url);

/** Serve one core on `on`: its messages, and a surface port riding beside its message. */
const serve = (on: ParentPort, connected: (port: PortMain) => void) => {
  let openSurface: ((open: TerminalSurfaceOpen, surface: SurfacePort) => void) | undefined;
  const port: CorePort = {
    post: (message) => on.postMessage(message),
    listen: (handler) => {
      const listener = (event: PortEvent) => {
        const message = event.data as CoreMessage;
        // A port rides beside its message; the message alone means nothing.
        if (message.kind === "push" && message.channel === TerminalSurface.open) {
          const surface = event.ports?.[0];
          if (surface !== undefined) openSurface?.(message.payload as TerminalSurfaceOpen, surfacePort(surface));
          return;
        }
        if (message.kind === "push" && message.channel === TERMINAL_CONNECT) {
          const core = event.ports?.[0];
          if (core !== undefined) connected(core);
          return;
        }
        handler(message);
      };
      on.on("message", listener);
      return () => on.off("message", listener);
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePty = require("node-pty") as typeof import("node-pty");
  const served = serveTerminals(port, (command, args, options) => nodePty.spawn(command, [...args], options));
  openSurface = served.openSurface;
  return served;
};

const parent = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (parent !== undefined) {
  const connect = (core: PortMain): void => {
    const served = serve(core, connect);
    core.on("close", () => {
      served.close();
      served.lost();
    });
    core.start();
  };
  serve(parent, connect);
}
