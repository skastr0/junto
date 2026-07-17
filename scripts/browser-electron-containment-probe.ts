#!/usr/bin/env bun
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Either } from "effect";
import {
  CONTROL_CAPABILITY_HEADER,
  CONTROL_REQUEST_ID_HEADER,
  CONTROL_ROUTES,
  CONTROL_TOKEN_HEADER,
  controlSocketPath,
  controlTokenPath,
  decodeControlEnvelope,
  type ControlEnvelope,
  type ControlRouteName,
} from "../src/shared/browser-control";
import { BROWSER_EVAL_TIMEOUT_MS } from "../src/shared/browser-limits";
import { formatNodeRef } from "../src/shared/node-ref";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = join(repoRoot, "tests/fixtures/browser/hostile-containment.html");
const testMainEntryPath = join(
  repoRoot,
  "tests/fixtures/browser/electron-containment-main.ts",
);
const electronPath = join(repoRoot, "node_modules/.bin/electron");
const STARTUP_TIMEOUT_MS = 20_000;
const PAGE_TIMEOUT_MS = 12_000;
const CONTROL_TIMEOUT_MS = 5_000;
const EVAL_INVALIDATION_TIMEOUT_MS = BROWSER_EVAL_TIMEOUT_MS + 10_000;
const PROBE_RUNTIME_TIMEOUT_MS = 90_000;
const MAX_LOG_BYTES = 256 * 1024;
let probeStage = "setup";
let activeProbeChild: ChildProcess | undefined;
let activeProbeServer: Server | undefined;
let activeSentinelServer: Server | undefined;
let activeProbeRoot: string | undefined;
const observedControlResponseJson: string[] = [];
// macOS limits AF_UNIX paths to roughly 104 bytes. os.tmpdir() expands to a
// long /var/folders path, so this hermetic probe deliberately uses /tmp.
const PROBE_TEMP_PREFIX = "/tmp/vbe-";

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface ProbeAudit {
  readonly baselineWebContents: number;
  readonly currentWebContents: number;
  readonly maximumWebContents: number;
  readonly browserWindows: number;
  readonly createdWebContents: ReadonlyArray<{
    readonly id: number;
    readonly type: string;
  }>;
  readonly externalProtocolDispatches: ReadonlyArray<string>;
  readonly capabilityRevoked: boolean;
  readonly ready: boolean;
}

const decodeProbeAudit = (value: unknown): ProbeAudit => {
  if (
    !isRecord(value) ||
    typeof value.baselineWebContents !== "number" ||
    typeof value.currentWebContents !== "number" ||
    typeof value.maximumWebContents !== "number" ||
    typeof value.browserWindows !== "number" ||
    !Array.isArray(value.createdWebContents) ||
    !Array.isArray(value.externalProtocolDispatches) ||
    typeof value.capabilityRevoked !== "boolean" ||
    typeof value.ready !== "boolean"
  ) {
    throw new Error("dedicated Electron probe emitted a malformed audit");
  }
  const createdWebContents = value.createdWebContents.map((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "number" || typeof entry.type !== "string") {
      throw new Error("dedicated Electron probe emitted a malformed WebContents audit");
    }
    return { id: entry.id, type: entry.type };
  });
  if (value.externalProtocolDispatches.some((entry) => typeof entry !== "string")) {
    throw new Error("dedicated Electron probe emitted a malformed protocol audit");
  }
  return {
    baselineWebContents: value.baselineWebContents,
    currentWebContents: value.currentWebContents,
    maximumWebContents: value.maximumWebContents,
    browserWindows: value.browserWindows,
    createdWebContents,
    externalProtocolDispatches: value.externalProtocolDispatches as string[],
    capabilityRevoked: value.capabilityRevoked,
    ready: value.ready,
  };
};

interface CapabilityHandoff {
  readonly version: 1;
  readonly capability: string;
  readonly unrelatedCapability: string;
  readonly siblingCapability: string;
}

const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const decodeCapabilityHandoff = (value: unknown): CapabilityHandoff => {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.capability !== "string" ||
    typeof value.unrelatedCapability !== "string" ||
    typeof value.siblingCapability !== "string" ||
    !CAPABILITY_PATTERN.test(value.capability) ||
    !CAPABILITY_PATTERN.test(value.unrelatedCapability) ||
    !CAPABILITY_PATTERN.test(value.siblingCapability) ||
    new Set([
      value.capability,
      value.unrelatedCapability,
      value.siblingCapability,
    ]).size !== 3
  ) {
    throw new Error("dedicated Electron probe emitted a malformed capability handoff");
  }
  return {
    version: 1,
    capability: value.capability,
    unrelatedCapability: value.unrelatedCapability,
    siblingCapability: value.siblingCapability,
  };
};

