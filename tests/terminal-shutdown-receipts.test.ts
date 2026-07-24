import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IDisposable, IPty } from "node-pty";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppProcessPlane } from "../src/main/vellum/app-process-plane";
import { setHostsSnapshot, hostsSnapshot } from "../src/main/vellum/hosts/snapshot";
import { TermControlClient } from "../src/main/vellum/term/control-client";
import {
  startTermControlServer,
  TermControlStartupError,
} from "../src/main/vellum/term/control-server";
import { LocalSessionHost } from "../src/main/vellum/term/local-host";
import { TermPlane, termPlaneBlocksAppExit } from "../src/main/vellum/term/plane";
import { TerminalRouter } from "../src/main/vellum/term/router";
import { termControlSocketPath, termControlTokenPath } from "../src/shared/term-control";
import { makeFakeTerminalProcessAuthority } from "./helpers/fake-terminal-process-authority";

const cleanups: Array<() => Promise<void> | void> = [];
const initialHosts = hostsSnapshot();

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  vi.restoreAllMocks();
  setHostsSnapshot(initialHosts);
});

/**
 * A node-pty-shaped transport, not process authority. Omitting `pid` makes the
 * real process-signal module mint its opaque OwnedProcess variant, so this test
 * exercises the sealed child-handle path without a host PID or test mint.
 */
class SealedShutdownPtyPort {
  readonly write = vi.fn((_data: string) => undefined);
  readonly resize = vi.fn((_cols: number, _rows: number) => undefined);
  readonly kill = vi.fn((signal?: string) => {
    if (signal !== "SIGKILL" || this.exited) return;
    this.exited = true;
    queueMicrotask(() => {
      for (const listener of [...this.exitListeners]) {
        listener({ exitCode: 1, signal: 9 });
      }
    });
  });
  readonly onData = vi.fn((listener: (data: string) => void): IDisposable => {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  });
  readonly onExit = vi.fn((listener: (event: {
    readonly exitCode: number;
    readonly signal?: number;
  }) => void): IDisposable => {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  });
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: {
    readonly exitCode: number;
    readonly signal?: number;
  }) => void>();
  private exited = false;

  asPty(): IPty {
    return this as unknown as IPty;
  }
}

const localHost = (exitOnSignal: "SIGTERM" | "SIGKILL" | false = "SIGTERM") =>
  new LocalSessionHost(
    makeFakeTerminalProcessAuthority(() => ({
      pid: undefined,
      exitOnSignal,
    })).authority,
    { killGraceMs: 5, shutdownGraceMs: 5, lateExitGraceMs: 5 },
  );

const listen = (server: Server, socketPath: string): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

