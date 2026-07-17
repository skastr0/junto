#!/usr/bin/env bun
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Either } from "effect";
import {
  CONTROL_ROUTES,
  CONTROL_TOKEN_HEADER,
  controlSocketPath,
  controlTokenPath,
  decodeControlEnvelope,
  type ControlEnvelope,
  type ControlRouteName,
} from "../src/shared/browser-control";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = join(repoRoot, "tests/fixtures/browser/hostile-containment.html");
const electronPath = join(repoRoot, "node_modules/.bin/electron");
const mainPath = join(repoRoot, "out/main/index.js");
const STARTUP_TIMEOUT_MS = 20_000;
const PAGE_TIMEOUT_MS = 12_000;
const CONTROL_TIMEOUT_MS = 5_000;
const MAX_LOG_BYTES = 256 * 1024;
// macOS limits AF_UNIX paths to roughly 104 bytes. os.tmpdir() expands to a
// long /var/folders path, so this hermetic probe deliberately uses /tmp.
const PROBE_TEMP_PREFIX = "/tmp/vbe-";

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const appendBounded = (current: string, chunk: Buffer): string =>
  (current + chunk.toString("utf8")).slice(-MAX_LOG_BYTES);

const controlCall = (
  socketPath: string,
  token: string,
  routeName: ControlRouteName,
  body?: unknown,
): Promise<ControlEnvelope<unknown>> =>
  new Promise((resolveCall, rejectCall) => {
    const route = CONTROL_ROUTES[routeName];
    const req = request(
      {
        socketPath,
        method: route.method,
        path: route.path,
        headers: {
          "content-type": "application/json",
          [CONTROL_TOKEN_HEADER]: token,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const decoded = decodeControlEnvelope(
              JSON.parse(Buffer.concat(chunks).toString("utf8")),
            );
            if (Either.isLeft(decoded)) {
              rejectCall(new Error(decoded.left.message));
              return;
            }
            resolveCall(decoded.right);
          } catch (error) {
            rejectCall(error);
          }
        });
      },
    );
    req.setTimeout(CONTROL_TIMEOUT_MS, () => req.destroy(new Error("control request timed out")));
    req.on("error", rejectCall);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });

const requireOk = (envelope: ControlEnvelope<unknown>, operation: string): unknown => {
  if (!envelope.ok) throw new Error(`${operation}: ${envelope.error._tag}: ${envelope.error.message}`);
  return envelope.data;
};

const waitForControl = async (
  home: string,
  childExited: () => boolean,
): Promise<{ socketPath: string; token: string }> => {
  const socketPath = controlSocketPath(home);
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError = "control socket not ready";
  while (Date.now() < deadline) {
    if (childExited()) throw new Error("Electron exited before browser control became ready");
    try {
      const token = (await readFile(controlTokenPath(home), "utf8")).trim();
      if (token.length === 0) throw new Error("empty control token");
      requireOk(await controlCall(socketPath, token, "doctor"), "doctor");
      return { socketPath, token };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await delay(100);
    }
  }
  throw new Error(`browser control startup timed out: ${lastError}`);
};

const waitForReport = async (
  socketPath: string,
  token: string,
  nodeId: string,
): Promise<Record<string, unknown>> => {
  const deadline = Date.now() + PAGE_TIMEOUT_MS;
  let lastError = "page report not ready";
  while (Date.now() < deadline) {
    try {
      const data = requireOk(
        await controlCall(socketPath, token, "eval", {
          nodeId,
          code: "globalThis.__vellumContainmentProbe ?? null",
        }),
        `eval ${nodeId}`,
      );
      if (isRecord(data) && isRecord(data.result)) return data.result;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(`page probe timed out for ${nodeId}: ${lastError}`);
};

const assertContainment = (report: Record<string, unknown>): void => {
  const globals = report.globals;
  if (!isRecord(globals)) throw new Error("hostile page did not report globals");
  for (const name of ["require", "process", "Buffer", "module", "vellum", "chassis"]) {
    if (globals[name] !== "undefined") {
      throw new Error(`hostile page observed privileged global ${name}=${String(globals[name])}`);
    }
  }

  const attempts = report.writeAttempts;
  if (!Array.isArray(attempts) || attempts.length !== 2) {
    throw new Error("hostile page did not execute both marker-write attempts");
  }
  for (const attempt of attempts) {
    if (!isRecord(attempt) || attempt.succeeded !== false) {
      throw new Error("hostile page marker-write attempt unexpectedly succeeded");
    }
  }
};

const markerAbsent = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
};

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolveClose) => server.close(() => resolveClose()));

const reserveLoopbackPort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("TCP regression probe has no port");
  }
  await closeServer(server);
  return address.port;
};