const waitForCapabilityHandoff = async (
  path: string,
  childExited: () => boolean,
): Promise<CapabilityHandoff> => {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError = "capability handoff not ready";
  while (Date.now() < deadline) {
    if (childExited()) throw new Error("Electron exited before capability handoff became ready");
    try {
      const [metadata, encoded] = await Promise.all([stat(path), readFile(path, "utf8")]);
      try {
        if ((metadata.mode & 0o777) !== 0o600 || !metadata.isFile()) {
          throw new Error("capability handoff is not an owner-only regular file");
        }
        return decodeCapabilityHandoff(JSON.parse(encoded));
      } finally {
        await unlink(path);
      }
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(50);
  }
  throw new Error(`capability handoff timed out: ${lastError}`);
};

const waitForAudit = async (
  path: string,
  predicate: (audit: ProbeAudit) => boolean,
): Promise<ProbeAudit> => {
  const deadline = Date.now() + PAGE_TIMEOUT_MS;
  let lastError = "audit not ready";
  while (Date.now() < deadline) {
    try {
      const audit = decodeProbeAudit(JSON.parse(await readFile(path, "utf8")));
      if (predicate(audit)) return audit;
      lastError = `audit predicate not yet satisfied (${JSON.stringify(audit)})`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(50);
  }
  throw new Error(`Electron probe audit timed out: ${lastError}`);
};

const buildDedicatedElectronEntry = async (root: string): Promise<string> => {
  const outputName = "electron-containment-main.mjs";
  const outputPath = join(root, outputName);
  const build = spawn(process.execPath, [
    "build",
    testMainEntryPath,
    "--target=node",
    "--format=esm",
    "--external=electron",
    `--outfile=${outputPath}`,
    "--sourcemap=none",
  ], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  build.stdout.on("data", (chunk: Buffer) => {
    stdout = appendBounded(stdout, chunk);
  });
  build.stderr.on("data", (chunk: Buffer) => {
    stderr = appendBounded(stderr, chunk);
  });
  const [exitCode, signal] = await once(build, "exit") as [number | null, NodeJS.Signals | null];
  if (exitCode !== 0) {
    throw new Error(
      `dedicated Electron entry build failed (${String(exitCode ?? signal)}): ${stderr || stdout}`,
    );
  }
  await access(outputPath);
  return outputPath;
};

const appendBounded = (current: string, chunk: Buffer): string =>
  (current + chunk.toString("utf8")).slice(-MAX_LOG_BYTES);

interface ControlCallOptions {
  readonly capability?: string;
  readonly timeoutMs?: number;
}

const controlCall = (
  socketPath: string,
  token: string,
  routeName: ControlRouteName,
  body?: unknown,
  options: ControlCallOptions = {},
): Promise<ControlEnvelope<unknown>> =>
  new Promise((resolveCall, rejectCall) => {
    const route = CONTROL_ROUTES[routeName];
    const timeoutMs = options.timeoutMs ?? CONTROL_TIMEOUT_MS;
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const settle = (result: { readonly value: ControlEnvelope<unknown> } | { readonly error: unknown }): void => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      if ("value" in result) resolveCall(result.value);
      else rejectCall(result.error);
    };
    const req = request(
      {
        socketPath,
        method: route.method,
        path: route.path,
        headers: {
          "content-type": "application/json",
          [CONTROL_TOKEN_HEADER]: token,
          ...(options.capability === undefined
            ? {}
            : {
                [CONTROL_CAPABILITY_HEADER]: options.capability,
                [CONTROL_REQUEST_ID_HEADER]: randomUUID(),
              }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const encoded = Buffer.concat(chunks).toString("utf8");
            observedControlResponseJson.push(encoded);
            const decoded = decodeControlEnvelope(
              JSON.parse(encoded),
            );
            if (Either.isLeft(decoded)) {
              settle({ error: new Error(decoded.left.message) });
              return;
            }
            settle({ value: decoded.right });
          } catch (error) {
            settle({ error });
          }
        });
      },
    );
    deadline = setTimeout(() => {
      const error = new Error("control request timed out");
      req.destroy(error);
      settle({ error });
    }, timeoutMs);
    req.on("error", (error) => settle({ error }));
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });

const requireOk = (envelope: ControlEnvelope<unknown>, operation: string): unknown => {
  if (!envelope.ok) throw new Error(`${operation}: ${envelope.error._tag}: ${envelope.error.message}`);
  return envelope.data;
};

const requireDenied = (
  envelope: ControlEnvelope<unknown>,
  expectedTag: "unauthorized" | "forbidden",
  operation: string,
): void => {
  if (envelope.ok || envelope.error._tag !== expectedTag) {
    throw new Error(
      envelope.ok
        ? `${operation}: unexpectedly succeeded`
        : `${operation}: expected ${expectedTag}, received ${envelope.error._tag}`,
    );
  }
};

const assertSecretsAbsent = (
  secrets: ReadonlyArray<string>,
  artifacts: ReadonlyArray<readonly [name: string, value: string]>,
): void => {
  for (const [name, value] of artifacts) {
    if (secrets.some((secret) => value.includes(secret))) {
      throw new Error(`capability bearer leaked into ${name}`);
    }
  }
};

const redactKnownSecrets = (value: string, secrets: ReadonlyArray<string>): string =>
  secrets.reduce(
    (redacted, secret) => redacted.replaceAll(secret, ""),
    value,
  );

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
  capability: string,
  sessionId: string,
): Promise<Record<string, unknown>> => {
  const deadline = Date.now() + PAGE_TIMEOUT_MS;
  let lastError = "page report not ready";
  while (Date.now() < deadline) {
    try {
      const data = requireOk(
        await controlCall(socketPath, token, "eval", {
          sessionId,
          code: `(() => {
            const node = document.getElementById("vellum-containment-report");
            if (node?.dataset.mainWorldPoisoned !== "true") return null;
            return JSON.parse(node.textContent || "null");
          })()`,
        }, { capability }),
        `eval ${sessionId}`,
      );
      if (isRecord(data) && isRecord(data.result)) return data.result;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(`page probe timed out for ${sessionId}: ${lastError}`);
};

const waitForSessionInvalidation = async (
  socketPath: string,
  token: string,
  capability: string,
  sessionId: string,
): Promise<void> => {
  const deadline = Date.now() + EVAL_INVALIDATION_TIMEOUT_MS;
  let lastError = "session still registered";
  while (Date.now() < deadline) {
    try {
      const sessions = requireOk(
        await controlCall(socketPath, token, "sessions", undefined, { capability }),
        "sessions",
      );
      if (!Array.isArray(sessions)) throw new Error("sessions response is not an array");
      const stillRegistered = sessions.some(
        (session) => isRecord(session) && session.sessionId === sessionId,
      );
      if (!stillRegistered) return;
      lastError = "session still registered after hung eval";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(`hung eval did not invalidate ${sessionId}: ${lastError}`);
};

const assertStaleSessionRejected = async (
  socketPath: string,
  token: string,
  capability: string,
  sessionId: string,
): Promise<void> => {
  const envelope = await controlCall(socketPath, token, "eval", {
    sessionId,
    code: "1",
  }, { capability });
  if (envelope.ok || envelope.error._tag !== "not_found") {
    throw new Error(`stale session ${sessionId} was not rejected as not_found`);
  }
};

const startNeverReturningEval = async (
  socketPath: string,
  token: string,
  capability: string,
  sessionId: string,
): Promise<void> => {
  const envelope = await controlCall(
    socketPath,
    token,
    "eval",
    {
      sessionId,
      code: "(() => { for (;;) {} })()",
    },
    { capability, timeoutMs: EVAL_INVALIDATION_TIMEOUT_MS },
  );
  if (envelope.ok || envelope.error._tag !== "timeout") {
    throw new Error(
      envelope.ok
        ? "never-returning eval unexpectedly completed"
        : `never-returning eval returned ${envelope.error._tag} instead of timeout`,
    );
  }
};

const assertContainment = (
  report: Record<string, unknown>,
  fixtureOrigin: string,
  customProtocolUrl: string,
): void => {
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

  if (report.popupReturnedNull !== true) {
    throw new Error("hostile page received a popup/window handle");
  }
  if (
    report.permissionState !== "denied" ||
    report.geolocation !== "denied" ||
    report.notificationPermission !== "denied"
  ) {
    throw new Error(
      `hostile page permission was not denied (${String(report.permissionState)}/${String(report.geolocation)}/${String(report.notificationPermission)})`,
    );
  }
  if (report.privateSentinel !== "blocked") {
    throw new Error(`hostile page reached the private sentinel (${String(report.privateSentinel)})`);
  }
  if (report.downloadTriggered !== true) {
    throw new Error("hostile page did not exercise the download path");
  }
  if (report.customProtocolAttempted !== customProtocolUrl) {
    throw new Error("hostile page did not exercise the custom protocol path");
  }
  if (
    typeof report.locationAfterAttacks !== "string" ||
    !report.locationAfterAttacks.startsWith(`${fixtureOrigin}/`)
  ) {
    throw new Error("custom protocol navigation escaped the fixture origin");
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

const qualifyCapabilityAdmission = async (
  socketPath: string,
  token: string,
  handoff: CapabilityHandoff,
  canvasName: string,
  pageTargets: ReadonlyArray<{ readonly nodeId: string }>,
): Promise<void> => {
  requireDenied(
    await controlCall(socketPath, token, "profiles"),
    "unauthorized",
    "token-only protected call",
  );
  requireDenied(
    await controlCall(socketPath, token, "profiles", undefined, {
      capability: handoff.unrelatedCapability,
    }),
    "unauthorized",
    "unrelated-registry capability",
  );
  requireDenied(
    await controlCall(socketPath, token, "pages", undefined, {
      capability: handoff.siblingCapability,
    }),
    "forbidden",
    "wrong-action capability",
  );
  requireDenied(
    await controlCall(
      socketPath,
      token,
      "open",
      { ref: formatNodeRef({ canvasName, nodeId: "personal-seed" }) },
      { capability: handoff.siblingCapability },
    ),
    "forbidden",
    "wrong-target capability",
  );

  const profiles = requireOk(
    await controlCall(socketPath, token, "profiles", undefined, {
      capability: handoff.capability,
    }),
    "profiles",
  );
  if (
    !Array.isArray(profiles) ||
    !["personal", "work"].every((id) =>
      profiles.some((profile) => isRecord(profile) && profile.id === id),
    )
  ) {
    throw new Error("full capability did not expose both scoped profiles");
  }

  const pages = requireOk(
    await controlCall(socketPath, token, "pages", undefined, {
      capability: handoff.capability,
    }),
    "pages",
  );
  const expectedRefs = new Set<string>(
    pageTargets.map(({ nodeId }) => formatNodeRef({ canvasName, nodeId })),
  );
  if (
    !Array.isArray(pages) ||
    pages.length !== expectedRefs.size ||
    pages.some((page) => !isRecord(page) || !expectedRefs.has(String(page.ref)))
  ) {
    throw new Error("full capability did not expose exactly the five scoped page refs");
  }

  const initialSessions = requireOk(
    await controlCall(socketPath, token, "sessions", undefined, {
      capability: handoff.capability,
    }),
    "sessions",
  );
  if (!Array.isArray(initialSessions) || initialSessions.length !== 0) {
    throw new Error("new capability owner inherited browser sessions");
  }
};

const openCapabilityPage = async (
  socketPath: string,
  token: string,
  capability: string,
  canvasName: string,
  nodeId: string,
): Promise<string> => {
  const ref = formatNodeRef({ canvasName, nodeId });
  const data = requireOk(
    await controlCall(socketPath, token, "open", { ref }, { capability }),
    `open ${ref}`,
  );
  if (!isRecord(data) || typeof data.sessionId !== "string") {
    throw new Error(`open ${ref}: response has no sessionId`);
  }
  return data.sessionId;
};

const openAndQualifySiblingOwner = async (
  socketPath: string,
  token: string,
  siblingCapability: string,
  canvasName: string,
  fixtureOrigin: string,
  customProtocolUrl: string,
): Promise<string> => {
  const sessionId = await openCapabilityPage(
    socketPath,
    token,
    siblingCapability,
    canvasName,
    "work-read",
  );
  const report = await waitForReport(socketPath, token, siblingCapability, sessionId);
  assertContainment(report, fixtureOrigin, customProtocolUrl);
  const sessions = requireOk(
    await controlCall(socketPath, token, "sessions", undefined, {
      capability: siblingCapability,
    }),
    "sibling sessions",
  );
  if (
    !Array.isArray(sessions) ||
    sessions.length !== 1 ||
    !sessions.some((session) => isRecord(session) && session.sessionId === sessionId)
  ) {
    throw new Error("sibling capability did not own exactly its isolated session");
  }
  return sessionId;
};

const qualifyCapabilityRevocation = async (options: {
  readonly socketPath: string;
  readonly token: string;
  readonly capability: string;
  readonly siblingCapability: string;
  readonly siblingSessionId: string;
  readonly auditPath: string;
  readonly revokeMarkerPath: string;
  readonly fixtureOrigin: string;
  readonly customProtocolUrl: string;
  readonly legacyTcpPort: number;
  readonly downloadsDir: string;
  readonly privateSentinelRequests: number;
  readonly popupRequests: number;
}): Promise<ProbeAudit> => {
  await writeFile(options.revokeMarkerPath, "revoke\n", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  const audit = await waitForAudit(
    options.auditPath,
    (candidate) =>
      candidate.capabilityRevoked &&
      candidate.currentWebContents === candidate.baselineWebContents + 1,
  );
  if (audit.browserWindows !== 0) {
    throw new Error("capability revocation created an unmanaged BrowserWindow");
  }
  requireDenied(
    await controlCall(options.socketPath, options.token, "sessions", undefined, {
      capability: options.capability,
    }),
    "unauthorized",
    "revoked capability",
  );
  const siblingSessions = requireOk(
    await controlCall(options.socketPath, options.token, "sessions", undefined, {
      capability: options.siblingCapability,
    }),
    "sibling sessions after revocation",
  );
  if (
    !Array.isArray(siblingSessions) ||
    siblingSessions.length !== 1 ||
    !siblingSessions.some(
      (session) => isRecord(session) && session.sessionId === options.siblingSessionId,
    )
  ) {
    throw new Error("revoking one capability destroyed a sibling owner's session");
  }
  const report = await waitForReport(
    options.socketPath,
    options.token,
    options.siblingCapability,
    options.siblingSessionId,
  );
  assertContainment(report, options.fixtureOrigin, options.customProtocolUrl);
  if (audit.browserWindows !== 0 || audit.externalProtocolDispatches.length !== 0) {
    throw new Error("revocation qualification left unmanaged browser authority");
  }
  await assertTcpControlAbsent(options.legacyTcpPort, options.token);
  if (options.privateSentinelRequests !== 0 || options.popupRequests !== 0) {
    throw new Error("sibling qualification escaped hostile-page containment");
  }
  if ((await readdir(options.downloadsDir)).length !== 0) {
    throw new Error("sibling qualification wrote a denied download");
  }
  return audit;
};

const qualifyHostilePolicyAudit = async (options: {
  readonly auditPath: string;
  readonly privateSentinelRequests: number;
  readonly popupRequests: number;
  readonly downloadRequests: number;
  readonly downloadsDir: string;
}): Promise<void> => {
  const audit = await waitForAudit(
    options.auditPath,
    (candidate) => candidate.createdWebContents.length >= 6,
  );
  if (
    audit.createdWebContents.length !== 6 ||
    audit.browserWindows !== 0 ||
    audit.currentWebContents > 3
  ) {
    throw new Error(
      `hostile popup created a transient or surviving unmanaged WebContents (${JSON.stringify(audit)})`,
    );
  }
  if (audit.externalProtocolDispatches.length !== 0) {
    throw new Error("custom protocol escaped into OS protocol dispatch");
  }
  if (options.privateSentinelRequests !== 0) {
    throw new Error(
      `private loopback sentinel received ${options.privateSentinelRequests} request(s)`,
    );
  }
  if (options.popupRequests !== 0) {
    throw new Error(`denied popup origin received ${options.popupRequests} request(s)`);
  }
  if (options.downloadRequests === 0) {
    throw new Error("hostile download response did not reach the Electron download policy");
  }
  const downloadedFiles = await readdir(options.downloadsDir);
  if (downloadedFiles.length !== 0) {
    throw new Error(`denied download wrote files: ${downloadedFiles.join(", ")}`);
  }
};

const qualifyCapabilityNonDisclosure = async (options: {
  readonly outputCapabilityLeak: "stdout" | "stderr" | undefined;
  readonly knownCapabilities: ReadonlyArray<string>;
  readonly stdout: string;
  readonly stderr: string;
  readonly auditPath: string;
  readonly canvasPath: string;
  readonly electronArguments: ReadonlyArray<string>;
}): Promise<void> => {
  if (options.outputCapabilityLeak !== undefined) {
    throw new Error(`capability bearer leaked into Electron ${options.outputCapabilityLeak}`);
  }
  const [persistedAuditJson, persistedCanvasJson] = await Promise.all([
    readFile(options.auditPath, "utf8"),
    readFile(options.canvasPath, "utf8"),
  ]);
  assertSecretsAbsent(options.knownCapabilities, [
    ["Electron stdout", options.stdout],
    ["Electron stderr", options.stderr],
    ["probe audit JSON", persistedAuditJson],
    ["canvas document", persistedCanvasJson],
    ["Electron argv", JSON.stringify(options.electronArguments)],
    ["control response JSON", observedControlResponseJson.join("\n")],
  ]);
};

const main = async (): Promise<void> => {
  const root = await mkdtemp(PROBE_TEMP_PREFIX);
  activeProbeRoot = root;
  const home = join(root, "home");
  const userData = join(root, "electron-user-data");
  const browserDir = join(root, "browser");
  const canvasesDir = join(home, ".vellum", "canvases");
  const downloadsDir = join(root, "downloads");
  const auditPath = join(root, "electron-audit.json");
  const capabilityPath = join(root, "browser-capabilities.json");
  const revokeMarkerPath = join(root, "revoke-capability.marker");
  const markerPath = join(root, `host-marker-${randomUUID()}`);
  const nonce = randomUUID();
  const customProtocolUrl = `vellum-probe://denied/${nonce}`;
  const legacyTcpPort = await reserveLoopbackPort();
  await Promise.all(
    [home, userData, browserDir, canvasesDir, downloadsDir].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );

  let privateSentinelRequests = 0;
  const sentinelServer = createServer((_req, res) => {
    privateSentinelRequests += 1;
    res.writeHead(204, { "cache-control": "no-store" });
    res.end();
  });
  activeSentinelServer = sentinelServer;
  await new Promise<void>((resolveListen, rejectListen) => {
    sentinelServer.once("error", rejectListen);
    sentinelServer.listen(0, "127.0.0.1", () => resolveListen());
  });
  const sentinelAddress = sentinelServer.address();
  if (sentinelAddress === null || typeof sentinelAddress === "string") {
    throw new Error("private sentinel server has no port");
  }
  const privateSentinelUrl = `http://127.0.0.1:${sentinelAddress.port}/private-sentinel`;

  const fixture = await readFile(fixturePath);
  let downloadRequests = 0;
  let popupRequests = 0;
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://fixture.invalid");
    if (requestUrl.pathname === "/download") {
      downloadRequests += 1;
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="vellum-probe-${nonce}.txt"`,
        "cache-control": "no-store",
      });
      res.end("a denied hostile download must never reach disk");
      return;
    }
    if (requestUrl.pathname === "/popup") popupRequests += 1;
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(fixture);
  });
  activeProbeServer = server;
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture server has no port");
  const origin = `http://127.0.0.1:${address.port}`;
  const downloadUrl = `${origin}/download?nonce=${encodeURIComponent(nonce)}`;
  const fixtureUrl = (mode: "seed" | "read") => {
    const url = new URL(origin);
    url.searchParams.set("mode", mode);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("marker", markerPath);
    url.searchParams.set("download", downloadUrl);
    url.searchParams.set("privateSentinel", privateSentinelUrl);
    url.searchParams.set("customProtocol", customProtocolUrl);
    return url.toString();
  };
  const canvasName = "browser-containment";
  const pageTargets = [
    { nodeId: "personal-seed", profile: "personal", url: fixtureUrl("seed") },
    { nodeId: "work-read", profile: "work", url: fixtureUrl("read") },
    { nodeId: "filler-one", profile: "personal", url: fixtureUrl("read") },
    { nodeId: "filler-two", profile: "work", url: fixtureUrl("read") },
    { nodeId: "personal-restored", profile: "personal", url: fixtureUrl("read") },
  ] as const;
  const canvasPath = join(canvasesDir, `${canvasName}.canvas`);
  const canvasJson = JSON.stringify({
    nodes: pageTargets.map(({ nodeId, profile, url }, index) => ({
      id: nodeId,
      type: "link",
      url,
      x: index * 420,
      y: 0,
      width: 400,
      height: 300,
      ether: { entity: { kind: "page" }, browser: { profile } },
    })),
    edges: [],
  });
  await writeFile(
    canvasPath,
    canvasJson,
    { encoding: "utf8", mode: 0o600 },
  );

  probeStage = "dedicated Electron entry build";
  const dedicatedMainPath = await buildDedicatedElectronEntry(root);

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

  const electronArguments = [
    dedicatedMainPath,
    `--user-data-dir=${userData}`,
    `--fixture-origin=${origin}`,
    `--browser-root=${browserDir}`,
    `--control-home=${home}`,
    `--download-path=${downloadsDir}`,
    `--audit-path=${auditPath}`,
    `--capability-path=${capabilityPath}`,
    `--revoke-marker-path=${revokeMarkerPath}`,
  ];
  if (
    electronArguments.some((argument) =>
      /--(?:remote-debugging|inspect|inspect-brk)(?:=|$)/.test(argument),
    )
  ) {
    throw new Error("dedicated Electron entry unexpectedly enabled CDP or inspector authority");
  }

  const child = spawn(
    electronPath,
    electronArguments,
    {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  activeProbeChild = child;
  let stdout = "";
  let stderr = "";
  let exited = false;
  let knownCapabilities: string[] = [];
  let outputCapabilityLeak: "stdout" | "stderr" | undefined;
  const captureChildOutput = (
    source: "stdout" | "stderr",
    current: string,
    chunk: Buffer,
  ): string => {
    const next = appendBounded(current, chunk);
    if (knownCapabilities.some((secret) => next.includes(secret))) {
      outputCapabilityLeak ??= source;
    }
    return next;
  };
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = captureChildOutput("stdout", stdout, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = captureChildOutput("stderr", stderr, chunk);
  });
  child.once("exit", () => {
    exited = true;
  });

  try {
    probeStage = "control startup";
    const { socketPath, token } = await waitForControl(home, () => exited);
    probeStage = "capability handoff";
    const handoff = await waitForCapabilityHandoff(capabilityPath, () => exited);
    const { capability, siblingCapability } = handoff;
    knownCapabilities = [
      capability,
      handoff.unrelatedCapability,
      siblingCapability,
    ];
    if (knownCapabilities.some((secret) => stdout.includes(secret))) {
      outputCapabilityLeak = "stdout";
    } else if (knownCapabilities.some((secret) => stderr.includes(secret))) {
      outputCapabilityLeak = "stderr";
    }
    if (!(await markerAbsent(capabilityPath))) {
      throw new Error("parent retained the capability handoff file after reading it");
    }
    const baselineAudit = await waitForAudit(auditPath, (audit) => audit.ready);
    if (
      baselineAudit.baselineWebContents !== 0 ||
      baselineAudit.currentWebContents !== 0 ||
      baselineAudit.createdWebContents.length !== 0 ||
      baselineAudit.browserWindows !== 0
    ) {
      throw new Error("dedicated Electron entry did not start from an empty WebContents baseline");
    }
    await assertTcpControlAbsent(legacyTcpPort, token);

    probeStage = "capability admission";
    await qualifyCapabilityAdmission(socketPath, token, handoff, canvasName, pageTargets);

    const open = (nodeId: string): Promise<string> =>
      openCapabilityPage(socketPath, token, capability, canvasName, nodeId);

    const personalSeedSession = await open("personal-seed");
    const personalSeed = await waitForReport(socketPath, token, capability, personalSeedSession);
    assertContainment(personalSeed, origin, customProtocolUrl);
    const afterFirstPageAudit = await waitForAudit(
      auditPath,
      (audit) => audit.createdWebContents.length >= 1,
    );
    if (
      afterFirstPageAudit.createdWebContents.length -
        afterFirstPageAudit.baselineWebContents !==
        1 ||
      afterFirstPageAudit.currentWebContents !==
        afterFirstPageAudit.baselineWebContents + 1 ||
      afterFirstPageAudit.browserWindows !== 0
    ) {
      throw new Error("popup attempt created an unmanaged BrowserWindow/WebContents");
    }
    if (personalSeed.cookieValue !== nonce || personalSeed.storageValue !== nonce) {
      throw new Error("personal profile did not persist its synthetic state");
    }
    if (!(await markerAbsent(markerPath))) throw new Error("hostile page wrote a host marker");

    const workReadSession = await open("work-read");
    const workRead = await waitForReport(socketPath, token, capability, workReadSession);
    assertContainment(workRead, origin, customProtocolUrl);
    if (workRead.cookieValue !== null || workRead.storageValue !== null) {
      throw new Error("work profile observed personal profile state");
    }

    const timeoutPersonalSession = await open("filler-one");
    const timeoutPersonal = await waitForReport(
      socketPath,
      token,
      capability,
      timeoutPersonalSession,
    );
    assertContainment(timeoutPersonal, origin, customProtocolUrl);
    if (timeoutPersonal.cookieValue !== nonce || timeoutPersonal.storageValue !== nonce) {
      throw new Error("second personal view did not observe its isolated profile state");
    }
    const unaffectedWorkSession = await open("filler-two");
    const unaffectedBefore = await waitForReport(
      socketPath,
      token,
      capability,
      unaffectedWorkSession,
    );
    assertContainment(unaffectedBefore, origin, customProtocolUrl);
    const sessions = requireOk(
      await controlCall(socketPath, token, "sessions", undefined, { capability }),
      "sessions",
    );
    if (!Array.isArray(sessions)) throw new Error("sessions response is not an array");
    const nodeIds = sessions
      .filter(isRecord)
      .map((session) => session.nodeId)
      .filter((nodeId): nodeId is string => typeof nodeId === "string");
    if (nodeIds.includes("personal-seed")) {
      throw new Error("warm-pool pressure did not evict the original personal view");
    }

    probeStage = "hung eval operation deadline";
    await startNeverReturningEval(socketPath, token, capability, timeoutPersonalSession);
    probeStage = "hung eval session invalidation";
    await waitForSessionInvalidation(socketPath, token, capability, timeoutPersonalSession);
    probeStage = "stale handle rejection";
    await assertStaleSessionRejected(socketPath, token, capability, timeoutPersonalSession);

    probeStage = "owner-isolation capacity lane";
    await startNeverReturningEval(socketPath, token, capability, workReadSession);
    await waitForSessionInvalidation(socketPath, token, capability, workReadSession);

    probeStage = "sibling owner isolation";
    const siblingSessionId = await openAndQualifySiblingOwner(
      socketPath,
      token,
      siblingCapability,
      canvasName,
      origin,
      customProtocolUrl,
    );

    probeStage = "unaffected work session";
    const unaffectedAfter = await waitForReport(
      socketPath,
      token,
      capability,
      unaffectedWorkSession,
    );
    assertContainment(unaffectedAfter, origin, customProtocolUrl);
    probeStage = "same-profile restoration";
    const personalRestoredSession = await open("personal-restored");
    const personalRestored = await waitForReport(
      socketPath,
      token,
      capability,
      personalRestoredSession,
    );
    assertContainment(personalRestored, origin, customProtocolUrl);
    if (personalRestored.cookieValue !== nonce || personalRestored.storageValue !== nonce) {
      throw new Error("personal profile state did not survive destructive eval timeout");
    }
    if (!(await markerAbsent(markerPath))) throw new Error("hostile page wrote a host marker");
    probeStage = "post-timeout TCP regression";
    await assertTcpControlAbsent(legacyTcpPort, token);

    probeStage = "hostile web policy audit";
    await qualifyHostilePolicyAudit({
      auditPath,
      privateSentinelRequests,
      popupRequests,
      downloadRequests,
      downloadsDir,
    });

    probeStage = "capability revocation";
    await qualifyCapabilityRevocation({
      socketPath,
      token,
      capability,
      siblingCapability,
      siblingSessionId,
      auditPath,
      revokeMarkerPath,
      fixtureOrigin: origin,
      customProtocolUrl,
      legacyTcpPort,
      downloadsDir,
      privateSentinelRequests,
      popupRequests,
    });

    probeStage = "fixture shutdown";
    await stopChild(child);
    if (!(await markerAbsent(socketPath))) {
      throw new Error("browser control socket remained after Electron quit");
    }

    probeStage = "capability non-disclosure";
    await qualifyCapabilityNonDisclosure({
      outputCapabilityLeak,
      knownCapabilities,
      stdout,
      stderr,
      auditPath,
      canvasPath,
      electronArguments,
    });

    console.log(
      JSON.stringify({
        ok: true,
        assertions: {
          privilegedGlobalsAbsent: true,
          hostWritesBlocked: true,
          profilesIsolated: true,
          partitionSurvivesEviction: true,
          hungEvalDestroysOnlyTargetView: true,
          staleSessionRejected: true,
          profileSurvivesDestructiveTimeout: true,
          unaffectedSessionRemainsUsable: true,
          tokenOnlyAuthorityDenied: true,
          unrelatedRegistryAuthorityDenied: true,
          wrongActionAndTargetDenied: true,
          fullFivePageCapabilityAdmitted: true,
          freshRequestIdPerProtectedCall: true,
          capabilityRevocationEnforced: true,
          siblingOwnerSurvivesRevocation: true,
          capabilityAbsentFromArtifactsAndLogs: true,
          tcpListenerAbsent: true,
          cdpAuthorityAbsent: true,
          mcpAuthorityAbsent: true,
          popupAndNewWebContentsDenied: true,
          permissionsDeniedWithoutPagePrompt: true,
          downloadBlockedWithoutFile: true,
          customProtocolNotDispatched: true,
          privateLoopbackSentinelUnreached: true,
          dedicatedEntryBuiltHermetically: true,
        },
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        stage: probeStage,
        error: redactKnownSecrets(
          error instanceof Error ? error.message : String(error),
          knownCapabilities,
        ),
        stdout: redactKnownSecrets(stdout, knownCapabilities),
        stderr: redactKnownSecrets(stderr, knownCapabilities),
      }),
    );
    process.exitCode = 2;
  } finally {
    probeStage = "cleanup child";
    await stopChild(child);
    probeStage = "cleanup fixture server";
    server.closeAllConnections();
    await Promise.race([closeServer(server), delay(2_000)]);
    probeStage = "cleanup sentinel server";
    sentinelServer.closeAllConnections();
    await Promise.race([closeServer(sentinelServer), delay(2_000)]);
    if (!root.startsWith(PROBE_TEMP_PREFIX)) {
      throw new Error(`refusing unsafe probe cleanup: ${root}`);
    }
    await rm(root, { recursive: true, force: true });
    if (activeProbeChild === child) activeProbeChild = undefined;
    if (activeProbeServer === server) activeProbeServer = undefined;
    if (activeSentinelServer === sentinelServer) activeSentinelServer = undefined;
    if (activeProbeRoot === root) activeProbeRoot = undefined;
  }
};

const watchdog = setTimeout(() => {
  console.error(
    JSON.stringify({
      ok: false,
      error: `Electron containment probe exceeded ${PROBE_RUNTIME_TIMEOUT_MS}ms during ${probeStage}`,
    }),
  );
  void (async () => {
    const child = activeProbeChild;
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), delay(750)]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    try {
      activeProbeServer?.closeAllConnections();
      activeProbeServer?.close();
      activeSentinelServer?.closeAllConnections();
      activeSentinelServer?.close();
    } catch {
      // Watchdog cleanup is best effort; process termination is the final bound.
    }
    const root = activeProbeRoot;
    if (root !== undefined && root.startsWith(PROBE_TEMP_PREFIX)) {
      await Promise.race([
        rm(root, { recursive: true, force: true }).catch(() => undefined),
        delay(1_000),
      ]);
    }
    process.exit(124);
  })();
}, PROBE_RUNTIME_TIMEOUT_MS);
watchdog.unref();
try {
  await main();
} finally {
  clearTimeout(watchdog);
}