describe("terminal shutdown receipts", () => {
  it("drains a native PTY through the sealed OwnedProcess path", async () => {
    const nodePty = require("node-pty") as typeof import("node-pty");
    const pty = new SealedShutdownPtyPort();
    vi.spyOn(nodePty, "spawn").mockReturnValue(pty.asPty());
    const processPlane = createAppProcessPlane({ termGraceMs: 5, killGraceMs: 5 });
    const host = new LocalSessionHost(processPlane, {
      // Let the shutdown phase own escalation deterministically.
      killGraceMs: 100,
      shutdownGraceMs: 5,
      lateExitGraceMs: 5,
    });
    const plane = new TermPlane(host);

    const created = await plane.router.create({
      bindingId: "sealed-owned",
      hostId: "local",
      launch: { kind: "shell", argv: ["/bin/sh", "-l"] },
    });
    expect(created).toMatchObject({ status: "running", backend: "pty" });

    await expect(plane.drainOnQuit("sealed-owned-test")).resolves.toMatchObject({
      clean: true,
      local: { clean: true, stragglers: [] },
      retainedLabels: [],
    });
    expect(pty.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    await expect(processPlane.drainOnQuit()).resolves.toEqual({
      clean: true,
      stragglers: [],
    });
  });

  it("cuts every plane admission synchronously and shares one clean drain", async () => {
    const host = localHost();
    const plane = new TermPlane(host);
    await plane.router.create({ bindingId: "before", hostId: "local" });

    plane.beginShutdown("test");
    const first = plane.drainOnQuit("ignored-reentrant-reason");
    const second = plane.drainOnQuit("ignored-again");

    expect(first).toBe(second);
    await expect(
      plane.router.create({ bindingId: "late", hostId: "local" }),
    ).rejects.toThrow(/stopping/);
    await expect(plane.start()).rejects.toThrow(/stopping/);

    const receipt = await first;
    expect(receipt).toMatchObject({ clean: true, retainedLabels: [] });
    expect(receipt.local).toEqual({ clean: true, stragglers: [] });
    expect(receipt.router?.clean).toBe(true);
  });

  it("contains an isolated app control listener under its owned home", async () => {
    const home = mkdtempSync(join(tmpdir(), "vellum-term-plane-home-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const plane = new TermPlane(localHost());

    await plane.start({ controlHome: home });

    expect(existsSync(termControlSocketPath(home))).toBe(true);
    expect(existsSync(termControlTokenPath(home))).toBe(true);
    await expect(plane.drainOnQuit("isolated-home-test")).resolves.toMatchObject({
      clean: true,
      retainedLabels: [],
    });
    expect(existsSync(termControlSocketPath(home))).toBe(false);
  });

  it("reports an exact local terminal generation that refuses both signals", async () => {
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: undefined,
      exitOnSignal: false,
    }));
    const host = new LocalSessionHost(fake.authority, {
      killGraceMs: 5,
      shutdownGraceMs: 5,
      lateExitGraceMs: 5,
    });
    const plane = new TermPlane(host);
    await plane.router.create({ bindingId: "stuck", hostId: "local" });

    const receipt = await plane.drainOnQuit("test-stuck");

    expect(receipt.clean).toBe(false);
    expect(receipt.retainedLabels).toContain("local-sessions");
    expect(receipt.local).toMatchObject({
      clean: false,
      stragglers: [{ bindingId: "stuck" }],
    });

    fake.controllers[0]?.exit();
    await expect(plane.drainOnQuit("retry-after-exit")).resolves.toMatchObject({
      clean: true,
      retainedLabels: [],
    });
  });

  it("bounds an admitted remote dial, refuses late dials, then drains on retry", async () => {
    const host = localHost();
    const router = new TerminalRouter(host, { shutdownDeadlineMs: 20 });
    setHostsSnapshot([
      ...initialHosts,
      {
        id: "studio",
        label: "Studio",
        kind: "remote",
        endpoint: "studio.local",
        capabilities: ["terminal"],
      },
    ]);
    let releaseDial!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDial = resolve;
    });
    (router as unknown as {
      connectRemote: (...args: unknown[]) => Promise<never>;
    }).connectRemote = async (_hostId, _endpoint, _generation, admit) => {
      await gate;
      if (!(admit as () => boolean)()) throw new Error("connection revoked");
      throw new Error("unexpected admission");
    };

    const admitted = router.create({ bindingId: "dial", hostId: "studio" });
    await Promise.resolve();
    router.beginShutdown();
    await expect(
      router.create({ bindingId: "late", hostId: "studio" }),
    ).rejects.toThrow(/stopping/);

    const first = await router.drainOnQuit();
    expect(first).toMatchObject({
      clean: false,
      retainedCounts: { dials: 1 },
    });
    expect(first.retainedLabels).toContain("remote-dial");

    releaseDial();
    await expect(admitted).rejects.toThrow(/revoked/);
    await expect(router.drainOnQuit()).resolves.toMatchObject({ clean: true });
  });

  it("retains an actual remote client close until its witness settles", async () => {
    const host = localHost();
    const router = new TerminalRouter(host, { shutdownDeadlineMs: 20 });
    let resolveClient!: (receipt: {
      clean: true;
      closeObserved: true;
      pendingRequests: 0;
      diagnostics: readonly [];
    }) => void;
    const clientDrain = new Promise<{
      clean: true;
      closeObserved: true;
      pendingRequests: 0;
      diagnostics: readonly [];
    }>((resolve) => {
      resolveClient = resolve;
    });
    const beginShutdown = vi.fn();
    (router as unknown as { remotes: Map<string, unknown> }).remotes.set("studio", {
      client: {
        beginShutdown,
        drainOnQuit: () => clientDrain,
        close: vi.fn(),
      },
      endpoint: "studio.local",
      generation: 0,
      scope: {},
      rootScope: undefined,
      forward: {},
      leaseMap: new Map(),
      reverseLease: new Map(),
    });

    const first = await router.drainOnQuit();
    expect(beginShutdown).toHaveBeenCalled();
    expect(first.clean).toBe(false);
    expect(first.retainedCounts.remoteEntries).toBe(1);

    resolveClient({
      clean: true,
      closeObserved: true,
      pendingRequests: 0,
      diagnostics: [],
    });
    await clientDrain;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(router.drainOnQuit()).resolves.toMatchObject({ clean: true });
  });

  it("retries an unclean bounded client receipt after its close becomes observable", async () => {
    const host = localHost();
    const router = new TerminalRouter(host, { shutdownDeadlineMs: 20 });
    const drainOnQuit = vi
      .fn()
      .mockResolvedValueOnce({
        clean: false,
        closeObserved: false,
        pendingRequests: 1,
        diagnostics: [],
      })
      .mockResolvedValueOnce({
        clean: true,
        closeObserved: true,
        pendingRequests: 0,
        diagnostics: [],
      });
    (router as unknown as { remotes: Map<string, unknown> }).remotes.set("studio", {
      client: { beginShutdown: vi.fn(), drainOnQuit, close: vi.fn() },
      endpoint: "studio.local",
      generation: 0,
      scope: {},
      rootScope: undefined,
      forward: {},
      leaseMap: new Map(),
      reverseLease: new Map(),
    });

    await expect(router.drainOnQuit()).resolves.toMatchObject({ clean: false });
    await expect(router.drainOnQuit()).resolves.toMatchObject({ clean: true });
    expect(drainOnQuit).toHaveBeenCalledTimes(2);
  });

  it("lets ordinary stale-route recovery re-observe a late client close", async () => {
    const host = localHost();
    const router = new TerminalRouter(host, { shutdownDeadlineMs: 20 });
    const drainOnQuit = vi
      .fn()
      .mockResolvedValueOnce({
        clean: false,
        closeObserved: false,
        pendingRequests: 1,
        diagnostics: [],
      })
      .mockResolvedValueOnce({
        clean: true,
        closeObserved: true,
        pendingRequests: 0,
        diagnostics: [],
      });
    const entry = {
      client: { beginShutdown: vi.fn(), drainOnQuit, close: vi.fn() },
      endpoint: "studio.local",
      generation: 0,
      scope: {},
      rootScope: undefined,
      forward: {},
      leaseMap: new Map(),
      reverseLease: new Map(),
    };
    (router as unknown as { remotes: Map<string, unknown> }).remotes.set("studio", entry);
    const closeRemoteEntry = (
      router as unknown as {
        closeRemoteEntry: (hostId: string, value: unknown) => Promise<void>;
      }
    ).closeRemoteEntry.bind(router);

    await expect(closeRemoteEntry("studio", entry)).rejects.toThrow(/unclean/);
    await expect(closeRemoteEntry("studio", entry)).resolves.toBeUndefined();
    expect(drainOnQuit).toHaveBeenCalledTimes(2);
  });

  it("never converts a rejected forward-scope close into a clean retry", async () => {
    const host = localHost();
    const router = new TerminalRouter(host, { shutdownDeadlineMs: 20 });
    const clientReceipt = {
      clean: true as const,
      closeObserved: true as const,
      pendingRequests: 0 as const,
      diagnostics: [] as const,
    };
    const failedScopeReceipt = {
      clean: false as const,
      client: clientReceipt,
      scopeClosed: false as const,
      diagnostics: ["scope: synthetic close rejection"] as const,
    };
    const closeFlight = Promise.resolve(failedScopeReceipt);
    const drainOnQuit = vi.fn(() => Promise.resolve(clientReceipt));
    (router as unknown as { remotes: Map<string, unknown> }).remotes.set("studio", {
      client: { beginShutdown: vi.fn(), drainOnQuit, close: vi.fn() },
      endpoint: "studio.local",
      generation: 0,
      scope: {},
      rootScope: undefined,
      forward: {},
      leaseMap: new Map(),
      reverseLease: new Map(),
      closeFlight,
      closeReceipt: failedScopeReceipt,
    });

    const first = await router.drainOnQuit();
    const second = await router.drainOnQuit();

    expect(first.clean).toBe(false);
    expect(second.clean).toBe(false);
    expect(second.diagnostics.join(" ")).toContain("scope: synthetic close rejection");
    expect(drainOnQuit).not.toHaveBeenCalled();
  });

  it("drains client requests only after the socket close witness", async () => {
    const home = mkdtempSync(join(tmpdir(), "vellum-term-client-close-"));
    const socketPath = join(home, "control.sock");
    const peers = new Set<Socket>();
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      peers.add(socket);
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        if (chunk.includes("token")) {
          socket.write(`${JSON.stringify({ v: 1, id: "auth", ok: true })}\n`);
        }
      });
      socket.once("close", () => peers.delete(socket));
    });
    await listen(server, socketPath);
    cleanups.push(async () => {
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    });

    const client = await TermControlClient.connect({
      socketPath,
      token: "token",
      timeoutMs: 1_000,
    });
    const pending = client.list();
    const first = client.drainOnQuit();
    const second = client.drainOnQuit();

    expect(first).toBe(second);
    const receipt = await first;
    await expect(pending).rejects.toThrow(/closed/);
    expect(receipt).toEqual({
      clean: true,
      closeObserved: true,
      pendingRequests: 0,
      diagnostics: [],
    });
  });

  it("does not treat a generic client error as terminal proof", async () => {
    const home = mkdtempSync(join(tmpdir(), "vellum-term-client-error-"));
    const socketPath = join(home, "control.sock");
    const peers = new Set<Socket>();
    const server = createServer((socket) => {
      peers.add(socket);
      socket.setEncoding("utf8");
      socket.on("data", () => {
        socket.write(`${JSON.stringify({ v: 1, id: "auth", ok: true })}\n`);
      });
      socket.once("close", () => peers.delete(socket));
    });
    await listen(server, socketPath);
    cleanups.push(async () => {
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    });

    const client = await TermControlClient.connect({
      socketPath,
      token: "token",
      timeoutMs: 1_000,
    });
    const socket = (client as unknown as { socket: Socket }).socket;
    socket.emit("error", new Error("synthetic transport fault"));
    client.close();

    const receipt = await client.drainOnQuit();
    expect(receipt.closeObserved).toBe(true);
    expect(receipt.clean).toBe(true);
    expect(receipt.diagnostics.join(" ")).toContain("synthetic transport fault");
  });

  it("never unlinks a foreign replacement of the owned term socket", async () => {
    const home = mkdtempSync(join(tmpdir(), "vt-r-"));
    const host = localHost();
    const server = await startTermControlServer(host, {
      home,
      shutdownGraceMs: 5,
      shutdownDeadlineMs: 20,
    });
    cleanups.push(async () => {
      if (existsSync(server.socketPath)) unlinkSync(server.socketPath);
      await server.drainOnQuit();
      rmSync(home, { recursive: true, force: true });
    });

    unlinkSync(server.socketPath);
    writeFileSync(server.socketPath, "foreign replacement", "utf8");
    server.beginShutdown();
    const first = await server.drainOnQuit();

    expect(first.clean).toBe(false);
    expect(first.retainedCounts.socketPaths).toBe(1);
    expect(readFileSync(server.socketPath, "utf8")).toBe("foreign replacement");

    unlinkSync(server.socketPath);
    const second = await server.drainOnQuit();
    expect(second.clean).toBe(true);
  });

  it("blocks app exit only for host-owned local sessions, never control UDS dirt", () => {
    expect(
      termPlaneBlocksAppExit({
        clean: false,
        retainedLabels: ["control-server"],
        diagnostics: ["control-retained: listener"],
        local: { clean: true, stragglers: [] },
      }),
    ).toBe(false);
    expect(
      termPlaneBlocksAppExit({
        clean: false,
        retainedLabels: ["remote-router"],
        diagnostics: [],
        local: { clean: true, stragglers: [] },
      }),
    ).toBe(false);
    expect(
      termPlaneBlocksAppExit({
        clean: false,
        retainedLabels: ["local-sessions"],
        diagnostics: [],
        local: { clean: false, stragglers: [{ bindingId: "stuck" } as never] },
      }),
    ).toBe(true);
    expect(
      termPlaneBlocksAppExit({
        clean: true,
        retainedLabels: [],
        diagnostics: [],
        local: { clean: true, stragglers: [] },
      }),
    ).toBe(false);
  });

  it("still retires the bound socket after the Darwin lockf lease dies", async () => {
    // Repro: Ctrl+C / process-group death can drop the lockf holder before quit
    // drain. Close must use captured path identity, not a live lease, or quit
    // blocks forever with listener+socket-path. Kill only this lease's holders —
    // never drain the singleton appProcessPlane (that permanently quiesces it).
    if (process.platform !== "darwin") return;
    const home = mkdtempSync(join(tmpdir(), "vt-lockf-death-"));
    const host = localHost();
    const server = await startTermControlServer(host, {
      home,
      shutdownGraceMs: 5,
      shutdownDeadlineMs: 200,
    });
    cleanups.push(async () => {
      if (existsSync(server.socketPath)) unlinkSync(server.socketPath);
      await server.drainOnQuit().catch(() => undefined);
      rmSync(home, { recursive: true, force: true });
    });

    const leasePath = `${server.socketPath}.lease`;
    const { execFileSync } = await import("node:child_process");
    let holderPids: string[] = [];
    try {
      holderPids = execFileSync("lsof", ["-t", leasePath], { encoding: "utf8" })
        .trim()
        .split("\n")
        .filter(Boolean);
    } catch {
      holderPids = [];
    }
    expect(holderPids.length).toBeGreaterThan(0);
    for (const pid of holderPids) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        // Already reaped.
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    await expect(server.drainOnQuit()).resolves.toMatchObject({
      clean: true,
      retainedLabels: [],
      retainedCounts: {
        requests: 0,
        listenerClosures: 0,
        sockets: 0,
        socketPaths: 0,
      },
    });
    expect(existsSync(server.socketPath)).toBe(false);
  });

  it("refuses to replace a live listener or rotate its token", async () => {
    const home = mkdtempSync(join(tmpdir(), "vt-l-"));
    const host = localHost();
    const server = await startTermControlServer(host, { home });
    cleanups.push(async () => {
      await server.close();
      rmSync(home, { recursive: true, force: true });
    });
    const tokenBefore = readFileSync(termControlTokenPath(home), "utf8");

    await expect(startTermControlServer(localHost(), { home })).rejects.toThrow(
      /live listener/,
    );

    expect(readFileSync(termControlTokenPath(home), "utf8")).toBe(tokenBefore);
    expect(existsSync(termControlSocketPath(home))).toBe(true);
  });

  it("refuses to delete a non-socket object at the term control path", async () => {
    const home = mkdtempSync(join(tmpdir(), "vt-f-"));
    const socketPath = termControlSocketPath(home);
    mkdirSync(join(home, ".vellum", "term"), { recursive: true });
    writeFileSync(socketPath, "operator-owned", "utf8");
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));

    await expect(startTermControlServer(localHost(), { home })).rejects.toThrow(
      /refusing to replace non-socket/,
    );

    expect(readFileSync(socketPath, "utf8")).toBe("operator-owned");
  });

  it("publishes the token without following the former predictable temp path", async () => {
    const home = mkdtempSync(join(tmpdir(), "vt-t-"));
    const tokenPath = termControlTokenPath(home);
    const target = join(home, "operator-file");
    mkdirSync(join(home, ".vellum", "term"), { recursive: true });
    writeFileSync(target, "do-not-touch", "utf8");
    symlinkSync(target, `${tokenPath}.${process.pid}.tmp`);
    const server = await startTermControlServer(localHost(), { home });
    cleanups.push(async () => {
      await server.close();
      rmSync(home, { recursive: true, force: true });
    });

    expect(readFileSync(target, "utf8")).toBe("do-not-touch");
    expect(readFileSync(tokenPath, "utf8").trim()).toBe(server.token);
  });

  it("removes no host listener when token publication rejects", async () => {
    const home = mkdtempSync(join(tmpdir(), "vt-e-"));
    const host = localHost();
    const tokenPath = termControlTokenPath(home);
    mkdirSync(tokenPath, { recursive: true });
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));

    let startupError: unknown;
    try {
      await startTermControlServer(host, { home });
    } catch (error) {
      startupError = error;
    }

    expect(startupError).toBeInstanceOf(TermControlStartupError);
    expect((startupError as TermControlStartupError).receipt.clean).toBe(true);
    expect(host.listenerCount("event")).toBe(0);
    expect(existsSync(termControlSocketPath(home))).toBe(false);
  });

  it("returns the exact listener authority when startup sees a replacement", async () => {
    const home = mkdtempSync(join(tmpdir(), "vt-x-"));
    const host = localHost();
    const socketPath = termControlSocketPath(home);
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    let startupError: unknown;

    try {
      await startTermControlServer(host, {
        home,
        shutdownGraceMs: 5,
        shutdownDeadlineMs: 20,
        chmodSocket: (path) => {
          unlinkSync(path);
          writeFileSync(path, "foreign replacement", "utf8");
        },
      });
    } catch (error) {
      startupError = error;
    }

    expect(startupError).toBeInstanceOf(TermControlStartupError);
    const retained = startupError as TermControlStartupError;
    expect(retained.receipt.clean).toBe(false);
    expect(retained.receipt.retainedCounts.listenerClosures).toBe(1);
    expect(readFileSync(socketPath, "utf8")).toBe("foreign replacement");
    expect(host.listenerCount("event")).toBe(0);

    unlinkSync(socketPath);
    await expect(retained.control.drainOnQuit()).resolves.toMatchObject({ clean: true });
  });
});
