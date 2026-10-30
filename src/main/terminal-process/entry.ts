/**
 * The terminal process (protect the main thread, phase 1): an Electron
 * utilityProcess that holds every PTY, so a PTY's reads and writes never wait
 * on Electron main's or the core's event loop. It serves the core over its
 * parent port and decides nothing about seats.
 */
import { createRequire } from "node:module";
import type { CoreMessage, CorePort } from "../core-process/port";
import { serveTerminals } from "./serve";

type ParentPort = {
  readonly postMessage: (message: unknown) => void;
  readonly on: (event: "message", listener: (event: { readonly data: unknown }) => void) => void;
  readonly off: (event: "message", listener: (event: { readonly data: unknown }) => void) => void;
};

// node-pty stays a runtime load beside the installed file (app-process-plane.ts).
const require = createRequire(typeof __filename === "string" ? __filename : import.meta.url);

const parent = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (parent !== undefined) {
  const port: CorePort = {
    post: (message) => parent.postMessage(message),
    listen: (handler) => {
      const on = (event: { readonly data: unknown }) => handler(event.data as CoreMessage);
      parent.on("message", on);
      return () => parent.off("message", on);
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePty = require("node-pty") as typeof import("node-pty");
  serveTerminals(port, (command, args, options) => nodePty.spawn(command, [...args], options));
}
