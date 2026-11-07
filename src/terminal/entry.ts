/**
 * The terminal process (protect the main thread, phase 1): an Electron
 * utilityProcess that holds every PTY, so a PTY's reads and writes never wait
 * on Electron main's or the core's event loop. It serves the core over a port
 * main hands it (`pty.connect`), or over its parent port when the core runs
 * in main; it outlives a core that crashes, and decides nothing about seats.
 */
import { createRequire } from "node:module";
import type { CoreMessage, CorePort } from "../contract/core/port";
import { serveTerminals, type SurfacePort } from "./serve";
import { TERMINAL_CONNECT, TerminalInbound, TerminalSurface, type SurfaceIn, type TerminalSurfaceOpen } from "../contract/terminal/protocol";

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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodePty = require("node-pty") as typeof import("node-pty");
const served = serveTerminals(undefined, (command, args, options) => nodePty.spawn(command, [...args], options));

/** One core's port: its messages, and a surface port riding beside its message. */
const corePort = (on: ParentPort): CorePort => ({
  post: (message) => on.postMessage(message),
  listen: (handler) => {
    const listener = (event: PortEvent) => {
      const message = event.data as CoreMessage;
      // A surface port rides beside its message; the message alone means nothing.
      if (message.kind === "push" && message.channel === TerminalSurface.open) {
        const surface = event.ports?.[0];
        if (surface !== undefined) served.openSurface(message.payload as TerminalSurfaceOpen, surfacePort(surface));
        return;
      }
      if (message.kind === "push" && message.channel === TERMINAL_CONNECT) return;
      handler(message);
    };
    on.on("message", listener);
    return () => on.off("message", listener);
  },
});

const parent = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (parent !== undefined) {
  // The parent is the first core when the core runs in main; a core's own port replaces it.
  served.attach(corePort(parent));
  parent.on("message", (event) => {
    const message = event.data as CoreMessage;
    const port = event.ports?.[0];
    // The parent's orderly quit reaches the PTYs even when a core is attached
    // and owns the port: hang up, then leave, so main's wait sees an exit.
    if (message.kind === "push" && message.channel === TerminalInbound.shutdown) {
      void served.hangupAll().finally(() => process.exit(0));
      return;
    }
    if (message.kind !== "push" || message.channel !== TERMINAL_CONNECT || port === undefined) return;
    const core = corePort(port);
    served.attach(core);
    // The PTYs stay, detached, for the next core to adopt.
    port.on("close", () => served.detach(core));
    port.start();
  });
}