const assertTcpControlAbsent = (
  port: number,
  token: string,
): Promise<void> =>
  new Promise((resolveAbsent, rejectAbsent) => {
    let settled = false;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error === undefined) resolveAbsent();
      else rejectAbsent(error);
    };
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: CONTROL_ROUTES.doctor.path,
        headers: { [CONTROL_TOKEN_HEADER]: token },
      },
      (res) => {
        res.resume();
        settle(new Error(`legacy VELLUM_CONTROL_TCP opened 127.0.0.1:${port}`));
      },
    );
    req.setTimeout(1_000, () => {
      req.destroy(new Error("TCP regression probe timed out instead of refusing"));
    });
    req.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") settle();
      else settle(error);
    });
    req.end();
  });

const stopChild = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([once(child, "exit"), delay(2_000)]);
  }
};

const main = async (): Promise<void> => {
  const root = await mkdtemp(PROBE_TEMP_PREFIX);
  const home = join(root, "home");
  const userData = join(root, "electron-user-data");
  const browserDir = join(root, "browser");
  const canvasesDir = join(root, "canvases");
  const markerPath = join(root, `host-marker-${randomUUID()}`);
  const nonce = randomUUID();
  const legacyTcpPort = await reserveLoopbackPort();
  await Promise.all([home, userData, browserDir, canvasesDir].map((path) => mkdir(path, { recursive: true })));

  const fixture = await readFile(fixturePath);
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(fixture);
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture server has no port");
  const origin = `http://127.0.0.1:${address.port}`;
  const fixtureUrl = (mode: "seed" | "read") => {
    const url = new URL(origin);
    url.searchParams.set("mode", mode);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("marker", markerPath);
    return url.toString();
  };

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    VELLUM_BROWSER_DIR: browserDir,
    VELLUM_CANVASES_DIR: canvasesDir,
    VELLUM_CONTROL_TCP: `127.0.0.1:${legacyTcpPort}`,
  };
  delete env.ELECTRON_RENDERER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;

  const child = spawn(electronPath, [mainPath, `--user-data-dir=${userData}`], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let exited = false;
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = appendBounded(stdout, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = appendBounded(stderr, chunk);
  });
  child.once("exit", () => {
    exited = true;
  });

  try {
    const { socketPath, token } = await waitForControl(home, () => exited);
    await assertTcpControlAbsent(legacyTcpPort, token);
    const open = async (nodeId: string, profile: string, url: string): Promise<void> => {
      requireOk(await controlCall(socketPath, token, "open", { nodeId, profile, url }), `open ${nodeId}`);
    };

    await open("personal-seed", "personal", fixtureUrl("seed"));
    const personalSeed = await waitForReport(socketPath, token, "personal-seed");
    assertContainment(personalSeed);
    if (personalSeed.cookieValue !== nonce || personalSeed.storageValue !== nonce) {
      throw new Error("personal profile did not persist its synthetic state");
    }
    if (!(await markerAbsent(markerPath))) throw new Error("hostile page wrote a host marker");

    await open("work-read", "work", fixtureUrl("read"));
    const workRead = await waitForReport(socketPath, token, "work-read");
    assertContainment(workRead);
    if (workRead.cookieValue !== null || workRead.storageValue !== null) {
      throw new Error("work profile observed personal profile state");
    }

    await open("filler-one", "work", fixtureUrl("read"));
    await open("filler-two", "work", fixtureUrl("read"));
    const sessions = requireOk(await controlCall(socketPath, token, "sessions"), "sessions");
    if (!Array.isArray(sessions)) throw new Error("sessions response is not an array");
    const sessionIds = sessions
      .filter(isRecord)
      .map((session) => session.nodeId)
      .filter((nodeId): nodeId is string => typeof nodeId === "string");
    if (sessionIds.includes("personal-seed")) {
      throw new Error("warm-pool pressure did not evict the original personal view");
    }

    await open("personal-restored", "personal", fixtureUrl("read"));
    const personalRestored = await waitForReport(socketPath, token, "personal-restored");
    if (personalRestored.cookieValue !== nonce || personalRestored.storageValue !== nonce) {
      throw new Error("personal partition state did not survive WebContents eviction");
    }
    if (!(await markerAbsent(markerPath))) throw new Error("hostile page wrote a host marker");

    console.log(
      JSON.stringify({
        ok: true,
        assertions: {
          privilegedGlobalsAbsent: true,
          hostWritesBlocked: true,
          profilesIsolated: true,
          partitionSurvivesEviction: true,
          tcpListenerAbsent: true,
        },
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        stdout,
        stderr,
      }),
    );
    process.exitCode = 2;
  } finally {
    await stopChild(child);
    await closeServer(server);
    if (!root.startsWith(PROBE_TEMP_PREFIX)) {
      throw new Error(`refusing unsafe probe cleanup: ${root}`);
    }
    await rm(root, { recursive: true, force: true });
  }
};

await main();
