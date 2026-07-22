/**
 * Local term control server — exposes LocalSessionHost over a Unix socket so
 * Command Center can reach the same API on a Remote station via SSH forward.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import {
  TERM_CONTROL_PROTOCOL,
  TERM_MAX_FRAME_BYTES,
  termControlDir,
  termControlSocketPath,
  termControlTokenPath,
  type TermControlRequest,
  type TermControlResponse,
} from "@shared/term-control";
import type { ControlLease, LocalHostEvent, LocalSessionHost } from "./local-host";

const tokenHash = (token: string): Buffer =>
  createHash("sha256").update(token, "utf8").digest();

const safeEqualToken = (a: string, b: string): boolean => {
  try {
    const ba = tokenHash(a);
    const bb = tokenHash(b);
    return ba.length === bb.length && timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
};

/** JSON cannot encode bigint — wire seq as decimal string over NDJSON. */
const jsonLine = (value: unknown): string =>
  `${JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n`;

export type TermControlServer = {
  readonly socketPath: string;
  readonly token: string;
  readonly close: () => Promise<void>;
};

export const startTermControlServer = async (
  host: LocalSessionHost,
  options?: { readonly home?: string },
): Promise<TermControlServer> => {
  const home = options?.home;
  const dir = termControlDir(home);
  const socketPath = termControlSocketPath(home);
  const tokenPath = termControlTokenPath(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);

  const token = randomBytes(32).toString("hex");
  const tmpToken = `${tokenPath}.${process.pid}.tmp`;
  writeFileSync(tmpToken, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmpToken, tokenPath);
  chmodSync(tokenPath, 0o600);

  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {
      // ignore
    }
  }

  /** leaseId → sockets subscribed to that session's events */
  const leaseSockets = new Map<string, Set<Socket>>();
  const socketLeases = new Map<Socket, Set<string>>();
  const leaseById = new Map<string, ControlLease>();
  /** Accepted clients must be explicitly drained on close; Server.close alone waits forever. */
  const sockets = new Set<Socket>();
  let closing = false;
  let closePromise: Promise<void> | undefined;

  const trackLease = (socket: Socket, lease: ControlLease): void => {
    leaseById.set(lease.leaseId, lease);
    let set = leaseSockets.get(lease.leaseId);
    if (!set) {
      set = new Set();
      leaseSockets.set(lease.leaseId, set);
    }
    set.add(socket);
    let owned = socketLeases.get(socket);
    if (!owned) {
      owned = new Set();
      socketLeases.set(socket, owned);
    }
    owned.add(lease.leaseId);
  };

  const dropSocket = (socket: Socket): void => {
    const owned = socketLeases.get(socket);
    socketLeases.delete(socket);
    if (!owned) return;
    for (const leaseId of owned) {
      const set = leaseSockets.get(leaseId);
      set?.delete(socket);
      if (set && set.size === 0) leaseSockets.delete(leaseId);
      const lease = leaseById.get(leaseId);
      if (lease) {
        host.release(lease);
        leaseById.delete(leaseId);
      }
    }
  };

  const onHostEvent = (payload: LocalHostEvent): void => {
    const line = jsonLine({ v: TERM_CONTROL_PROTOCOL, type: "event", payload });
    for (const [leaseId, socks] of leaseSockets) {
      const lease = leaseById.get(leaseId);
      if (!lease || lease.bindingId !== payload.bindingId || lease.epoch !== payload.epoch) {
        continue;
      }
      for (const sock of [...socks]) {
        if (sock.destroyed) {
          dropSocket(sock);
          continue;
        }
        try {
          sock.write(line);
        } catch {
          dropSocket(sock);
        }
      }
    }
  };
  host.on("event", onHostEvent);

  const handle = async (
    req: TermControlRequest,
    socket: Socket,
  ): Promise<TermControlResponse> => {
    const id = req.id;
    try {
      switch (req.op) {
        case "ping":
          return { v: 1, id, ok: true, data: { pong: true } };
        case "create": {
          const summary = host.create({
            bindingId: req.bindingId,
            launch: req.launch,
            cols: req.cols,
            rows: req.rows,
            canvasName: req.canvasName,
            nodeId: req.nodeId,
            label: req.label,
          });
          return { v: 1, id, ok: true, data: summary };
        }
        case "list":
          return { v: 1, id, ok: true, data: { sessions: host.list() } };
        case "get":
          return { v: 1, id, ok: true, data: host.get(req.bindingId) ?? null };
        case "kill":
          return { v: 1, id, ok: true, data: host.kill(req.bindingId) };
        case "bindCanvas":
          host.bindCanvas(req.bindingId, req.ref);
          return { v: 1, id, ok: true };
        case "attach": {
          const result = host.attach({
            bindingId: req.bindingId,
            mode: req.mode,
            takeover: req.takeover,
          });
          if (!result.ok) return { v: 1, id, ok: false, error: result.message };
          trackLease(socket, result.lease);
          return {
            v: 1,
            id,
            ok: true,
            data: {
              leaseId: result.lease.leaseId,
              bindingId: result.lease.bindingId,
              epoch: result.lease.epoch,
              mode: result.lease.mode,
              cols: result.cols,
              rows: result.rows,
              status: result.status,
              pid: result.pid,
              journal: result.journal,
            },
          };
        }
        case "release": {
          const lease = leaseById.get(req.leaseId);
          if (lease) {
            host.release(lease);
            leaseById.delete(req.leaseId);
            leaseSockets.get(req.leaseId)?.delete(socket);
            socketLeases.get(socket)?.delete(req.leaseId);
          }
          return { v: 1, id, ok: true };
        }
        case "write": {
          const lease = leaseById.get(req.leaseId);
          if (!lease) return { v: 1, id, ok: false, error: "unknown lease" };
          return { v: 1, id, ok: true, data: host.write(lease, req.data) };
        }
        case "resize": {
          const lease = leaseById.get(req.leaseId);
          if (!lease) return { v: 1, id, ok: false, error: "unknown lease" };
          return {
            v: 1,
            id,
            ok: true,
            data: host.resize(lease, req.cols, req.rows),
          };
        }
        case "shutdown":
          // Remote operator must not mass-kill via socket; only local app quit.
          return { v: 1, id, ok: false, error: "shutdown not allowed over control socket" };
        default:
          return { v: 1, id, ok: false, error: "unknown op" };
      }
    } catch (err) {
      return {
        v: 1,
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  const server: Server = createServer((socket) => {
    if (closing) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    let buf = "";
    let authed = false;
    let closed = false;

    const fail = (msg: string): void => {
      if (closed) return;
      try {
        socket.write(
          jsonLine({ v: 1, id: "0", ok: false, error: msg } satisfies TermControlResponse),
        );
      } catch {
        // ignore
      }
      socket.destroy();
    };

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (closed || closing) {
        socket.destroy();
        return;
      }
      buf += chunk;
      if (buf.length > TERM_MAX_FRAME_BYTES) {
        fail("frame too large");
        return;
      }
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          fail("invalid json");
          return;
        }
        if (!authed) {
          const auth = msg as { token?: string };
          if (typeof auth?.token !== "string" || !safeEqualToken(auth.token, token)) {
            fail("unauthorized");
            return;
          }
          authed = true;
          try {
            socket.write(jsonLine({ v: 1, id: "auth", ok: true }));
          } catch {
            // ignore
          }
          continue;
        }
        const req = msg as TermControlRequest;
        if (!req || req.v !== 1 || typeof req.id !== "string" || typeof req.op !== "string") {
          fail("invalid request");
          return;
        }
        void handle(req, socket).then((res) => {
          if (socket.destroyed || closing) return;
          try {
            socket.write(jsonLine(res));
          } catch {
            dropSocket(socket);
          }
        });
      }
    });
    socket.on("close", () => {
      closed = true;
      sockets.delete(socket);
      dropSocket(socket);
    });
    socket.on("error", () => {
      closed = true;
      sockets.delete(socket);
      dropSocket(socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ path: socketPath, readableAll: false, writableAll: false }, () => {
      try {
        chmodSync(socketPath, 0o600);
      } catch {
        // ignore
      }
      resolve();
    });
  });

  return {
    socketPath,
    token,
    close: async () => {
      if (closePromise) return closePromise;
      closing = true;
      host.off("event", onHostEvent);
      closePromise = (async () => {
        // Stop accepting before draining existing peers, so no late command can
        // arrive during the bounded grace period.
        const serverClosed = new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        for (const socket of sockets) socket.end();
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        for (const socket of sockets) socket.destroy();
        await serverClosed;
        try {
          if (existsSync(socketPath)) unlinkSync(socketPath);
        } catch {
          // ignore
        }
      })();
      return closePromise;
    },
  };
};

/** Read token written by a live local server (same machine). */
export const readLocalTermToken = (home?: string): string | undefined => {
  try {
    const raw = readFileSync(termControlTokenPath(home), "utf8").trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
};
