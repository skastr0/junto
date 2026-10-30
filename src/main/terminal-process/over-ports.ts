import type { CoreMessage, CorePort } from "../core-process/port";
import { terminalClient, type TerminalClient } from "./client";

/** Electron's MessagePortMain, as the core process is handed one. */
export type TerminalPortMain = {
  readonly postMessage: (message: unknown, transfer?: readonly unknown[]) => void;
  readonly on: (event: "message" | "close", listener: (event: { readonly data: unknown }) => void) => void;
  readonly off: (event: "message", listener: (event: { readonly data: unknown }) => void) => void;
  readonly start: () => void;
};

/**
 * The core's terminals when the core runs in its own process (one plane, in
 * the core): main hands the core a port straight to the terminal process,
 * and a new one each time that process starts again. Until a port arrives,
 * and after its process is gone, a spawn is refused; it never falls back to
 * a PTY in the core.
 */
export const terminalsOverPorts = (): TerminalClient & { readonly connect: (port: TerminalPortMain) => void } => {
  let current: TerminalClient | undefined;
  return {
    connect: (port) => {
      const corePort: CorePort = {
        post: (message) => port.postMessage(message),
        listen: (handler) => {
          const on = (event: { readonly data: unknown }) => handler(event.data as CoreMessage);
          port.on("message", on);
          return () => port.off("message", on);
        },
      };
      const client = terminalClient(corePort, (message, surface) => port.postMessage(message, [surface]));
      current?.fail("the Junto terminal process was replaced");
      current = client;
      port.on("close", () => {
        if (current === client) current = undefined;
        client.fail("the Junto terminal process exited");
      });
      port.start();
    },
    spawn: (input) => {
      if (current === undefined) throw new Error("the Junto terminal process is not connected");
      return current.spawn(input);
    },
    fail: (reason) => current?.fail(reason),
  };
};
