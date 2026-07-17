import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTROL_CAPABILITY_ENV,
  CONTROL_CAPABILITY_HEADER,
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
  type BrowserCapabilityRegistry,
} from "../src/main/vellum/browser/capabilities";

const repoRoot = resolve(import.meta.dirname, "..");
const TEST_ROOT_PREFIX = "/tmp/vct-";
const roots: string[] = [];
const servers: BrowserControlServer[] = [];
const capabilityRegistries: BrowserCapabilityRegistry[] = [];
const rogueServers: HttpServer[] = [];
const PAGE_REF = "vellum://canvas/work?node=cli-node";
const resolvePageTarget: PageTargetResolver = async (ref) =>
  ref === PAGE_REF
    ? {
        ok: true,
        data: {
          ref: PAGE_REF,
          nodeId: "cli-node",
          url: "https://example.com/",
          profile: "personal",
        },
      }
    : { ok: false, code: "not_found", message: "page not found" };

const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

const makeSessions = (root: string): BrowserSessionService => {
  const adapter: BrowserViewAdapter = (_partition, events) => {
    const handle: BrowserViewHandle = {
      loadUrl: (url, expectedSessionId) => {
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
): Promise<{
  readonly server: BrowserControlServer;
  readonly sessions: BrowserSessionService;
  readonly capabilities: BrowserCapabilityRegistry;
  readonly token: string;
  readonly capability: string;
  readonly ownerId: string;
}> => {
  const sessions = makeSessions(root);
  const capabilities = makeBrowserCapabilityRegistry();
  capabilityRegistries.push(capabilities);
  const principal = capabilities.createPrincipal();
  const grant = capabilities.issue(principal, {
    actions: BROWSER_CAPABILITY_ACTIONS,
    targets: [{
      ref: PAGE_REF,
      profile: "personal",
      exactOrigins: ["https://example.com"],
    }],
    ttlMs: 60_000,
    maxUses: 10_000,
    maxInFlight: 32,
  });
  const server = await startBrowserControlServer(
    {
      sessions,
      capabilities,
      resolvePageTarget: resolver,
      version: "transport-test",
      home: root,
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
    ownerId: grant.ownerId,
  };
};

const capabilityHeaders = (
  token: string,
  capability: string,
): ReadonlyArray<readonly [string, string]> => [
  [CONTROL_TOKEN_HEADER, token],
  [CONTROL_CAPABILITY_HEADER, capability],
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
  for (const server of servers.splice(0)) server.close();
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

  it("rejects missing capability metadata before waiting for a protected body", async () => {
    const root = await newRoot();
    const { server, token, capability } = await startStack(root);
    const cases = [
      {
        headers: [[CONTROL_TOKEN_HEADER, token]] as const,
        status: 401,
        tag: "unauthorized",
      },
      {
        headers: [
          [CONTROL_TOKEN_HEADER, token],
          [CONTROL_CAPABILITY_HEADER, capability],
        ] as const,
        status: 400,
        tag: "bad_request",
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
      expect(statusOf(response)).toBe(testCase.status);
      expect(envelopeOf(response)).toMatchObject({
        ok: false,
        error: { _tag: testCase.tag },
      });
    }
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
    const { server, token, capability, ownerId, sessions } = await startStack(root);
    const response = await rawExchange(
      server.socketPath,
      [
        requestHead("POST", "/open", [
          ...capabilityHeaders(token, capability),
          ["Content-Type", "application/json"],
          ["Content-Length", String(CONTROL_MAX_BODY_BYTES + 1)],
        ]),
      ],
      false,
    );

    expect(statusOf(response)).toBe(413);
    expect(sessions.listForOwner(ownerId)).toMatchObject({ ok: true, data: [] });
  });

  it("rejects a streamed oversize body before dispatch", async () => {
    const root = await newRoot();
    const { server, token, capability, ownerId, sessions } = await startStack(root);
    const chunk = Buffer.alloc(CONTROL_MAX_BODY_BYTES + 1, 0x61);
    const response = await rawExchange(server.socketPath, [
      requestHead("POST", "/open", [
        ...capabilityHeaders(token, capability),
        ["Content-Type", "application/json"],
        ["Transfer-Encoding", "chunked"],
      ]),
      `${chunk.byteLength.toString(16)}\r\n`,
      chunk,
      "\r\n0\r\n\r\n",
    ]);

    expect(statusOf(response)).toBe(413);
    expect(envelopeOf(response)).toMatchObject({ ok: false, error: { _tag: "bad_request" } });
    expect(sessions.listForOwner(ownerId)).toMatchObject({ ok: true, data: [] });
  });

  it("returns a typed bad request for authenticated malformed JSON", async () => {
    const root = await newRoot();
    const { server, token, capability } = await startStack(root);
    const response = await rawExchange(server.socketPath, [
      requestHead("POST", "/open", [
        ...capabilityHeaders(token, capability),
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
    const { server, token, capability } = await startStack(root, {
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
        ...capabilityHeaders(token, capability),
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
      { chmodSocket: chmodSync, handlerTimeoutMs: 40 },
      neverResolve,
    );
    const body = JSON.stringify({ ref: PAGE_REF });
    const response = await rawExchange(timed.server.socketPath, [
      requestHead("POST", "/open", [
        ...capabilityHeaders(timed.token, timed.capability),
        ["Content-Type", "application/json"],
        ["Content-Length", String(Buffer.byteLength(body))],
      ]),
      body,
    ]);
    expect(statusOf(response)).toBe(504);
    expect(envelopeOf(response)).toMatchObject({ ok: false, error: { _tag: "timeout" } });
  });

  it("aborts an open when its authenticated client disconnects", async () => {
    const root = await newRoot();
    let releaseResolver!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolveGate) => { releaseResolver = resolveGate; });
    const started = new Promise<void>((resolveStarted) => { markStarted = resolveStarted; });
    const delayed: PageTargetResolver = async (ref) => {
      markStarted();
      await gate;
      return resolvePageTarget(ref);
    };
    const { server, token, capability, ownerId, sessions } = await startStack(root, undefined, delayed);
    const body = JSON.stringify({ ref: PAGE_REF });
    const client = createConnection(server.socketPath);
    await new Promise<void>((resolveConnect, rejectConnect) => {
      client.once("connect", resolveConnect);
      client.once("error", rejectConnect);
    });
    client.write(
      requestHead("POST", "/open", [
        ...capabilityHeaders(token, capability),
        ["Content-Type", "application/json"],
        ["Content-Length", String(Buffer.byteLength(body))],
      ]) + body,
    );
    await started;
    client.destroy();
    releaseResolver();
    await new Promise((resolveWait) => setTimeout(resolveWait, 40));
    expect(sessions.listForOwner(ownerId)).toMatchObject({ ok: true, data: [] });
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
    const { sessions, capability, ownerId } = await startStack(root);
    const result = await runCli(root, [
      "open",
      PAGE_REF,
      "--json",
    ], { [CONTROL_CAPABILITY_ENV]: capability });

    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: { ref: PAGE_REF, nodeId: "cli-node", url: "https://example.com/" },
    });
    const sessionId = (JSON.parse(result.stdout) as { data: { sessionId: string } }).data.sessionId;
    expect(sessions.stateForOwner(ownerId, sessionId)).toMatchObject({
      ok: true,
      data: { ref: PAGE_REF, nodeId: "cli-node" },
    });
  });
});
