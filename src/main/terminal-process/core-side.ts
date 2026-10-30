import { host } from "../core-process/host-ops";
import { TERMINAL_CONNECT } from "./protocol";
import { terminalsOverPorts, type TerminalPortMain } from "./over-ports";
import { useTerminalProcess } from "./use";

declare module "../core-process/host-ops" {
  interface HostOps {
    /** Main posts the core a new port to the terminal process (`pty.connect`), then answers. */
    "terminal.connect": import("../core-process/host-ops").HostOp<Record<string, never>, boolean>;
  }
}

type ParentPort = {
  readonly on: (event: "message", listener: (event: { readonly data: unknown; readonly ports?: readonly TerminalPortMain[] }) => void) => void;
};

/**
 * The core in its own process: every PTY its plane spawns runs in the
 * terminal process over a port main hands it, never in the core. Installed
 * before the plane starts; resolves once the first port is here, so a seat
 * the boot resumes has its terminals. A later port (the terminal process
 * started again) replaces the last.
 */
export const connectCoreTerminals = async (parent: ParentPort): Promise<void> => {
  const terminals = terminalsOverPorts();
  useTerminalProcess(terminals);
  let first!: () => void;
  const connected = new Promise<void>((resolve) => { first = resolve; });
  parent.on("message", (event) => {
    const message = event.data as { readonly kind?: unknown; readonly channel?: unknown };
    const port = event.ports?.[0];
    if (message.kind !== "push" || message.channel !== TERMINAL_CONNECT || port === undefined) return;
    terminals.connect(port);
    first();
  });
  if (!(await host.call("terminal.connect", {}))) throw new Error("Electron main gave the core no terminal process");
  await connected;
};
