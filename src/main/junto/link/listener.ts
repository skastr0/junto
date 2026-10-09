import { chmodSync, lstatSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import {
  acquireControlListenerLease,
  captureControlSocketPathIdentity,
  controlListenerLeaseHeld,
  controlSocketPathOwnedByLease,
  prepareControlDirectory,
  releaseControlListenerLease,
  removeObservedSocket,
  removeOwnedControlSocketPath,
  type ControlSocketPathIdentity,
} from "../control-filesystem";
import type { MachineLinkListener } from "./service";
import type { LinkSession } from "./types";

export const coreControlSocketPath = (home: string): string => join(home, ".junto", "core", "control.sock");

export interface LinkListenerOptions {
  readonly home: string;
  readonly accept: (socket: Socket) => Promise<LinkSession>;
}

export interface LinkListenerRuntime {
  /** Tests can lower product bounds. */
  readonly maxClients?: number;
  readonly drainMs?: number;
}

const bounded = (value: number | undefined, maximum: number): number =>
  value !== undefined && Number.isFinite(value) && value >= 1 ? Math.min(Math.floor(value), maximum) : maximum;

export const startLinkListener = async (
  options: LinkListenerOptions,
  runtime: LinkListenerRuntime = {},
): Promise<MachineLinkListener> => {
  const socketPath = coreControlSocketPath(options.home);
  prepareControlDirectory(join(options.home, ".junto", "core"));
  const lease = await acquireControlListenerLease(socketPath);
  const sockets = new Set<Socket>();
  const sessions = new Set<LinkSession>();
  const starts = new Set<Promise<void>>();
  let stopping = false;
  let identity: ControlSocketPathIdentity | undefined;
  let closeFlight: Promise<void> | undefined;
  const server = createServer({ allowHalfOpen: false }, (socket) => {
    socket.on("error", () => undefined);
    if (stopping || sockets.size >= bounded(runtime.maxClients, 8)) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.pause();
    socket.setTimeout(10_000, () => socket.destroy());
    const start = options.accept(socket).then((session) => {
      sessions.add(session);
      void session.closed.then(() => sessions.delete(session));
      if (stopping || socket.destroyed) {
        return session.close();
      }
      socket.setTimeout(0);
      socket.resume();
      return undefined;
    }).catch(() => { socket.destroy(); });
    starts.add(start);
    void start.finally(() => starts.delete(start));
  });
  const closeServer = (): Promise<void> => new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
  try {
    await removeObservedSocket(lease);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ path: socketPath, readableAll: false, writableAll: false }, () => {
        server.off("error", reject);
        try {
          identity = captureControlSocketPathIdentity(lease);
          chmodSync(socketPath, 0o600);
          const stat = lstatSync(socketPath);
          if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || !controlSocketPathOwnedByLease(lease, identity)) {
            throw new Error("core control socket is not owner-only");
          }
          resolve();
        } catch (cause) { reject(cause); }
      });
    });
  } catch (cause) {
    stopping = true;
    for (const socket of sockets) socket.destroy();
    await closeServer();
    if (identity !== undefined) removeOwnedControlSocketPath(lease, identity);
    await releaseControlListenerLease(lease);
    throw cause;
  }
  server.on("error", () => {
    stopping = true;
    for (const socket of sockets) socket.destroy();
  });
  const beginShutdown = (): void => {
    stopping = true;
    for (const socket of sockets) socket.destroy();
  };
  const close = (): Promise<void> => {
    if (closeFlight !== undefined) return closeFlight;
    beginShutdown();
    closeFlight = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([closeServer(), ...starts, ...[...sessions].map((session) => session.close())]),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("core link listener did not drain")), bounded(runtime.drainMs, 5_000));
          }),
        ]);
      } finally { if (timer !== undefined) clearTimeout(timer); }
      if (identity !== undefined) removeOwnedControlSocketPath(lease, identity);
      await releaseControlListenerLease(lease);
    })();
    return closeFlight;
  };
  return {
    socketPath,
    ready: () => !stopping && server.listening && controlListenerLeaseHeld(lease) && identity !== undefined && controlSocketPathOwnedByLease(lease, identity),
    beginShutdown,
    close,
  };
};
