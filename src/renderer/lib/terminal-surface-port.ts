import { IPC_CHANNELS } from "@shared/ipc";

/**
 * Surface ports (terminal process, phase 3): main hands a control view a
 * MessagePort straight to its PTY, and the preload posts it to this window
 * as a message naming the lease. A port can arrive before the attach that
 * minted the lease has answered, so one waits here until its view takes it.
 * A lease can get a new port later (shown again after it was hidden).
 */
const waiting = new Map<string, MessagePort>();
const takers = new Map<string, (port: MessagePort) => void>();
let listening = false;

const arrived = (event: MessageEvent): void => {
  if (event.source !== window) return;
  const data = event.data as { readonly type?: unknown; readonly leaseId?: unknown } | null;
  if (data?.type !== IPC_CHANNELS.terminalSurface || typeof data.leaseId !== "string") return;
  const port = event.ports[0];
  if (port === undefined) return;
  const take = takers.get(data.leaseId);
  if (take !== undefined) return take(port);
  waiting.get(data.leaseId)?.close();
  waiting.set(data.leaseId, port);
};

/** Take every surface port for this lease, the one waiting first. */
export const takeSurfacePorts = (leaseId: string, take: (port: MessagePort) => void): (() => void) => {
  // A window with no message events (a test's stand-in) gets no ports: its
  // views read and type over IPC.
  if (!listening && typeof window.addEventListener === "function") {
    listening = true;
    window.addEventListener("message", arrived);
  }
  takers.set(leaseId, take);
  const early = waiting.get(leaseId);
  if (early !== undefined) {
    waiting.delete(leaseId);
    take(early);
  }
  return () => {
    if (takers.get(leaseId) === take) takers.delete(leaseId);
    waiting.get(leaseId)?.close();
    waiting.delete(leaseId);
  };
};
