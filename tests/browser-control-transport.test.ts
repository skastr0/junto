import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTROL_MAX_BODY_BYTES,
  CONTROL_MAX_HEADER_BYTES,
  CONTROL_TOKEN_HEADER,
  controlDir,
  controlShotsDir,
  controlSocketPath,
  controlTokenPath,
} from "../src/shared/browser-control";
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

const repoRoot = resolve(import.meta.dirname, "..");
const TEST_ROOT_PREFIX = "/tmp/vct-";
const roots: string[] = [];
const servers: BrowserControlServer[] = [];
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
): Promise<{
  readonly server: BrowserControlServer;
  readonly sessions: BrowserSessionService;
  readonly token: string;
}> => {
  const sessions = makeSessions(root);
  const server = await startBrowserControlServer(
    { sessions, resolvePageTarget, version: "transport-test", home: root },
    runtime,
  );
  servers.push(server);
  return {
    server,
    sessions,
    token: (await readFile(controlTokenPath(root), "utf8")).trim(),
  };
};

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
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> =>
  new Promise((resolveCli, rejectCli) => {
    const child = spawn("bun", [join(repoRoot, "scripts/browser-cli.ts"), ...args], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home },
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

    expect(token).toBe("existing-token");
    expect(await mode(controlDir(root))).toBe(0o700);
    expect(await mode(controlShotsDir(root))).toBe(0o700);
    expect(await mode(controlTokenPath(root))).toBe(0o600);
    expect(await mode(server.socketPath)).toBe(0o600);
  });

  it("fails startup closed when the live socket cannot be made owner-only", async () => {
    const root = await newRoot();
    const runtime: BrowserControlRuntime = {
      chmodSocket: () => {
        throw new Error("injected chmod failure");
      },
    };

    await expect(
      startBrowserControlServer(
        { sessions: makeSessions(root), resolvePageTarget, version: "transport-test", home: root },
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

  it("rejects a declared oversize body without waiting for body completion", async () => {
    const root = await newRoot();
    const { server, token, sessions } = await startStack(root);
    const response = await rawExchange(
      server.socketPath,
      [
        requestHead("POST", "/open", [
          [CONTROL_TOKEN_HEADER, token],
          ["Content-Type", "application/json"],
          ["Content-Length", String(CONTROL_MAX_BODY_BYTES + 1)],
        ]),
      ],
      false,
    );

    expect(statusOf(response)).toBe(413);
    expect(sessions.list()).toMatchObject({ ok: true, data: [] });
  });

  it("rejects a streamed oversize body before dispatch", async () => {
    const root = await newRoot();
    const { server, token, sessions } = await startStack(root);
    const chunk = Buffer.alloc(CONTROL_MAX_BODY_BYTES + 1, 0x61);
    const response = await rawExchange(server.socketPath, [
      requestHead("POST", "/open", [
        [CONTROL_TOKEN_HEADER, token],
        ["Content-Type", "application/json"],
        ["Transfer-Encoding", "chunked"],
      ]),
      `${chunk.byteLength.toString(16)}\r\n`,
      chunk,
      "\r\n0\r\n\r\n",
    ]);

    expect(statusOf(response)).toBe(413);
    expect(envelopeOf(response)).toMatchObject({ ok: false, error: { _tag: "bad_request" } });
    expect(sessions.list()).toMatchObject({ ok: true, data: [] });
  });

  it("returns a typed bad request for authenticated malformed JSON", async () => {
    const root = await newRoot();
    const { server, token } = await startStack(root);
    const response = await rawExchange(server.socketPath, [
      requestHead("POST", "/open", [
        [CONTROL_TOKEN_HEADER, token],
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

  it("keeps the installed browser CLI compatible with under-cap chunked JSON", async () => {
    const root = await newRoot();
    const { sessions } = await startStack(root);
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
    expect(sessions.state(sessionId)).toMatchObject({
      ok: true,
      data: { ref: PAGE_REF, nodeId: "cli-node" },
    });
  });
});
