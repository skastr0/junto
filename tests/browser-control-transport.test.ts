import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, unlinkSync, writeFileSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTROL_MAX_BODY_BYTES,
  CONTROL_MAX_HEADER_BYTES,
  CONTROL_REQUEST_ID_HEADER,
  CONTROL_TOKEN_HEADER,
  controlDir,
  controlShotsDir,
  controlSocketPath,
  controlTokenPath,
} from "../src/shared/browser-control";
import { BROWSER_CONTROL_MAX_RESPONSE_BYTES } from "../src/shared/browser-limits";
import {
  startBrowserControlServer,
  type BrowserControlRuntime,
  type BrowserControlServer,
} from "../src/main/vellum/browser/control";
import type { EdgeGrantService } from "../src/main/vellum/browser/edge-grant";
import { makeBrowserProfileService } from "../src/main/vellum/browser/profiles";
import {
  BrowserSessionService,
  type BrowserViewAdapter,
  type BrowserViewHandle,
} from "../src/main/vellum/browser/sessions";
import type { PageTargetResolver } from "../src/main/vellum/browser/page-target";
import {
  BROWSER_CAPABILITY_ACTIONS,
  makeBrowserCapabilityRegistry,
  type BrowserAutomationPrincipal,
  type BrowserCapabilityRegistry,
} from "../src/main/vellum/browser/capabilities";
import { makeProcessIdentityMap } from "../src/main/vellum/process-identity";
import { LOCAL_BROWSER_TEST_AUTHORITY } from "./browser-host-test-authority";

const repoRoot = resolve(import.meta.dirname, "..");
const TEST_ROOT_PREFIX = "/tmp/vct-";
const roots: string[] = [];
const servers: BrowserControlServer[] = [];
const capabilityRegistries: BrowserCapabilityRegistry[] = [];
const rogueServers: HttpServer[] = [];
const PAGE_REF = "vellum://canvas/work?node=cli-node";
const AGENT_KEY = "local:cli";
const deferred = <A>() => {
  let resolve!: (value: A | PromiseLike<A>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};
const resolvePageTarget: PageTargetResolver = async (ref) =>
  ref === PAGE_REF
    ? {
        ok: true,
        data: {
          ref: PAGE_REF,
          nodeId: "cli-node",
          hostId: "local",
          url: "https://example.com/",
          profile: "personal",
        },
      }
    : { ok: false, code: "not_found", message: "page not found" };

/** Transport tests: admit every socket with a pre-minted internal lease. */
const admittingEdgeGrant = (
  secret: string,
  expectedPrincipal: BrowserAutomationPrincipal,
): EdgeGrantService => ({
  processMap: makeProcessIdentityMap(),
  admitSocket: vi.fn(async () => ({
    ok: true as const,
    secret,
    expectedPrincipal,
    principal: { kind: "agent" as const, agentKey: AGENT_KEY },
    targetCount: 1,
  })),
  admitPrincipal: async () => ({
    ok: true,
    secret,
    expectedPrincipal,
    principal: { kind: "agent", agentKey: AGENT_KEY },
    targetCount: 1,
  }),
  clear: () => {},
  invalidateCanvas: () => Object.freeze([]),
  lastRevocationReceipts: () => Object.freeze([]),
});

const denyingEdgeGrant = (): EdgeGrantService => ({
  processMap: makeProcessIdentityMap(),
  admitSocket: async () => ({
    ok: false,
    denial: "process_unbound",
    message: "connecting process is not a registered agent or herdr process",
  }),
  admitPrincipal: async () => ({
    ok: false,
    denial: "process_unbound",
    message: "connecting process is not a registered agent or herdr process",
  }),
  clear: () => {},
  invalidateCanvas: () => Object.freeze([]),
  lastRevocationReceipts: () => Object.freeze([]),
});

const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

const makeSessions = (root: string): BrowserSessionService => {
  const adapter: BrowserViewAdapter = (_partition, events) => {
    const handle: BrowserViewHandle = {
      loadUrl: async (url, expectedSessionId) => {
        const sessionId = events.onNavigationStart({ url, isSameDocument: false, expectedSessionId });
        if (sessionId !== undefined) events.onLoadOk(sessionId);
      },
      attach: () => {},
      setBounds: () => {},
      detach: () => {},
      destroy: () => {},
      executeJavaScript: async () => null,
      capturePagePng: async () => new Uint8Array(),
    };
    return handle;
  };
  return new BrowserSessionService(
    adapter,
    LOCAL_BROWSER_TEST_AUTHORITY,
    makeBrowserProfileService(join(root, "profiles")),
  );
};

const newRoot = async (): Promise<string> => {
  const root = await mkdtemp(TEST_ROOT_PREFIX);
  roots.push(root);
  return root;
};

const startStack = async (
  root: string,
  runtime?: BrowserControlRuntime,
  resolver: PageTargetResolver = resolvePageTarget,
  edgeGrantMode: "admit" | "deny" | "profiles-only" | "mismatched-principal" = "admit",
): Promise<{
  readonly server: BrowserControlServer;
  readonly sessions: BrowserSessionService;
  readonly capabilities: BrowserCapabilityRegistry;
  readonly token: string;
  readonly capability: string;
  readonly auditId: string;
  readonly edgeGrant: EdgeGrantService;
}> => {
  const sessions = makeSessions(root);
  const capabilities = makeBrowserCapabilityRegistry();
  capabilityRegistries.push(capabilities);
  // Internal lease the process-bind stub returns — not a client-presented secret.
  const principal = capabilities.createPrincipal();
  const grant = capabilities.issue(principal, {
    actions: edgeGrantMode === "profiles-only" ? ["profiles"] : BROWSER_CAPABILITY_ACTIONS,
    targets: [{
      ref: PAGE_REF,
      hostId: "local",
      profile: "personal",
      exactOrigins: ["https://example.com"],
    }],
    ttlMs: 60_000,
    maxUses: 10_000,
    maxInFlight: 32,
  });
  const edgeGrant = edgeGrantMode === "deny"
    ? denyingEdgeGrant()
    : admittingEdgeGrant(
        grant.secret,
        edgeGrantMode === "mismatched-principal"
          ? capabilities.createPrincipal()
          : principal,
      );
  const server = await startBrowserControlServer(
    {
      sessions,
      capabilities,
      resolvePageTarget: resolver,
      version: "transport-test",
      home: root,
      edgeGrant,
    },
    runtime,
  );
  servers.push(server);
  return {
    server,
    sessions,
    capabilities,
    token: (await readFile(controlTokenPath(root), "utf8")).trim(),
    capability: grant.secret,
    auditId: grant.auditId,
    edgeGrant,
  };
};

/** Protected-route headers: token + request id. Capability secrets are not identity. */
const protectedHeaders = (
  token: string,
): ReadonlyArray<readonly [string, string]> => [
  [CONTROL_TOKEN_HEADER, token],
  [CONTROL_REQUEST_ID_HEADER, randomUUID()],
];

const rawExchange = (
  socketPath: string,
  writes: ReadonlyArray<string | Buffer>,
  endRequest = false,
): Promise<string> =>
  new Promise((resolveExchange, rejectExchange) => {
    const socket = createConnection(socketPath);
    let response = "";
    let settled = false;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error !== undefined) rejectExchange(error);
      else resolveExchange(response);
    };

    socket.setTimeout(3_000, () => settle(new Error("raw control exchange timed out")));
    socket.once("connect", () => {
      for (const write of writes) socket.write(write);
      if (endRequest) socket.end();
    });
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
    });
    socket.once("end", () => settle());
    socket.once("close", () => {
      if (response.length > 0) settle();
    });
    socket.once("error", (error) => {
      if (response.length > 0) settle();
      else settle(error);
    });
  });

const statusOf = (response: string): number => {
  const match = /^HTTP\/1\.1 ([0-9]{3})/.exec(response);
  if (match === null) throw new Error(`missing HTTP status in response: ${response}`);
  return Number(match[1]);
};

const envelopeOf = (response: string): unknown => {
  const split = response.indexOf("\r\n\r\n");
  if (split < 0) throw new Error(`missing HTTP body in response: ${response}`);
  return JSON.parse(response.slice(split + 4));
};

const requestHead = (
  method: string,
  path: string,
  headers: ReadonlyArray<readonly [string, string]>,
): string =>
  [
    `${method} ${path} HTTP/1.1`,
    "Host: control.local",
    ...headers.map(([name, value]) => `${name}: ${value}`),
    "",
    "",
  ].join("\r\n");

const runCli = (
  home: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> = {},
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> =>
  new Promise((resolveCli, rejectCli) => {
    const child = spawn("bun", [join(repoRoot, "scripts/browser-cli.ts"), ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectCli(new Error("browser CLI compatibility probe timed out"));
    }, 5_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectCli(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveCli({ code, stdout, stderr });
    });
  });

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const registry of capabilityRegistries.splice(0)) registry.close();
  for (const server of rogueServers.splice(0)) server.close();
  for (const root of roots.splice(0)) {
    if (!root.startsWith(TEST_ROOT_PREFIX)) {
      throw new Error(`refusing unsafe transport-test cleanup: ${root}`);
    }
    await rm(root, { recursive: true, force: true });
  }
});

describe("browser control Unix transport", () => {
  it("caps accepted peers before HTTP request admission and recovers after close", async () => {
    const root = await newRoot();
    const { server, token, edgeGrant } = await startStack(root, {
      chmodSocket: chmodSync,
      maxActiveClients: 1,
    });
    const first = createConnection(server.socketPath);
    await new Promise<void>((resolve, reject) => { first.once("connect", resolve); first.once("error", reject); });
    const excess = createConnection(server.socketPath);
    excess.on("error", () => undefined);
    excess.once("connect", () => {
      excess.write(requestHead("GET", "/profiles", protectedHeaders(token)));
    });
    await new Promise<void>((resolve) => excess.once("close", resolve));
    expect(edgeGrant.admitSocket).not.toHaveBeenCalled();
    first.destroy();
    await new Promise<void>((resolve) => first.once("close", resolve));
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const response = await rawExchange(server.socketPath, [requestHead("GET", "/doctor", [[CONTROL_TOKEN_HEADER, token]])], true);
    expect(statusOf(response)).toBe(200);
  });
  it("normalizes the control directory, token, shots, and socket to owner-only modes", async () => {
    const root = await newRoot();
    await mkdir(controlDir(root), { recursive: true, mode: 0o777 });
    await chmod(controlDir(root), 0o777);
    await writeFile(controlTokenPath(root), "existing-token\n", { mode: 0o644 });
    await chmod(controlTokenPath(root), 0o644);

    const { server, token } = await startStack(root);

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toBe("existing-token");
    expect(await readFile(controlTokenPath(root), "utf8")).toBe(`${token}\n`);
    expect(await mode(controlDir(root))).toBe(0o700);
    expect(await mode(controlShotsDir(root))).toBe(0o700);
    expect(await mode(controlTokenPath(root))).toBe(0o600);
    expect(await mode(server.socketPath)).toBe(0o600);
  });

  it("leaves the shared capability registry under caller lifecycle ownership", async () => {
    const root = await newRoot();
    const { server, capabilities } = await startStack(root);

    server.close();

    expect(capabilities.stats().closed).toBe(false);
  });

  it("idempotently closes admission and boundedly destroys accepted server sockets", async () => {
    const root = await newRoot();
    const { server } = await startStack(root, {
      chmodSocket: chmodSync,
      shutdownGraceMs: 5,
      shutdownDeadlineMs: 100,
    });
    const socket = createConnection(server.socketPath);
    await new Promise<void>((resolveConnect, rejectConnect) => {
      socket.once("connect", resolveConnect);
      socket.once("error", rejectConnect);
    });

    server.beginShutdown();
    server.beginShutdown();
    const first = server.drainOnQuit();
    expect(server.close()).toBe(first);
    await expect(first).resolves.toEqual({
      clean: true,
      rounds: expect.any(Number),
      settled: expect.any(Number),
      fulfilled: expect.any(Number),
      rejected: 0,
      retainedCounts: {
        requests: 0,
        edgeAdmissions: 0,
        dispatches: 0,
        routeOperations: 0,
        listenerClosures: 0,
        sockets: 0,
        requestControllers: 0,
        socketPaths: 0,
      },
      retainedLabels: [],
    });
    expect(socket.destroyed).toBe(true);
    await expect(access(server.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes one drain promise before edge-grant shutdown can reenter", async () => {
    const root = await newRoot();
    const capabilities = makeBrowserCapabilityRegistry();
    capabilityRegistries.push(capabilities);
    let server: BrowserControlServer | undefined;
    let reentered: Promise<unknown> | undefined;
    let clearCalls = 0;
    const edgeGrant: EdgeGrantService = {
      processMap: makeProcessIdentityMap(),
      admitSocket: async () => ({
        ok: false,
        denial: "closed",
        message: "browser control is closing",
      }),
      admitPrincipal: async () => ({
        ok: false,
        denial: "closed",
        message: "browser control is closing",
      }),
      clear: () => {
        clearCalls += 1;
        reentered = server?.drainOnQuit();
      },
      invalidateCanvas: () => Object.freeze([]),
      lastRevocationReceipts: () => Object.freeze([]),
    };
    server = await startBrowserControlServer(
      {
        sessions: makeSessions(root),
        capabilities,
        resolvePageTarget,
        version: "transport-test",
        home: root,
        edgeGrant,
      },
      {
        chmodSocket: chmodSync,
        shutdownGraceMs: 5,
        shutdownDeadlineMs: 100,
      },
    );
    servers.push(server);

    const first = server.drainOnQuit();
    expect(reentered).toBe(first);
    expect(server.close()).toBe(first);
    await expect(first).resolves.toMatchObject({ clean: true });
    expect(clearCalls).toBe(1);
  });

  it("refuses to close over a replacement Unix socket and retries after it leaves", async () => {
    const root = await newRoot();
    const { server } = await startStack(root, {
      chmodSocket: chmodSync,
      shutdownGraceMs: 5,
      shutdownDeadlineMs: 100,
    });
    unlinkSync(server.socketPath);
    const replacement = createHttpServer((_req, res) => res.end("replacement"));
    rogueServers.push(replacement);
    await new Promise<void>((resolveListen, rejectListen) => {
      replacement.once("error", rejectListen);
      replacement.listen(server.socketPath, resolveListen);
    });

    await expect(server.close()).resolves.toMatchObject({
      clean: false,
      retainedCounts: { listenerClosures: 1, socketPaths: 1 },
    });
    await expect(access(server.socketPath)).resolves.toBeUndefined();

    await new Promise<void>((resolveClose) => replacement.close(() => resolveClose()));
    rogueServers.splice(rogueServers.indexOf(replacement), 1);
    await expect(server.close()).resolves.toMatchObject({
      clean: true,
      retainedCounts: { listenerClosures: 0, socketPaths: 0 },
      retainedLabels: [],
    });
  });

  it("fails closed on an unpreservable replacement and retries after it is removed", async () => {
    const root = await newRoot();
    const { server } = await startStack(root, {
      chmodSocket: chmodSync,
      shutdownGraceMs: 5,
      shutdownDeadlineMs: 30,
    });
    unlinkSync(server.socketPath);
    await mkdir(server.socketPath);

    const refused = await server.close();
    expect(refused.clean).toBe(false);
    expect(refused.retainedCounts).toMatchObject({
      listenerClosures: 1,
      socketPaths: 1,
    });
    expect(refused.retainedLabels).toEqual(
      expect.arrayContaining(["listener", "socket-path"]),
    );

    await rm(server.socketPath, { recursive: true });
    await expect(server.close()).resolves.toMatchObject({
      clean: true,
      retainedCounts: { listenerClosures: 0, socketPaths: 0 },
      retainedLabels: [],
    });
  });

  it("retains the actual route promise after request cancellation and reports it at deadline", async () => {
    const root = await newRoot();
    const routeStarted = deferred<void>();
    const releaseRoute = deferred<void>();
    const delayedResolver: PageTargetResolver = async (ref) => {
      routeStarted.resolve();
      await releaseRoute.promise;
      return resolvePageTarget(ref);
    };
    const { server, token } = await startStack(
      root,
      {
        chmodSocket: chmodSync,
        handlerTimeoutMs: 100,
        shutdownGraceMs: 5,
        shutdownDeadlineMs: 30,
      },
      delayedResolver,
    );
    const body = JSON.stringify({ ref: PAGE_REF });
    const response = rawExchange(server.socketPath, [
      requestHead("POST", "/open", [
        ...protectedHeaders(token),
        ["Content-Type", "application/json"],
        ["Content-Length", String(Buffer.byteLength(body))],
      ]),
      body,
    ]).catch(() => "");
    await routeStarted.promise;

    server.beginShutdown();
    const receipt = await server.drainOnQuit();
    expect(receipt.clean).toBe(false);
    expect(receipt.retainedCounts).toMatchObject({
      routeOperations: 1,
      edgeAdmissions: 0,
      sockets: 0,
    });
    expect(receipt.retainedLabels).toContain("route:open");
    expect(receipt.retainedLabels).not.toContain("request");

    releaseRoute.resolve();
    await response;
    await expect(server.close()).resolves.toMatchObject({
      clean: true,
      retainedLabels: [],
    });
  });

  it("keeps the shutdown deadline bounded when the wall clock moves backward", async () => {
    const root = await newRoot();
    const routeStarted = deferred<void>();
    const releaseRoute = deferred<void>();
    const delayedResolver: PageTargetResolver = async (ref) => {
      routeStarted.resolve();
      await releaseRoute.promise;
      return resolvePageTarget(ref);
    };
    const { server, token } = await startStack(
      root,
      {
        chmodSocket: chmodSync,
        handlerTimeoutMs: 100,
        shutdownGraceMs: 5,
        shutdownDeadlineMs: 30,
      },
      delayedResolver,
    );
    const body = JSON.stringify({ ref: PAGE_REF });
    const response = rawExchange(server.socketPath, [
      requestHead("POST", "/open", [
        ...protectedHeaders(token),
        ["Content-Type", "application/json"],
        ["Content-Length", String(Buffer.byteLength(body))],
      ]),
      body,
    ]).catch(() => "");
    await routeStarted.promise;

    let wallClock = 1_000_000;
    const wallClockSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      wallClock -= 60_000;
      return wallClock;
    });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const receipt = await Promise.race([
        server.close(),
        new Promise<never>((_resolve, reject) => {
          watchdog = setTimeout(
            () => reject(new Error("browser control drain exceeded its bounded deadline")),
            250,
          );
        }),
      ]);
      expect(receipt).toMatchObject({
        clean: false,
        retainedCounts: { routeOperations: 1 },
      });
      expect(receipt.retainedLabels).toContain("route:open");
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog);
      wallClockSpy.mockRestore();
      releaseRoute.resolve();
    }
    await response;
    await expect(server.close()).resolves.toMatchObject({ clean: true });
  });

  it("tracks in-flight edge admission, refuses late peers, and never signals their pid", async () => {
    const root = await newRoot();
    const capabilities = makeBrowserCapabilityRegistry();
    capabilityRegistries.push(capabilities);
    const edgeStarted = deferred<void>();
    const edgeResult = deferred<Awaited<ReturnType<EdgeGrantService["admitSocket"]>>>();
    let admissionCalls = 0;
    let clearCalls = 0;
    const edgeGrant: EdgeGrantService = {
      processMap: makeProcessIdentityMap(),
      admitSocket: async () => {
        admissionCalls += 1;
        edgeStarted.resolve();
        return edgeResult.promise;
      },
      admitPrincipal: async () => ({
        ok: false,
        denial: "closed",
        message: "browser control is closing",
      }),
      clear: () => {
        clearCalls += 1;
      },
      invalidateCanvas: () => Object.freeze([]),
      lastRevocationReceipts: () => Object.freeze([]),
    };
    const server = await startBrowserControlServer(
      {
        sessions: makeSessions(root),
        capabilities,
        resolvePageTarget,
        version: "transport-test",
        home: root,
        edgeGrant,
      },
      {
        chmodSocket: chmodSync,
        shutdownGraceMs: 5,
        shutdownDeadlineMs: 30,
      },
    );
    servers.push(server);
    const token = (await readFile(controlTokenPath(root), "utf8")).trim();
    const body = JSON.stringify({ ref: PAGE_REF });
    const response = rawExchange(server.socketPath, [
      requestHead("POST", "/open", [
        ...protectedHeaders(token),
        ["Content-Type", "application/json"],
        ["Content-Length", String(Buffer.byteLength(body))],
      ]),
      body,
    ]).catch(() => "");
    await edgeStarted.promise;
    const alreadyAccepted = createConnection(server.socketPath);
    alreadyAccepted.on("error", () => undefined);
    await new Promise<void>((resolveConnect, rejectConnect) => {
      alreadyAccepted.once("connect", resolveConnect);
      alreadyAccepted.once("error", rejectConnect);
    });
    const processKill = vi.spyOn(process, "kill");
    try {
      server.beginShutdown();
      alreadyAccepted.write(
        requestHead("POST", "/open", [
          ...protectedHeaders(token),
          ["Content-Type", "application/json"],
          ["Content-Length", String(Buffer.byteLength(body))],
        ]) + body,
      );
      const latePeer = await new Promise<"connected" | "refused">((resolveLate) => {
        const socket = createConnection(server.socketPath);
        socket.once("connect", () => {
          socket.destroy();
          resolveLate("connected");
        });
        socket.once("error", () => resolveLate("refused"));
      });
      expect(latePeer).toBe("refused");
      const receipt = await server.drainOnQuit();
      expect(receipt.clean).toBe(false);
      expect(receipt.retainedCounts).toMatchObject({
        requests: 1,
        edgeAdmissions: 1,
        routeOperations: 0,
      });
      expect(receipt.retainedLabels).toEqual(
        expect.arrayContaining(["edge-admission", "request", "request-controller"]),
      );
      expect(admissionCalls).toBe(1);
      expect(clearCalls).toBeGreaterThanOrEqual(1);
      expect(processKill).not.toHaveBeenCalled();

      edgeResult.resolve({
        ok: false,
        denial: "closed",
        message: "browser control is closing",
      });
      await response;
      await expect(server.close()).resolves.toMatchObject({ clean: true });
    } finally {
      processKill.mockRestore();
    }
  });

  it("fails startup closed when the live socket cannot be made owner-only", async () => {
    const root = await newRoot();
    const capabilities = makeBrowserCapabilityRegistry();
    capabilityRegistries.push(capabilities);
    const runtime: BrowserControlRuntime = {
      chmodSocket: () => {
        throw new Error("injected chmod failure");
      },
    };

    await expect(
      startBrowserControlServer(
        {
          sessions: makeSessions(root),
          capabilities,
          resolvePageTarget,
          version: "transport-test",
          home: root,
        },
        runtime,
      ),
    ).rejects.toThrow("injected chmod failure");
    await expect(access(controlSocketPath(root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not unlink a replacement path when permission hardening fails", async () => {
    const root = await newRoot();
    const capabilities = makeBrowserCapabilityRegistry();
    capabilityRegistries.push(capabilities);
    const replacement = "replacement sentinel\n";
    const runtime: BrowserControlRuntime = {
      chmodSocket: (path) => {
        unlinkSync(path);
        writeFileSync(path, replacement, { mode: 0o600 });
        throw new Error("injected chmod replacement failure");
      },
      shutdownDeadlineMs: 30,
    };

    await expect(
      startBrowserControlServer(
        {
          sessions: makeSessions(root),
          capabilities,
          resolvePageTarget,
          version: "transport-test",
          home: root,
        },
        runtime,
      ),
    ).rejects.toThrow("injected chmod replacement failure");
    await expect(readFile(controlSocketPath(root), "utf8")).resolves.toBe(replacement);
  });

  it("authenticates before waiting for or parsing a request body", async () => {
    const root = await newRoot();
    const { server } = await startStack(root);
    const started = Date.now();
    const response = await rawExchange(
      server.socketPath,
      [
        requestHead("POST", "/open", [
          ["Content-Type", "application/json"],
          ["Content-Length", "100"],
        ]),
        "{",
      ],
      false,
    );

    expect(Date.now() - started).toBeLessThan(3_000);
    expect(statusOf(response)).toBe(401);
    expect(envelopeOf(response)).toMatchObject({
      ok: false,
      error: { _tag: "unauthorized" },
    });
  });

  it("process-binds protected routes before validating request ids or waiting for a body", async () => {
    const root = await newRoot();
    // Missing or malformed request metadata must not disclose protected-route
    // validation details until the connecting process itself is admitted.
    const { server, token } = await startStack(root, undefined, resolvePageTarget, "deny");
    const tokenOnly = await rawExchange(server.socketPath, [
      requestHead("GET", "/profiles", [[CONTROL_TOKEN_HEADER, token]]),
    ]);
    expect(statusOf(tokenOnly)).toBe(401);
    expect(envelopeOf(tokenOnly)).toEqual({
      ok: false,
      error: {
        _tag: "unauthorized",
        message: "connecting process is not a registered agent or herdr process",
      },
    });

    const cases = [
      {
        headers: [[CONTROL_TOKEN_HEADER, token]] as const,
      },
      {
        headers: [
          [CONTROL_TOKEN_HEADER, token],
          [CONTROL_REQUEST_ID_HEADER, "not-a-request-id"],
        ] as const,
      },
      {
        headers: [
          [CONTROL_TOKEN_HEADER, token],
          [CONTROL_REQUEST_ID_HEADER, randomUUID()],
        ] as const,
      },
    ];
    for (const testCase of cases) {
      const started = Date.now();
      const response = await rawExchange(
        server.socketPath,
        [
          requestHead("POST", "/open", [
            ...testCase.headers,
            ["Content-Type", "application/json"],
            ["Content-Length", "100"],
          ]),
          "{",
        ],
        false,
      );
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(statusOf(response)).toBe(401);
      expect(envelopeOf(response)).toEqual({
        ok: false,
        error: {
          _tag: "unauthorized",
          message: "connecting process is not a registered agent or herdr process",
        },
      });
    }

    // Once process identity is admitted, malformed request metadata is safe to
    // report as a bad request, still without waiting for the declared body.
    const admittedRoot = await newRoot();
    const admitted = await startStack(admittedRoot);
    const response = await rawExchange(
      admitted.server.socketPath,
      [
        requestHead("POST", "/open", [
          [CONTROL_TOKEN_HEADER, admitted.token],
          ["Content-Type", "application/json"],
          ["Content-Length", "100"],
        ]),
        "{",
      ],
      false,
    );
    expect(statusOf(response)).toBe(400);
    expect(envelopeOf(response)).toMatchObject({
      ok: false,
      error: { _tag: "bad_request", message: "invalid request id" },
    });

    // Edge admission alone is insufficient: action authorization also
    // outranks protected-route request metadata validation.
    const scopedRoot = await newRoot();
    const scoped = await startStack(
      scopedRoot,
      undefined,
      resolvePageTarget,
      "profiles-only",
    );
    const forbidden = await rawExchange(
      scoped.server.socketPath,
      [
        requestHead("POST", "/open", [
          [CONTROL_TOKEN_HEADER, scoped.token],
          ["Content-Type", "application/json"],
          ["Content-Length", "100"],
        ]),
        "{",
      ],
      false,
    );
    expect(statusOf(forbidden)).toBe(403);
    expect(envelopeOf(forbidden)).toMatchObject({
      ok: false,
      error: { _tag: "forbidden" },
    });

    // The opaque secret and its registry principal are one admission value.
    // A mixed pair is rejected before request-id or body validation.
    const mismatchedRoot = await newRoot();
    const mismatched = await startStack(
      mismatchedRoot,
      undefined,
      resolvePageTarget,
      "mismatched-principal",
    );
    const principalMismatch = await rawExchange(
      mismatched.server.socketPath,
      [
        requestHead("POST", "/open", [
          [CONTROL_TOKEN_HEADER, mismatched.token],
          ["Content-Type", "application/json"],
          ["Content-Length", "100"],
        ]),
        "{",
      ],
      false,
    );
    expect(statusOf(principalMismatch)).toBe(403);
    expect(envelopeOf(principalMismatch)).toMatchObject({
      ok: false,
      error: { _tag: "forbidden" },
    });
  });

  it("keeps doctor token-only and rejects non-origin-form or decorated targets", async () => {
    const root = await newRoot();
    const { server, token } = await startStack(root);
    const doctor = await rawExchange(server.socketPath, [
      requestHead("GET", "/doctor", [[CONTROL_TOKEN_HEADER, token]]),
    ], true);
    expect(statusOf(doctor)).toBe(200);

    for (const target of [
      "http://control.local/doctor",
      "//doctor",
      "/doctor?verbose=1",
      "/doctor#fragment",
      "*",
    ]) {
      const response = await rawExchange(server.socketPath, [
        requestHead("GET", target, [[CONTROL_TOKEN_HEADER, token]]),
      ]).catch((error: unknown) => {
        throw new Error(
          `request-target probe failed for ${JSON.stringify(target)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      expect(statusOf(response)).toBe(400);
      expect(envelopeOf(response)).toMatchObject({
        ok: false,
        error: { _tag: "bad_request" },
      });
    }

    const normalizedAlias = await rawExchange(server.socketPath, [
      requestHead("GET", "/nested/../doctor", [[CONTROL_TOKEN_HEADER, token]]),
    ]);
    expect(statusOf(normalizedAlias)).toBe(404);

    const sentinel = Buffer.alloc(32, 0xd7).toString("base64url");
    const unknown = await rawExchange(server.socketPath, [
      requestHead("GET", `/missing/${sentinel}`, [[CONTROL_TOKEN_HEADER, token]]),
    ]);
    expect(statusOf(unknown)).toBe(404);
    expect(envelopeOf(unknown)).toEqual({
      ok: false,
      error: { _tag: "bad_request", message: "unknown route" },
    });
    expect(unknown).not.toContain(sentinel);
  });

  it("accepts the fixed transport header only, never generic Authorization", async () => {
    const root = await newRoot();
    const { server, token } = await startStack(root);
    const response = await rawExchange(server.socketPath, [
      requestHead("GET", "/doctor", [["Authorization", `Bearer ${token}`]]),
    ]);

    expect(statusOf(response)).toBe(401);
    expect(envelopeOf(response)).toMatchObject({
      ok: false,
      error: { _tag: "unauthorized" },
    });
  });

  it("rejects a declared oversize body without waiting for body completion", async () => {
    const root = await newRoot();
    const { server, token, auditId, sessions } = await startStack(root);
    const response = await rawExchange(
      server.socketPath,
      [
        requestHead("POST", "/open", [
          ...protectedHeaders(token),
          ["Content-Type", "application/json"],
          ["Content-Length", String(CONTROL_MAX_BODY_BYTES + 1)],
        ]),
      ],
      false,
    );

    expect(statusOf(response)).toBe(413);
    expect(sessions.listForOwner(auditId)).toMatchObject({ ok: true, data: [] });
  });

  it("rejects a streamed oversize body before dispatch", async () => {
    const root = await newRoot();
    const { server, token, auditId, sessions } = await startStack(root);
    const chunk = Buffer.alloc(CONTROL_MAX_BODY_BYTES + 1, 0x61);
    const response = await rawExchange(server.socketPath, [
      requestHead("POST", "/open", [
        ...protectedHeaders(token),
        ["Content-Type", "application/json"],
        ["Transfer-Encoding", "chunked"],
      ]),
      `${chunk.byteLength.toString(16)}\r\n`,
      chunk,
      "\r\n0\r\n\r\n",
    ]);

    expect(statusOf(response)).toBe(413);
    expect(envelopeOf(response)).toMatchObject({ ok: false, error: { _tag: "bad_request" } });
    expect(sessions.listForOwner(auditId)).toMatchObject({ ok: true, data: [] });
  });

  it("returns a typed bad request for authenticated malformed JSON", async () => {
    const root = await newRoot();
    const { server, token } = await startStack(root);
    const response = await rawExchange(server.socketPath, [
      requestHead("POST", "/open", [
        ...protectedHeaders(token),
        ["Content-Type", "application/json"],
        ["Content-Length", "1"],
      ]),
      "{",
    ]);

    expect(statusOf(response)).toBe(400);
    expect(envelopeOf(response)).toMatchObject({ ok: false, error: { _tag: "bad_request" } });
  });

  it("bounds the HTTP header parser", async () => {
    const root = await newRoot();
    const { server } = await startStack(root);
    const response = await rawExchange(server.socketPath, [
      requestHead("GET", "/doctor", [["X-Oversize", "x".repeat(CONTROL_MAX_HEADER_BYTES)]]),
    ]);

    expect(statusOf(response)).toBe(431);
    expect(envelopeOf(response)).toMatchObject({ ok: false, error: { _tag: "bad_request" } });
  });

  it("bounds active handlers and the whole handler deadline", async () => {
    const root = await newRoot();
    const { server, token } = await startStack(root, {
      chmodSocket: chmodSync,
      maxActiveHandlers: 1,
      handlerTimeoutMs: 80,
    });
    const held = createConnection(server.socketPath);
    await new Promise<void>((resolveConnect, rejectConnect) => {
      held.once("connect", resolveConnect);
      held.once("error", rejectConnect);
    });
    held.write(
      requestHead("POST", "/open", [
        ...protectedHeaders(token),
        ["Content-Type", "application/json"],
        ["Content-Length", "100"],
      ]) + "{",
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    const exhausted = await rawExchange(server.socketPath, [
      requestHead("GET", "/doctor", [[CONTROL_TOKEN_HEADER, token]]),
    ]);
    expect(statusOf(exhausted)).toBe(429);
    expect(envelopeOf(exhausted)).toMatchObject({
      ok: false,
      error: { _tag: "resource_exhausted" },
    });
    held.destroy();

    const deadlineRoot = await newRoot();
    const neverResolve: PageTargetResolver = async () => new Promise(() => {});
    const timed = await startStack(
      deadlineRoot,
      {
        chmodSocket: chmodSync,
        maxActiveHandlers: 1,
        handlerTimeoutMs: 40,
        shutdownGraceMs: 5,
        shutdownDeadlineMs: 30,
      },
      neverResolve,
    );
    const body = JSON.stringify({ ref: PAGE_REF });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await rawExchange(timed.server.socketPath, [
        requestHead("POST", "/open", [
          ...protectedHeaders(timed.token),
          ["Content-Type", "application/json"],
          ["Content-Length", String(Buffer.byteLength(body))],
        ]),
        body,
      ]);
      expect(statusOf(response)).toBe(504);
      expect(envelopeOf(response)).toMatchObject({
        ok: false,
        error: { _tag: "timeout" },
      });
      expect(timed.capabilities.stats().activeLeases).toBe(0);

      const doctor = await rawExchange(timed.server.socketPath, [
        requestHead("GET", "/doctor", [[CONTROL_TOKEN_HEADER, timed.token]]),
      ], true);
      expect(statusOf(doctor)).toBe(200);
    }
  });

  it("releases handler admission exactly once when a timed operation settles late", async () => {
    const root = await newRoot();
    let releaseResolver!: () => void;
    const resolverGate = new Promise<void>((resolveGate) => {
      releaseResolver = resolveGate;
    });
    const delayedResolver: PageTargetResolver = async (ref) => {
      await resolverGate;
      return resolvePageTarget(ref);
    };
    const timed = await startStack(
      root,
      { chmodSocket: chmodSync, maxActiveHandlers: 1, handlerTimeoutMs: 40 },
      delayedResolver,
    );
    const body = JSON.stringify({ ref: PAGE_REF });
    const response = await rawExchange(timed.server.socketPath, [
      requestHead("POST", "/open", [
        ...protectedHeaders(timed.token),
        ["Content-Type", "application/json"],
        ["Content-Length", String(Buffer.byteLength(body))],
      ]),
      body,
    ]);
    expect(statusOf(response)).toBe(504);
    expect(timed.capabilities.stats().activeLeases).toBe(0);

    releaseResolver();
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));

    const held = createConnection(timed.server.socketPath);
    await new Promise<void>((resolveConnect, rejectConnect) => {
      held.once("connect", resolveConnect);
      held.once("error", rejectConnect);
    });
    held.write(
      requestHead("POST", "/open", [
        ...protectedHeaders(timed.token),
        ["Content-Type", "application/json"],
        ["Content-Length", "100"],
      ]) + "{",
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    const exhausted = await rawExchange(timed.server.socketPath, [
      requestHead("GET", "/doctor", [[CONTROL_TOKEN_HEADER, timed.token]]),
    ]);
    expect(statusOf(exhausted)).toBe(429);
    held.destroy();
  });

  it("aborts an open when its authenticated client disconnects", async () => {
    const root = await newRoot();
    let releaseResolver!: () => void;
    let markStarted!: () => void;
    let markResolverSettled!: () => void;
    const gate = new Promise<void>((resolveGate) => { releaseResolver = resolveGate; });
    const started = new Promise<void>((resolveStarted) => { markStarted = resolveStarted; });
    const resolverSettled = new Promise<void>((resolveSettled) => {
      markResolverSettled = resolveSettled;
    });
    const delayed: PageTargetResolver = async (ref) => {
      markStarted();
      await gate;
      try {
        return await resolvePageTarget(ref);
      } finally {
        markResolverSettled();
      }
    };
    const { server, token, auditId, sessions, capabilities } = await startStack(
      root,
      undefined,
      delayed,
    );
    const body = JSON.stringify({ ref: PAGE_REF });
    const client = createConnection(server.socketPath);
    await new Promise<void>((resolveConnect, rejectConnect) => {
      client.once("connect", resolveConnect);
      client.once("error", rejectConnect);
    });
    client.write(
      requestHead("POST", "/open", [
        ...protectedHeaders(token),
        ["Content-Type", "application/json"],
        ["Content-Length", String(Buffer.byteLength(body))],
      ]) + body,
    );
    await started;
    expect(capabilities.stats().activeLeases).toBe(1);
    client.destroy();
    await vi.waitFor(
      () => expect(capabilities.stats().activeLeases).toBe(0),
      { timeout: 3_000, interval: 5 },
    );
    expect(capabilities.auditSnapshot()).toContainEqual(expect.objectContaining({
      auditId,
      kind: "completion",
      outcome: "cancelled",
      action: "open",
    }));
    releaseResolver();
    await resolverSettled;
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    expect(sessions.listForOwner(auditId)).toMatchObject({ ok: true, data: [] });
    await expect(access(join(root, "profiles"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds CLI response admission/accumulation and its wall-clock deadline", async () => {
    const root = await newRoot();
    await mkdir(controlDir(root), { recursive: true });
    await writeFile(controlTokenPath(root), "rogue-token\n", { mode: 0o600 });

    const declared = createHttpServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(BROWSER_CONTROL_MAX_RESPONSE_BYTES + 1),
      });
      res.end("{}");
    });
    rogueServers.push(declared);
    await new Promise<void>((resolveListen, rejectListen) => {
      declared.once("error", rejectListen);
      declared.listen(controlSocketPath(root), resolveListen);
    });
    const declaredResult = await runCli(root, ["doctor", "--json"]);
    expect(declaredResult.code).toBe(1);
    expect(JSON.parse(declaredResult.stdout)).toMatchObject({
      ok: false,
      error: { _tag: "result_too_large" },
    });
    await new Promise<void>((resolveClose) => declared.close(() => resolveClose()));
    rogueServers.splice(rogueServers.indexOf(declared), 1);

    const streamed = createHttpServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(Buffer.alloc(BROWSER_CONTROL_MAX_RESPONSE_BYTES + 1, 0x61));
    });
    rogueServers.push(streamed);
    await new Promise<void>((resolveListen, rejectListen) => {
      streamed.once("error", rejectListen);
      streamed.listen(controlSocketPath(root), resolveListen);
    });
    const streamedResult = await runCli(root, ["doctor", "--json"]);
    expect(streamedResult.code).toBe(1);
    expect(JSON.parse(streamedResult.stdout)).toMatchObject({
      ok: false,
      error: { _tag: "result_too_large" },
    });
    await new Promise<void>((resolveClose) => streamed.close(() => resolveClose()));
    rogueServers.splice(rogueServers.indexOf(streamed), 1);

    const hanging = createHttpServer(() => {});
    rogueServers.push(hanging);
    await new Promise<void>((resolveListen, rejectListen) => {
      hanging.once("error", rejectListen);
      hanging.listen(controlSocketPath(root), resolveListen);
    });
    const timedOut = await runCli(
      root,
      ["doctor", "--json"],
      { VELLUM_BROWSER_REQUEST_TIMEOUT_MS: "30" },
    );
    expect(timedOut.code).toBe(1);
    expect(JSON.parse(timedOut.stdout)).toMatchObject({
      ok: false,
      error: { _tag: "timeout" },
    });
  });

  it("types a premature CLI response close and removes the public screenshot path", async () => {
    const root = await newRoot();
    await mkdir(controlDir(root), { recursive: true });
    await writeFile(controlTokenPath(root), "rogue-token\n", { mode: 0o600 });
    const reset = createHttpServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": "100" });
      res.write("{");
      res.socket?.destroy();
    });
    rogueServers.push(reset);
    await new Promise<void>((resolveListen, rejectListen) => {
      reset.once("error", rejectListen);
      reset.listen(controlSocketPath(root), resolveListen);
    });
    const resetResult = await runCli(root, ["doctor", "--json"]);
    expect(resetResult.code).toBe(1);
    expect(JSON.parse(resetResult.stdout)).toMatchObject({ ok: false, error: { _tag: "failed" } });
    await new Promise<void>((resolveClose) => reset.close(() => resolveClose()));
    rogueServers.splice(rogueServers.indexOf(reset), 1);

    const pathResult = await runCli(root, ["shot", "session-1", "--path", "/tmp/x.png"]);
    expect(pathResult.code).toBe(2);
    expect(pathResult.stderr).toContain("does not accept --path");
  });

  it("keeps the installed browser CLI compatible with under-cap chunked JSON", async () => {
    const root = await newRoot();
    // CLI is process-bind only — no capability env. Stub edge-grant admits the child.
    const { sessions, auditId } = await startStack(root);
    const result = await runCli(root, [
      "open",
      PAGE_REF,
      "--json",
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: { ref: PAGE_REF, nodeId: "cli-node", url: "https://example.com/" },
    });
    const sessionId = (JSON.parse(result.stdout) as { data: { sessionId: string } }).data.sessionId;
    expect(sessions.stateForOwner(auditId, sessionId)).toMatchObject({
      ok: true,
      data: { ref: PAGE_REF, nodeId: "cli-node" },
    });
  });
});
