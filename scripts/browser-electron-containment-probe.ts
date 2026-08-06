#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Result } from "effect";
import {
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
import {
  createProbeSandbox,
  createProbeProcessSupervisor,
  removeProbeSandboxIfClean,
  type ProbeProcessHandle,
  type ProbeSandbox,
} from "./probe-process-supervisor";

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
const PROBE_RUNTIME_TIMEOUT_MS = 120_000;
const MAX_LOG_BYTES = 256 * 1024;
// Adversarial recurrence input only: the product protocol no longer defines
// this header. The probe sends it to prove an obsolete client credential
// cannot select browser authority.
const RETIRED_CLIENT_CAPABILITY_HEADER = "x-vellum-capability";
const probeSupervisor = createProbeProcessSupervisor({ maxLogBytes: MAX_LOG_BYTES });
let probeStage = "setup";
let activeProbeServer: Server | undefined;
let activeSentinelServer: Server | undefined;
let activeProbeSandbox: ProbeSandbox | undefined;
let watchdogExitRequested = false;
let normalCleanupCompleted = false;
let successfulProbeOutput: string | undefined;
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
  readonly revokedCapabilityDestroyedSessions: number;
  readonly expiringCapabilityExpired: boolean;
  readonly expiringCapabilityDestroyedSessions: number;
  readonly remoteDebuggingSwitchPresent: boolean;
  readonly mainInspectorActive: boolean;
  readonly managedDevToolsOpenEvents: number;
  readonly managedDevToolsCurrentlyOpen: number;
  readonly defaultProxyResolution: string;
  readonly profileProxyResolution: string;
  readonly edgeAdmissions: ReadonlyArray<{
    readonly sequence: number;
    readonly mode: AdmissionMode;
    readonly authorityPath: AdmissionAuthorityPath;
    readonly principalId: string;
    readonly jobId: string;
    readonly auditId: string;
    readonly targetCount: number;
  }>;
  readonly edgeDenials: ReadonlyArray<{
    readonly mode: "terminal" | "unbound";
    readonly denial: string;
    readonly capabilityIssuesBefore: number;
    readonly capabilityIssuesAfter: number;
    readonly webContentsBefore: number;
    readonly webContentsAfter: number;
  }>;
  readonly capabilityEvents: ReadonlyArray<{
    readonly sequence: number;
    readonly outcome: string;
    readonly principalId?: string;
    readonly jobId?: string;
    readonly auditId?: string;
    readonly action?: string;
  }>;
  readonly shutdownRequested: boolean;
  readonly shutdownControlClean: boolean;
  readonly shutdownRetainedLabels: ReadonlyArray<string>;
  readonly shutdownCompleted: boolean;
  readonly ready: boolean;
}

type AdmissionMode =
  | "process-bound"
  | "primary"
  | "expiring"
  | "sibling"
  | "mismatched"
  | "terminal"
  | "unbound";

type AdmissionAuthorityPath = "unix-peer-pid+process-map+canvas-edges" | "fixture-tuple";

const isAdmissionMode = (value: unknown): value is AdmissionMode =>
  value === "process-bound" ||
  value === "primary" ||
  value === "expiring" ||
  value === "sibling" ||
  value === "mismatched" ||
  value === "terminal" ||
  value === "unbound";

const isBoundedId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;

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
    typeof value.revokedCapabilityDestroyedSessions !== "number" ||
    typeof value.expiringCapabilityExpired !== "boolean" ||
    typeof value.expiringCapabilityDestroyedSessions !== "number" ||
    typeof value.remoteDebuggingSwitchPresent !== "boolean" ||
    typeof value.mainInspectorActive !== "boolean" ||
    typeof value.managedDevToolsOpenEvents !== "number" ||
    typeof value.managedDevToolsCurrentlyOpen !== "number" ||
    typeof value.defaultProxyResolution !== "string" ||
    typeof value.profileProxyResolution !== "string" ||
    !Array.isArray(value.edgeAdmissions) ||
    !Array.isArray(value.edgeDenials) ||
    !Array.isArray(value.capabilityEvents) ||
    typeof value.shutdownRequested !== "boolean" ||
    typeof value.shutdownControlClean !== "boolean" ||
    !Array.isArray(value.shutdownRetainedLabels) ||
    typeof value.shutdownCompleted !== "boolean" ||
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
  const edgeAdmissions = value.edgeAdmissions.map((entry) => {
    if (
      !isRecord(entry) ||
      !Number.isSafeInteger(entry.sequence) ||
      Number(entry.sequence) <= 0 ||
      !isAdmissionMode(entry.mode) ||
      (entry.authorityPath !== "unix-peer-pid+process-map+canvas-edges" &&
        entry.authorityPath !== "fixture-tuple") ||
      !isBoundedId(entry.principalId) ||
      !isBoundedId(entry.jobId) ||
      !isBoundedId(entry.auditId) ||
      !Number.isSafeInteger(entry.targetCount) ||
      Number(entry.targetCount) <= 0
    ) {
      throw new Error("dedicated Electron probe emitted a malformed edge-admission audit");
    }
    return {
      sequence: Number(entry.sequence),
      mode: entry.mode,
      authorityPath: entry.authorityPath as AdmissionAuthorityPath,
      principalId: entry.principalId,
      jobId: entry.jobId,
      auditId: entry.auditId,
      targetCount: Number(entry.targetCount),
    };
  });
  const capabilityEvents = value.capabilityEvents.map((entry) => {
    if (
      !isRecord(entry) ||
      !Number.isSafeInteger(entry.sequence) ||
      Number(entry.sequence) <= 0 ||
      !isBoundedId(entry.outcome) ||
      (entry.principalId !== undefined && !isBoundedId(entry.principalId)) ||
      (entry.jobId !== undefined && !isBoundedId(entry.jobId)) ||
      (entry.auditId !== undefined && !isBoundedId(entry.auditId)) ||
      (entry.action !== undefined && !isBoundedId(entry.action))
    ) {
      throw new Error("dedicated Electron probe emitted a malformed capability audit");
    }
    return {
      sequence: Number(entry.sequence),
      outcome: entry.outcome,
      ...(entry.principalId === undefined ? {} : { principalId: entry.principalId }),
      ...(entry.jobId === undefined ? {} : { jobId: entry.jobId }),
      ...(entry.auditId === undefined ? {} : { auditId: entry.auditId }),
      ...(entry.action === undefined ? {} : { action: entry.action }),
    };
  });
  const edgeDenials = value.edgeDenials.map((entry) => {
    if (
      !isRecord(entry) ||
      (entry.mode !== "terminal" && entry.mode !== "unbound") ||
      !isBoundedId(entry.denial) ||
      !Number.isSafeInteger(entry.capabilityIssuesBefore) ||
      !Number.isSafeInteger(entry.capabilityIssuesAfter) ||
      !Number.isSafeInteger(entry.webContentsBefore) ||
      !Number.isSafeInteger(entry.webContentsAfter)
    ) {
      throw new Error("dedicated Electron probe emitted a malformed edge-denial audit");
    }
    return {
      mode: entry.mode as "terminal" | "unbound",
      denial: entry.denial,
      capabilityIssuesBefore: Number(entry.capabilityIssuesBefore),
      capabilityIssuesAfter: Number(entry.capabilityIssuesAfter),
      webContentsBefore: Number(entry.webContentsBefore),
      webContentsAfter: Number(entry.webContentsAfter),
    };
  });
  if (value.shutdownRetainedLabels.some((entry) => !isBoundedId(entry))) {
    throw new Error("dedicated Electron probe emitted malformed shutdown labels");
  }
  return {
    baselineWebContents: value.baselineWebContents,
    currentWebContents: value.currentWebContents,
    maximumWebContents: value.maximumWebContents,
    browserWindows: value.browserWindows,
    createdWebContents,
    externalProtocolDispatches: value.externalProtocolDispatches as string[],
    capabilityRevoked: value.capabilityRevoked,
    revokedCapabilityDestroyedSessions: value.revokedCapabilityDestroyedSessions,
    expiringCapabilityExpired: value.expiringCapabilityExpired,
    expiringCapabilityDestroyedSessions: value.expiringCapabilityDestroyedSessions,
    remoteDebuggingSwitchPresent: value.remoteDebuggingSwitchPresent,
    mainInspectorActive: value.mainInspectorActive,
    managedDevToolsOpenEvents: value.managedDevToolsOpenEvents,
    managedDevToolsCurrentlyOpen: value.managedDevToolsCurrentlyOpen,
    defaultProxyResolution: value.defaultProxyResolution,
    profileProxyResolution: value.profileProxyResolution,
    edgeAdmissions,
    edgeDenials,
    capabilityEvents,
    shutdownRequested: value.shutdownRequested,
    shutdownControlClean: value.shutdownControlClean,
    shutdownRetainedLabels: value.shutdownRetainedLabels as string[],
    shutdownCompleted: value.shutdownCompleted,
    ready: value.ready,
  };
};

interface PrincipalWitness {
  readonly principalId: string;
  readonly jobId: string;
  readonly auditId: string;
}

interface CapabilityHandoff {
  readonly version: 3;
  readonly capability: string;
  readonly expiringCapability: string;
  readonly expiringIssuedAt: number;
  readonly expiringExpiresAt: number;
  readonly unrelatedCapability: string;
  readonly siblingCapability: string;
  readonly principals: Readonly<{
    processBound: PrincipalWitness;
    primary: PrincipalWitness;
    expiring: PrincipalWitness;
    sibling: PrincipalWitness;
  }>;
}

const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const decodePrincipalWitness = (value: unknown): PrincipalWitness | undefined =>
  isRecord(value) &&
    isBoundedId(value.principalId) &&
    isBoundedId(value.jobId) &&
    isBoundedId(value.auditId)
    ? {
        principalId: value.principalId,
        jobId: value.jobId,
        auditId: value.auditId,
      }
    : undefined;

const decodeCapabilityHandoff = (value: unknown): CapabilityHandoff => {
  if (
    !isRecord(value) ||
    value.version !== 3 ||
    typeof value.capability !== "string" ||
    typeof value.expiringCapability !== "string" ||
    typeof value.expiringIssuedAt !== "number" ||
    !Number.isSafeInteger(value.expiringIssuedAt) ||
    typeof value.expiringExpiresAt !== "number" ||
    !Number.isSafeInteger(value.expiringExpiresAt) ||
    value.expiringExpiresAt - value.expiringIssuedAt < 1_000 ||
    value.expiringExpiresAt - value.expiringIssuedAt > 10_000 ||
    typeof value.unrelatedCapability !== "string" ||
    typeof value.siblingCapability !== "string" ||
    !isRecord(value.principals) ||
    !CAPABILITY_PATTERN.test(value.capability) ||
    !CAPABILITY_PATTERN.test(value.expiringCapability) ||
    !CAPABILITY_PATTERN.test(value.unrelatedCapability) ||
    !CAPABILITY_PATTERN.test(value.siblingCapability) ||
    new Set([
      value.capability,
      value.expiringCapability,
      value.unrelatedCapability,
      value.siblingCapability,
    ]).size !== 4
  ) {
    throw new Error("dedicated Electron probe emitted a malformed capability handoff");
  }
  const processBound = decodePrincipalWitness(value.principals.processBound);
  const primary = decodePrincipalWitness(value.principals.primary);
  const expiring = decodePrincipalWitness(value.principals.expiring);
  const sibling = decodePrincipalWitness(value.principals.sibling);
  if (
    processBound === undefined ||
    primary === undefined ||
    expiring === undefined ||
    sibling === undefined ||
    new Set([
      processBound.principalId,
      primary.principalId,
      expiring.principalId,
      sibling.principalId,
    ]).size !== 4 ||
    new Set([
      processBound.jobId,
      primary.jobId,
      expiring.jobId,
      sibling.jobId,
    ]).size !== 4 ||
    new Set([
      processBound.auditId,
      primary.auditId,
      expiring.auditId,
      sibling.auditId,
    ]).size !== 4
  ) {
    throw new Error("dedicated Electron probe emitted malformed principal witnesses");
  }
  return {
    version: 3,
    capability: value.capability,
    expiringCapability: value.expiringCapability,
    expiringIssuedAt: value.expiringIssuedAt,
    expiringExpiresAt: value.expiringExpiresAt,
    unrelatedCapability: value.unrelatedCapability,
    siblingCapability: value.siblingCapability,
    principals: { processBound, primary, expiring, sibling },
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

const waitForAdmissionEvidence = async (options: {
  readonly auditPath: string;
  readonly mode: AdmissionMode;
  readonly authorityPath?: AdmissionAuthorityPath;
  readonly targetCount?: number;
  readonly edgePrincipal: PrincipalWitness;
  readonly edgeAuditId?: string;
  readonly capabilityPrincipal: PrincipalWitness;
  readonly action: string;
  readonly outcome: string;
}): Promise<void> => {
  const edgeAuditId = options.edgeAuditId ?? options.edgePrincipal.auditId;
  await waitForAudit(
    options.auditPath,
    (audit) =>
      audit.edgeAdmissions.some(
        (entry) =>
          entry.mode === options.mode &&
          (options.authorityPath === undefined ||
            entry.authorityPath === options.authorityPath) &&
          (options.targetCount === undefined ||
            entry.targetCount === options.targetCount) &&
          entry.principalId === options.edgePrincipal.principalId &&
          entry.jobId === options.edgePrincipal.jobId &&
          entry.auditId === edgeAuditId,
      ) &&
      audit.capabilityEvents.some(
        (event) =>
          event.action === options.action &&
          event.outcome === options.outcome &&
          event.principalId === options.capabilityPrincipal.principalId &&
          event.jobId === options.capabilityPrincipal.jobId &&
          event.auditId === options.capabilityPrincipal.auditId,
      ),
  );
};

const assertDirectProxyResolution = (audit: ProbeAudit): void => {
  if (
    audit.defaultProxyResolution !== "DIRECT" ||
    audit.profileProxyResolution !== "DIRECT"
  ) {
    throw new Error(
      `browser sessions did not force direct networking (${audit.defaultProxyResolution}, ${audit.profileProxyResolution})`,
    );
  }
};

const assertRuntimeDevToolsAbsent = (audit: ProbeAudit, stage: string): void => {
  assertDirectProxyResolution(audit);
  if (audit.remoteDebuggingSwitchPresent) {
    throw new Error(`${stage}: Electron runtime exposed a remote-debugging switch`);
  }
  if (audit.mainInspectorActive) {
    throw new Error(`${stage}: Electron main-process inspector URL was active`);
  }
  if (
    audit.managedDevToolsOpenEvents !== 0 ||
    audit.managedDevToolsCurrentlyOpen !== 0
  ) {
    throw new Error(`${stage}: managed browser DevTools opened`);
  }
};

const buildDedicatedElectronEntry = async (root: string): Promise<string> => {
  const outputName = "electron-containment-main.mjs";
  const outputPath = join(root, outputName);
  const build = probeSupervisor.spawnGroup({
    source: "browser-electron-containment-probe",
    purpose: "build dedicated Electron containment entry",
    command: process.execPath,
    args: [
      "build",
      testMainEntryPath,
      "--target=node",
      "--format=esm",
      "--external=electron",
      `--outfile=${outputPath}`,
      "--sourcemap=none",
    ],
    cwd: repoRoot,
    env: process.env,
  });
  const { exitCode, signal, stdout, stderr } = await probeSupervisor.waitForClose(
    build,
    STARTUP_TIMEOUT_MS,
    "dedicated Electron entry build timed out",
  );
  if (exitCode !== 0) {
    throw new Error(
      `dedicated Electron entry build failed (${String(exitCode ?? signal)}): ${stderr || stdout}`,
    );
  }
  await access(outputPath);
  return outputPath;
};

interface ElectronLaunch {
  readonly process: ProbeProcessHandle;
  readonly shutdownRequestPath: string;
  readonly auditPath: string;
  readonly controlSocketPath: string;
  readonly exited: () => boolean;
  readonly setKnownCapabilities: (capabilities: ReadonlyArray<string>) => void;
  readonly output: () => {
    readonly stdout: string;
    readonly stderr: string;
    readonly capabilityLeak: "stdout" | "stderr" | undefined;
  };
}

const launchDedicatedElectron = (
  electronArguments: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  shutdownRequestPath: string,
  auditPath: string,
  expectedControlSocketPath: string,
): ElectronLaunch => {
  const probeProcess = probeSupervisor.spawnGroup({
    source: "browser-electron-containment-probe",
    purpose: "run dedicated Electron containment fixture",
    command: electronPath,
    args: [
      electronArguments[0]!,
      "--proxy-server=http://127.0.0.1:9",
      ...electronArguments.slice(1),
    ],
    cwd: repoRoot,
    env,
  });
  let knownCapabilities: ReadonlyArray<string> = [];
  let capabilityLeak: "stdout" | "stderr" | undefined;
  probeProcess.onOutput((source, output) => {
    if (knownCapabilities.some((secret) => output[source].includes(secret))) {
      capabilityLeak ??= source;
    }
  });
  return {
    process: probeProcess,
    shutdownRequestPath,
    auditPath,
    controlSocketPath: expectedControlSocketPath,
    exited: probeProcess.exited,
    setKnownCapabilities: (capabilities) => {
      knownCapabilities = [...capabilities];
      const { stdout, stderr } = probeProcess.output();
      if (knownCapabilities.some((secret) => stdout.includes(secret))) {
        capabilityLeak ??= "stdout";
      } else if (knownCapabilities.some((secret) => stderr.includes(secret))) {
        capabilityLeak ??= "stderr";
      }
    },
    output: () => {
      const { stdout, stderr } = probeProcess.output();
      return { stdout, stderr, capabilityLeak };
    },
  };
};

interface ControlCallOptions {
  /** Deliberate decoy: product admission must never select authority from it. */
  readonly retiredCapabilityDecoy?: string;
  /** Protected routes require replay identity even though they require no client secret. */
  readonly requestId?: string | false;
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
    const requestId = options.requestId === false
      ? undefined
      : options.requestId ?? randomUUID();
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
          ...(requestId === undefined ? {} : { [CONTROL_REQUEST_ID_HEADER]: requestId }),
          ...(options.retiredCapabilityDecoy === undefined
            ? {}
            : {
                [RETIRED_CLIENT_CAPABILITY_HEADER]:
                  options.retiredCapabilityDecoy,
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
            if (Result.isFailure(decoded)) {
              settle({ error: new Error(decoded.failure.message) });
              return;
            }
            settle({ value: decoded.success });
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
  expectedTag: "unauthorized" | "forbidden" | "bad_request",
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

const writeAdmissionMode = async (
  path: string,
  mode: AdmissionMode,
): Promise<void> => {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${mode}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, path);
};

interface DenialProbeClient {
  readonly request: (socketPath: string, token: string) => Promise<ControlEnvelope<unknown>>;
}

const DENIAL_PROBE_CLIENT_SOURCE = String.raw`
const { readFile, writeFile } = require("node:fs/promises");
const { request } = require("node:http");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const main = async () => {
  const { readyPath, requestPath, responsePath } = process.env;
  await writeFile(readyPath, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  let input;
  for (;;) {
    try { input = await readJson(requestPath); break; } catch { await delay(25); }
  }
  const result = await new Promise((resolve) => {
    const req = request({
      socketPath: input.socketPath,
      method: "GET",
      path: "/profiles",
      headers: {
        "x-vellum-command-token": input.token,
        "x-vellum-command-request-id": input.requestId,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", (error) => resolve({ error: error.message }));
    req.end();
  });
  await writeFile(responsePath, JSON.stringify(result), { mode: 0o600 });
  setInterval(() => undefined, 60_000);
};
void main().catch(async (error) => {
  await writeFile(process.env.responsePath, JSON.stringify({ error: error.message }), { mode: 0o600 });
  process.exitCode = 2;
});
`;

const waitForProbeClientPid = async (path: string): Promise<number> => {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (isRecord(value) && Number.isSafeInteger(value.pid) && Number(value.pid) > 0) {
        return Number(value.pid);
      }
    } catch {
      // The worker writes readiness atomically enough for this bounded probe.
    }
    await delay(25);
  }
  throw new Error("denial probe worker did not publish a live pid");
};

const launchDenialProbeClient = async (root: string, label: string): Promise<{
  readonly client: DenialProbeClient;
  readonly pid: number;
}> => {
  const readyPath = join(root, `${label}.ready.json`);
  const requestPath = join(root, `${label}.request.json`);
  const responsePath = join(root, `${label}.response.json`);
  probeSupervisor.spawnGroup({
    source: "browser-electron-containment-probe",
    purpose: `${label} UDS denial peer`,
    command: process.execPath,
    args: ["--eval", DENIAL_PROBE_CLIENT_SOURCE],
    cwd: repoRoot,
    env: { ...process.env, readyPath, requestPath, responsePath },
  });
  const pid = await waitForProbeClientPid(readyPath);
  return {
    pid,
    client: {
      request: async (socketPath, token) => {
        await writeFile(
          requestPath,
          JSON.stringify({ socketPath, token, requestId: randomUUID() }),
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
        const deadline = Date.now() + CONTROL_TIMEOUT_MS;
        while (Date.now() < deadline) {
          try {
            const response = await readFile(responsePath, "utf8");
            const value = JSON.parse(response);
            if (!isRecord(value) || typeof value.body !== "string") {
              throw new Error(`denial probe client failed: ${String(value?.error ?? "invalid response")}`);
            }
            const decoded = decodeControlEnvelope(JSON.parse(value.body));
            if (Result.isFailure(decoded)) throw new Error(decoded.failure.message);
            return decoded.success;
          } catch (error) {
            if (error instanceof Error && !error.message.includes("ENOENT")) throw error;
          }
          await delay(25);
        }
        throw new Error(`${label} denial probe client timed out`);
      },
    },
  };
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
        }),
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
  sessionId: string,
): Promise<void> => {
  const deadline = Date.now() + EVAL_INVALIDATION_TIMEOUT_MS;
  let lastError = "session still registered";
  while (Date.now() < deadline) {
    try {
      const sessions = requireOk(
        await controlCall(socketPath, token, "sessions"),
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
  sessionId: string,
): Promise<void> => {
  const envelope = await controlCall(socketPath, token, "eval", {
    sessionId,
    code: "1",
  });
  if (envelope.ok || envelope.error._tag !== "not_found") {
    throw new Error(`stale session ${sessionId} was not rejected as not_found`);
  }
};

const startNeverReturningEval = async (
  socketPath: string,
  token: string,
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
    { timeoutMs: EVAL_INVALIDATION_TIMEOUT_MS },
  );
  if (envelope.ok || envelope.error._tag !== "timeout") {
    throw new Error(
      envelope.ok
        ? "never-returning eval unexpectedly completed"
        : `never-returning eval returned ${envelope.error._tag} instead of timeout`,
    );
  }
};

interface InFlightEval {
  readonly result: Promise<ControlEnvelope<unknown>>;
  readonly isSettled: () => boolean;
}

const beginNeverReturningEval = (
  socketPath: string,
  token: string,
  sessionId: string,
): InFlightEval => {
  let settled = false;
  const result = controlCall(
    socketPath,
    token,
    "eval",
    {
      sessionId,
      code: "(() => { for (;;) {} })()",
    },
    { timeoutMs: EVAL_INVALIDATION_TIMEOUT_MS },
  ).finally(() => {
    settled = true;
  });
  return { result, isSettled: () => settled };
};

const requireInFlight = async (operation: InFlightEval, stage: string): Promise<void> => {
  await delay(150);
  if (operation.isSettled()) {
    throw new Error(`${stage}: protected eval settled before lifecycle invalidation`);
  }
};

const requireCancelled = async (operation: InFlightEval, stage: string): Promise<void> => {
  const envelope = await operation.result;
  if (envelope.ok || envelope.error._tag !== "cancelled") {
    throw new Error(
      envelope.ok
        ? `${stage}: protected eval unexpectedly completed`
        : `${stage}: expected cancelled, received ${envelope.error._tag}`,
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

const assertPathAbsent = async (path: string, label: string): Promise<void> => {
  try {
    const metadata = await lstat(path);
    throw new Error(
      `${label} remained after clean process close (${metadata.isSocket() ? "socket" : "non-socket"})`,
    );
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return;
    throw error;
  }
};

const stopLaunch = async (
  launch: ElectronLaunch,
  reason: string,
): Promise<void> => {
  if (!launch.exited()) {
    await writeFile(launch.shutdownRequestPath, `${reason}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  }

  let close: Awaited<ProbeProcessHandle["closed"]>;
  try {
    close = await probeSupervisor.waitForClose(
      launch.process,
      STARTUP_TIMEOUT_MS,
      "Electron fixture did not acknowledge its bounded shutdown request",
    );
  } catch (error) {
    // The central supervisor remains the only emergency signal authority. Its
    // receipt is diagnostic; an escalated close never qualifies clean shutdown.
    const emergency = await probeSupervisor.stop(launch.process, `${reason}:emergency`);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; emergency=${JSON.stringify(emergency)}`,
    );
  }
  if (close.exitCode !== 0 || close.signal !== null) {
    throw new Error(
      `Electron fixture lacked a clean process witness: ${JSON.stringify({
        exitCode: close.exitCode,
        signal: close.signal,
        diagnostics: close.diagnostics,
      })}`,
    );
  }
  await assertPathAbsent(launch.controlSocketPath, "browser control socket");
  const audit = decodeProbeAudit(JSON.parse(await readFile(launch.auditPath, "utf8")));
  if (
    !audit.shutdownRequested ||
    !audit.shutdownControlClean ||
    audit.shutdownRetainedLabels.length !== 0 ||
    !audit.shutdownCompleted
  ) {
    throw new Error(
      `Electron fixture lacked a clean shutdown receipt: ${JSON.stringify({
        shutdownRequested: audit.shutdownRequested,
        shutdownControlClean: audit.shutdownControlClean,
        shutdownRetainedLabels: audit.shutdownRetainedLabels,
        shutdownCompleted: audit.shutdownCompleted,
      })}`,
    );
  }
};

const qualifyCapabilityAdmission = async (
  socketPath: string,
  token: string,
  handoff: CapabilityHandoff,
  canvasName: string,
  pageTargets: ReadonlyArray<{ readonly nodeId: string }>,
  admissionModePath: string,
  auditPath: string,
): Promise<void> => {
  requireDenied(
    await controlCall(socketPath, token, "profiles", undefined, { requestId: false }),
    "bad_request",
    "protected call without replay identity",
  );

  const expectedRefs = new Set<string>(
    pageTargets.map(({ nodeId }) => formatNodeRef({ canvasName, nodeId })),
  );
  await writeAdmissionMode(admissionModePath, "process-bound");
  try {
    // Deliberately carries only transport token + request id. Electron must
    // derive identity from the Unix peer and human-authored canvas edges.
    const peerBoundProfiles = requireOk(
      await controlCall(socketPath, token, "profiles"),
      "real peer-bound profiles without client identity",
    );
    if (!Array.isArray(peerBoundProfiles)) {
      throw new Error("real peer-bound profiles response is not an array");
    }
    const peerBoundPages = requireOk(
      await controlCall(socketPath, token, "pages"),
      "real peer-bound pages without client identity",
    );
    if (
      !Array.isArray(peerBoundPages) ||
      peerBoundPages.length !== expectedRefs.size ||
      peerBoundPages.some(
        (page) => !isRecord(page) || !expectedRefs.has(String(page.ref)),
      )
    ) {
      throw new Error("real peer-bound authority did not derive exactly five edge targets");
    }
    for (const action of ["profiles", "pages"] as const) {
      await waitForAdmissionEvidence({
        auditPath,
        mode: "process-bound",
        authorityPath: "unix-peer-pid+process-map+canvas-edges",
        targetCount: expectedRefs.size,
        edgePrincipal: handoff.principals.processBound,
        capabilityPrincipal: handoff.principals.processBound,
        action,
        outcome: "admitted",
      });
    }
  } finally {
    await writeAdmissionMode(admissionModePath, "primary");
  }

  const fixturePrimaryProfiles = requireOk(
    await controlCall(socketPath, token, "profiles"),
    "fixture lifecycle profiles without client capability",
  );
  if (!Array.isArray(fixturePrimaryProfiles)) {
    throw new Error("fixture lifecycle profiles response is not an array");
  }
  await waitForAdmissionEvidence({
    auditPath,
    mode: "primary",
    edgePrincipal: handoff.principals.primary,
    capabilityPrincipal: handoff.principals.primary,
    action: "profiles",
    outcome: "admitted",
  });

  const profilesWithUnrelatedDecoy = requireOk(
    await controlCall(socketPath, token, "profiles", undefined, {
      retiredCapabilityDecoy: handoff.unrelatedCapability,
    }),
    "profiles with unrelated client decoy",
  );
  if (
    !Array.isArray(profilesWithUnrelatedDecoy) ||
    profilesWithUnrelatedDecoy.length !== fixturePrimaryProfiles.length
  ) {
    throw new Error("client capability decoy changed process-bound profile scope");
  }

  const pagesWithSiblingDecoy = requireOk(
    await controlCall(socketPath, token, "pages", undefined, {
      retiredCapabilityDecoy: handoff.siblingCapability,
    }),
    "pages with sibling client decoy",
  );
  if (!Array.isArray(pagesWithSiblingDecoy) || pagesWithSiblingDecoy.length !== pageTargets.length) {
    throw new Error("client capability decoy selected sibling action/target scope");
  }

  await writeAdmissionMode(admissionModePath, "mismatched");
  try {
    requireDenied(
      await controlCall(socketPath, token, "profiles"),
      "forbidden",
      "mixed edge-grant secret/principal tuple",
    );
    await waitForAdmissionEvidence({
      auditPath,
      mode: "mismatched",
      edgePrincipal: handoff.principals.sibling,
      edgeAuditId: handoff.principals.primary.auditId,
      capabilityPrincipal: handoff.principals.primary,
      action: "profiles",
      outcome: "denied_scope",
    });
  } finally {
    await writeAdmissionMode(admissionModePath, "primary");
  }
  requireOk(
    await controlCall(socketPath, token, "profiles"),
    "primary process edge after mixed tuple rejection",
  );

  await writeAdmissionMode(admissionModePath, "sibling");
  try {
    requireDenied(
      await controlCall(socketPath, token, "pages"),
      "forbidden",
      "sibling edge wrong action",
    );
    await waitForAdmissionEvidence({
      auditPath,
      mode: "sibling",
      edgePrincipal: handoff.principals.sibling,
      capabilityPrincipal: handoff.principals.sibling,
      action: "pages",
      outcome: "denied_scope",
    });
    requireDenied(
      await controlCall(
        socketPath,
        token,
        "open",
        { ref: formatNodeRef({ canvasName, nodeId: "personal-seed" }) },
      ),
      "forbidden",
      "sibling edge wrong target",
    );
  } finally {
    await writeAdmissionMode(admissionModePath, "primary");
  }

  const profiles = requireOk(
    await controlCall(socketPath, token, "profiles"),
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
    await controlCall(socketPath, token, "pages"),
    "pages",
  );
  if (
    !Array.isArray(pages) ||
    pages.length !== expectedRefs.size ||
    pages.some((page) => !isRecord(page) || !expectedRefs.has(String(page.ref)))
  ) {
    throw new Error("full capability did not expose exactly the five scoped page refs");
  }

  const initialSessions = requireOk(
    await controlCall(socketPath, token, "sessions"),
    "sessions",
  );
  if (!Array.isArray(initialSessions) || initialSessions.length !== 0) {
    throw new Error("new capability owner inherited browser sessions");
  }
};

const openProcessBoundPage = async (
  socketPath: string,
  token: string,
  canvasName: string,
  nodeId: string,
): Promise<string> => {
  const ref = formatNodeRef({ canvasName, nodeId });
  const data = requireOk(
    await controlCall(socketPath, token, "open", { ref }),
    `open ${ref}`,
  );
  if (!isRecord(data) || typeof data.sessionId !== "string") {
    throw new Error(`open ${ref}: response has no sessionId`);
  }
  return data.sessionId;
};

const qualifyCapabilityExpiry = async (options: {
  readonly socketPath: string;
  readonly token: string;
  readonly handoff: CapabilityHandoff;
  readonly canvasName: string;
  readonly fixtureOrigin: string;
  readonly customProtocolUrl: string;
  readonly auditPath: string;
  readonly admissionModePath: string;
}): Promise<void> => {
  if (options.handoff.expiringExpiresAt - Date.now() < 1_000) {
    throw new Error("short-TTL capability did not retain enough time for an in-flight use");
  }
  await writeAdmissionMode(options.admissionModePath, "expiring");
  try {
    const sessionId = await openProcessBoundPage(
      options.socketPath,
      options.token,
      options.canvasName,
      "personal-seed",
    );
    const report = await waitForReport(
      options.socketPath,
      options.token,
      sessionId,
    );
    assertContainment(report, options.fixtureOrigin, options.customProtocolUrl);

    const operation = beginNeverReturningEval(
      options.socketPath,
      options.token,
      sessionId,
    );
    await requireInFlight(operation, "capability expiry");
    await requireCancelled(operation, "capability expiry");

    const expiringPrincipal = options.handoff.principals.expiring;
    const matchesExpiringPrincipal = (event: {
      readonly principalId?: string;
      readonly jobId?: string;
      readonly auditId?: string;
    }): boolean =>
      event.principalId === expiringPrincipal.principalId &&
      event.jobId === expiringPrincipal.jobId &&
      event.auditId === expiringPrincipal.auditId;
    const audit = await waitForAudit(options.auditPath, (candidate) => {
      const exactEdgeAdmission = candidate.edgeAdmissions.some(
        (entry) => entry.mode === "expiring" && matchesExpiringPrincipal(entry),
      );
      const exactExpiry = candidate.capabilityEvents.some(
        (event) => event.outcome === "expired" && matchesExpiringPrincipal(event),
      );
      const exactInFlightAbort = candidate.capabilityEvents.some(
        (event) =>
          event.action === "eval" &&
          event.outcome === "aborted_expired" &&
          matchesExpiringPrincipal(event),
      );
      return (
        candidate.expiringCapabilityExpired &&
        candidate.currentWebContents === candidate.baselineWebContents &&
        exactEdgeAdmission &&
        exactExpiry &&
        exactInFlightAbort
      );
    });
    if (
      audit.createdWebContents.length !== 1 ||
      !Number.isSafeInteger(audit.expiringCapabilityDestroyedSessions) ||
      audit.expiringCapabilityDestroyedSessions < 0 ||
      audit.expiringCapabilityDestroyedSessions > 1 ||
      audit.browserWindows !== 0
    ) {
      throw new Error("capability expiry did not remove exactly its one managed session");
    }
    assertRuntimeDevToolsAbsent(audit, "capability expiry");
    requireDenied(
      await controlCall(options.socketPath, options.token, "sessions"),
      "unauthorized",
      "expired process edge authority",
    );
  } finally {
    await writeAdmissionMode(options.admissionModePath, "primary");
  }

  await writeAdmissionMode(options.admissionModePath, "sibling");
  try {
    const siblingSessions = requireOk(
      await controlCall(options.socketPath, options.token, "sessions"),
      "sibling authority after expiry",
    );
    if (!Array.isArray(siblingSessions) || siblingSessions.length !== 0) {
      throw new Error("expiring one capability contaminated a sibling owner namespace");
    }
  } finally {
    await writeAdmissionMode(options.admissionModePath, "primary");
  }
  requireOk(
    await controlCall(options.socketPath, options.token, "profiles"),
    "primary authority after sibling expiry",
  );
};

const openAndQualifySiblingOwner = async (
  socketPath: string,
  token: string,
  canvasName: string,
  fixtureOrigin: string,
  customProtocolUrl: string,
): Promise<string> => {
  const sessionId = await openProcessBoundPage(
    socketPath,
    token,
    canvasName,
    "work-read",
  );
  const report = await waitForReport(socketPath, token, sessionId);
  assertContainment(report, fixtureOrigin, customProtocolUrl);
  const sessions = requireOk(
    await controlCall(socketPath, token, "sessions"),
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
  readonly revokedSessionId: string;
  readonly siblingSessionId: string;
  readonly handoff: CapabilityHandoff;
  readonly auditPath: string;
  readonly revokeMarkerPath: string;
  readonly admissionModePath: string;
  readonly fixtureOrigin: string;
  readonly customProtocolUrl: string;
  readonly legacyTcpPort: number;
  readonly downloadsDir: string;
  readonly privateSentinelRequests: number;
  readonly popupRequests: number;
}): Promise<ProbeAudit> => {
  await writeAdmissionMode(options.admissionModePath, "primary");
  const operation = beginNeverReturningEval(
    options.socketPath,
    options.token,
    options.revokedSessionId,
  );
  await requireInFlight(operation, "explicit capability revocation");
  await writeFile(options.revokeMarkerPath, "revoke\n", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  const audit = await waitForAudit(
    options.auditPath,
    (candidate) =>
      candidate.capabilityRevoked &&
      candidate.revokedCapabilityDestroyedSessions > 0 &&
      candidate.currentWebContents === candidate.baselineWebContents + 1,
  );
  await requireCancelled(operation, "explicit capability revocation");
  if (audit.browserWindows !== 0) {
    throw new Error("capability revocation created an unmanaged BrowserWindow");
  }
  assertRuntimeDevToolsAbsent(audit, "explicit capability revocation");
  requireDenied(
    await controlCall(options.socketPath, options.token, "sessions"),
    "unauthorized",
    "revoked process edge authority",
  );

  await writeAdmissionMode(options.admissionModePath, "sibling");
  try {
    const siblingSessions = requireOk(
      await controlCall(options.socketPath, options.token, "sessions"),
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
      options.siblingSessionId,
    );
    assertContainment(report, options.fixtureOrigin, options.customProtocolUrl);
    await waitForAdmissionEvidence({
      auditPath: options.auditPath,
      mode: "sibling",
      edgePrincipal: options.handoff.principals.sibling,
      capabilityPrincipal: options.handoff.principals.sibling,
      action: "sessions",
      outcome: "admitted",
    });
  } finally {
    await writeAdmissionMode(options.admissionModePath, "primary");
  }
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
    (candidate) => candidate.createdWebContents.length >= 7,
  );
  if (
    audit.createdWebContents.length !== 7 ||
    audit.browserWindows !== 0 ||
    audit.currentWebContents > 3
  ) {
    throw new Error(
      `hostile popup created a transient or surviving unmanaged WebContents (${JSON.stringify(audit)})`,
    );
  }
  assertRuntimeDevToolsAbsent(audit, "hostile web policy audit");
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
  readonly auditPaths: ReadonlyArray<string>;
  readonly canvasDocumentJson: string;
  readonly electronArguments: ReadonlyArray<ReadonlyArray<string>>;
}): Promise<void> => {
  if (options.outputCapabilityLeak !== undefined) {
    throw new Error(`capability bearer leaked into Electron ${options.outputCapabilityLeak}`);
  }
  const persistedAudits: string[] = [];
  for (const path of options.auditPaths) {
    persistedAudits.push(await readFile(path, "utf8"));
  }
  const persistedAuditJson = persistedAudits.join("\n");
  assertSecretsAbsent(options.knownCapabilities, [
    ["Electron stdout", options.stdout],
    ["Electron stderr", options.stderr],
    ["probe audit JSON", persistedAuditJson],
    ["canvas document payload", options.canvasDocumentJson],
    ["Electron argv", JSON.stringify(options.electronArguments)],
    ["control response JSON", observedControlResponseJson.join("\n")],
  ]);
};

const main = async (): Promise<void> => {
  const sandbox = await createProbeSandbox(PROBE_TEMP_PREFIX);
  const root = sandbox.root;
  activeProbeSandbox = sandbox;
  const home = join(root, "home");
  const userData = join(root, "electron-user-data");
  const browserDir = join(root, "browser");
  const downloadsDir = join(root, "downloads");
  const auditPath = join(root, "electron-audit-launch-one.json");
  const restartAuditPath = join(root, "electron-audit-launch-two.json");
  const capabilityPath = join(root, "browser-capabilities-launch-one.json");
  const restartCapabilityPath = join(root, "browser-capabilities-launch-two.json");
  const revokeMarkerPath = join(root, "revoke-capability-launch-one.marker");
  const restartRevokeMarkerPath = join(root, "revoke-capability-launch-two.marker");
  const admissionModePath = join(root, "admission-mode");
  const shutdownRequestPath = join(root, "shutdown-launch-one.request");
  const restartShutdownRequestPath = join(root, "shutdown-launch-two.request");
  const markerPath = join(root, `host-marker-${randomUUID()}`);
  const nonce = randomUUID();
  const customProtocolUrl = `vellum-probe://denied/${nonce}`;
  const legacyTcpPort = await reserveLoopbackPort();
  await Promise.all(
    [home, userData, browserDir, downloadsDir].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  await writeAdmissionMode(admissionModePath, "primary");
  const terminalProbe = await launchDenialProbeClient(root, "terminal-peer");
  const unboundProbe = await launchDenialProbeClient(root, "unbound-peer");

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
  const canvasDocumentJson = JSON.stringify({
    nodes: [
      {
        id: "probe-agent",
        type: "text",
        text: "browser-containment-probe",
        x: 840,
        y: -180,
        width: 320,
        height: 96,
        ether: {
          entity: { kind: "agent", name: "browser-containment-probe" },
        },
      },
      ...pageTargets.map(({ nodeId, profile, url }, index) => ({
        id: nodeId,
        type: "link",
        url,
        x: index * 420,
        y: 0,
        width: 400,
        height: 300,
        ether: { entity: { kind: "page" }, browser: { profile } },
      })),
    ],
    edges: pageTargets.map(({ nodeId }, index) => ({
      id: `probe-edge-${index + 1}`,
      fromNode: "probe-agent",
      toNode: nodeId,
    })),
  });
  const canvasPayload = Buffer.from(canvasDocumentJson, "utf8").toString("base64url");

  probeStage = "dedicated Electron entry build";
  const dedicatedMainPath = await buildDedicatedElectronEntry(root);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    VELLUM_BROWSER_DIR: browserDir,
    VELLUM_CONTROL_TCP: `127.0.0.1:${legacyTcpPort}`,
  };
  delete env.ELECTRON_RENDERER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;

  const makeElectronArguments = (options: {
    readonly auditPath: string;
    readonly capabilityPath: string;
    readonly revokeMarkerPath: string;
    readonly admissionModePath: string;
    readonly shutdownRequestPath: string;
  }): string[] => [
      dedicatedMainPath,
      `--user-data-dir=${userData}`,
      `--fixture-origin=${origin}`,
      `--browser-root=${browserDir}`,
      `--control-home=${home}`,
      `--download-path=${downloadsDir}`,
      `--audit-path=${options.auditPath}`,
      `--capability-path=${options.capabilityPath}`,
      `--canvas-payload=${canvasPayload}`,
      `--revoke-marker-path=${options.revokeMarkerPath}`,
      `--admission-mode-path=${options.admissionModePath}`,
      `--shutdown-request-path=${options.shutdownRequestPath}`,
      `--peer-pid-helper-root=${join(repoRoot, "scripts")}`,
      `--terminal-peer-pid=${terminalProbe.pid}`,
      `--unbound-peer-pid=${unboundProbe.pid}`,
    ];
  const electronArguments = makeElectronArguments({
    auditPath,
    capabilityPath,
    revokeMarkerPath,
    admissionModePath,
    shutdownRequestPath,
  });
  if (
    electronArguments.some((argument) =>
      /^--(?:remote-debugging(?:-[a-z0-9-]+)?|inspect|inspect-brk)(?:=|$)/i.test(argument),
    )
  ) {
    throw new Error("dedicated Electron entry unexpectedly enabled CDP or inspector authority");
  }

  const firstLaunch = launchDedicatedElectron(
    electronArguments,
    env,
    shutdownRequestPath,
    auditPath,
    controlSocketPath(home),
  );
  let restartLaunch: ElectronLaunch | undefined;
  let knownCapabilities: string[] = [];
  let siblingSessionId: string | undefined;

  try {
    probeStage = "control startup";
    const { socketPath, token } = await waitForControl(home, firstLaunch.exited);
    probeStage = "capability handoff";
    const handoff = await waitForCapabilityHandoff(capabilityPath, firstLaunch.exited);
    const { capability, siblingCapability } = handoff;
    const launchOneCapabilities = [
      capability,
      handoff.expiringCapability,
      handoff.unrelatedCapability,
      siblingCapability,
    ];
    knownCapabilities = [token, ...launchOneCapabilities];
    firstLaunch.setKnownCapabilities(knownCapabilities);
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
    assertRuntimeDevToolsAbsent(baselineAudit, "first launch baseline");
    await assertTcpControlAbsent(legacyTcpPort, token);

    probeStage = "capability admission";
    await qualifyCapabilityAdmission(
      socketPath,
      token,
      handoff,
      canvasName,
      pageTargets,
      admissionModePath,
      auditPath,
    );

    probeStage = "terminal and unbound UDS denial";
    await writeAdmissionMode(admissionModePath, "terminal");
    requireDenied(
      await terminalProbe.client.request(socketPath, token),
      "unauthorized",
      "registered non-actor terminal peer",
    );
    await writeAdmissionMode(admissionModePath, "unbound");
    requireDenied(
      await unboundProbe.client.request(socketPath, token),
      "unauthorized",
      "unbound descendant peer",
    );
    await writeAdmissionMode(admissionModePath, "primary");
    await waitForAudit(
      auditPath,
      (audit) =>
        ["terminal", "unbound"].every((mode) =>
          audit.edgeDenials.some(
            (denial) =>
              denial.mode === mode &&
              denial.capabilityIssuesBefore === denial.capabilityIssuesAfter &&
              denial.webContentsBefore === denial.webContentsAfter,
          ),
        ),
    );

    probeStage = "short-TTL capability expiry";
    await qualifyCapabilityExpiry({
      socketPath,
      token,
      handoff,
      canvasName,
      fixtureOrigin: origin,
      customProtocolUrl,
      auditPath,
      admissionModePath,
    });

    const open = (nodeId: string): Promise<string> =>
      openProcessBoundPage(socketPath, token, canvasName, nodeId);

    const personalSeedSession = await open("personal-seed");
    const personalSeed = await waitForReport(socketPath, token, personalSeedSession);
    assertContainment(personalSeed, origin, customProtocolUrl);
    const afterFirstPageAudit = await waitForAudit(
      auditPath,
      (audit) => audit.createdWebContents.length >= 2,
    );
    if (
      afterFirstPageAudit.createdWebContents.length -
        afterFirstPageAudit.baselineWebContents !==
        2 ||
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
    const workRead = await waitForReport(socketPath, token, workReadSession);
    assertContainment(workRead, origin, customProtocolUrl);
    if (workRead.cookieValue !== null || workRead.storageValue !== null) {
      throw new Error("work profile observed personal profile state");
    }

    const timeoutPersonalSession = await open("filler-one");
    const timeoutPersonal = await waitForReport(
      socketPath,
      token,
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
      unaffectedWorkSession,
    );
    assertContainment(unaffectedBefore, origin, customProtocolUrl);
    const sessions = requireOk(
      await controlCall(socketPath, token, "sessions"),
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
    await startNeverReturningEval(socketPath, token, timeoutPersonalSession);
    probeStage = "hung eval session invalidation";
    await waitForSessionInvalidation(socketPath, token, timeoutPersonalSession);
    probeStage = "stale handle rejection";
    await assertStaleSessionRejected(socketPath, token, timeoutPersonalSession);

    probeStage = "owner-isolation capacity lane";
    await startNeverReturningEval(socketPath, token, workReadSession);
    await waitForSessionInvalidation(socketPath, token, workReadSession);

    await writeAdmissionMode(admissionModePath, "sibling");
    try {
      probeStage = "sibling owner isolation";
      siblingSessionId = await openAndQualifySiblingOwner(
        socketPath,
        token,
        canvasName,
        origin,
        customProtocolUrl,
      );
    } finally {
      await writeAdmissionMode(admissionModePath, "primary");
    }

    probeStage = "unaffected work session";
    const unaffectedAfter = await waitForReport(
      socketPath,
      token,
      unaffectedWorkSession,
    );
    assertContainment(unaffectedAfter, origin, customProtocolUrl);
    probeStage = "same-profile restoration";
    const personalRestoredSession = await open("personal-restored");
    const personalRestored = await waitForReport(
      socketPath,
      token,
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
      revokedSessionId: personalRestoredSession,
      siblingSessionId,
      handoff,
      auditPath,
      revokeMarkerPath,
      admissionModePath,
      fixtureOrigin: origin,
      customProtocolUrl,
      legacyTcpPort,
      downloadsDir,
      privateSentinelRequests,
      popupRequests,
    });

    probeStage = "first fixture shutdown";
    await stopLaunch(firstLaunch, "containment-first-fixture-complete");

    probeStage = "fresh process restart";
    await writeAdmissionMode(admissionModePath, "primary");
    const restartElectronArguments = makeElectronArguments({
      auditPath: restartAuditPath,
      capabilityPath: restartCapabilityPath,
      revokeMarkerPath: restartRevokeMarkerPath,
      admissionModePath,
      shutdownRequestPath: restartShutdownRequestPath,
    });
    if (
      restartElectronArguments.some((argument) =>
        /^--(?:remote-debugging(?:-[a-z0-9-]+)?|inspect|inspect-brk)(?:=|$)/i.test(argument),
      )
    ) {
      throw new Error("restarted Electron entry unexpectedly enabled CDP or inspector authority");
    }
    restartLaunch = launchDedicatedElectron(
      restartElectronArguments,
      env,
      restartShutdownRequestPath,
      restartAuditPath,
      controlSocketPath(home),
    );
    const restartControl = await waitForControl(home, restartLaunch.exited);
    if (restartControl.token === token) {
      throw new Error("fresh Electron process reused the previous control token");
    }
    const restartHandoff = await waitForCapabilityHandoff(
      restartCapabilityPath,
      restartLaunch.exited,
    );
    const restartCapabilities = [
      restartHandoff.capability,
      restartHandoff.expiringCapability,
      restartHandoff.unrelatedCapability,
      restartHandoff.siblingCapability,
    ];
    if (restartCapabilities.some((secret) => launchOneCapabilities.includes(secret))) {
      throw new Error("fresh Electron process reused a previous capability bearer");
    }
    knownCapabilities = [
      ...knownCapabilities,
      restartControl.token,
      ...restartCapabilities,
    ];
    firstLaunch.setKnownCapabilities(knownCapabilities);
    restartLaunch.setKnownCapabilities(knownCapabilities);
    const restartBaseline = await waitForAudit(
      restartAuditPath,
      (audit) => audit.ready,
    );
    if (
      restartBaseline.baselineWebContents !== 0 ||
      restartBaseline.currentWebContents !== 0 ||
      restartBaseline.createdWebContents.length !== 0 ||
      restartBaseline.browserWindows !== 0
    ) {
      throw new Error("fresh Electron process did not start from an empty WebContents baseline");
    }
    assertRuntimeDevToolsAbsent(restartBaseline, "fresh process baseline");

    requireDenied(
      await controlCall(
        restartControl.socketPath,
        token,
        "doctor",
      ),
      "unauthorized",
      "previous launch control token",
    );
    for (const staleCapability of launchOneCapabilities) {
      const sessionsWithStaleDecoy = requireOk(
        await controlCall(
          restartControl.socketPath,
          restartControl.token,
          "sessions",
          undefined,
          { retiredCapabilityDecoy: staleCapability },
        ),
        "previous launch capability decoy",
      );
      if (!Array.isArray(sessionsWithStaleDecoy) || sessionsWithStaleDecoy.length !== 0) {
        throw new Error("previous launch client decoy changed fresh process-bound scope");
      }
    }
    requireDenied(
      await controlCall(
        restartControl.socketPath,
        token,
        "sessions",
        undefined,
        { retiredCapabilityDecoy: restartHandoff.siblingCapability },
      ),
      "unauthorized",
      "fresh capability with previous launch token",
    );

    await writeAdmissionMode(admissionModePath, "sibling");
    const restartSiblingSession = await openProcessBoundPage(
      restartControl.socketPath,
      restartControl.token,
      canvasName,
      "work-read",
    );
    const restartSiblingReport = await waitForReport(
      restartControl.socketPath,
      restartControl.token,
      restartSiblingSession,
    );
    assertContainment(restartSiblingReport, origin, customProtocolUrl);
    const restartActiveAudit = await waitForAudit(
      restartAuditPath,
      (audit) =>
        audit.createdWebContents.length === 1 &&
        audit.currentWebContents === audit.baselineWebContents + 1,
    );
    if (restartActiveAudit.browserWindows !== 0) {
      throw new Error("fresh authority created an unmanaged BrowserWindow");
    }
    assertRuntimeDevToolsAbsent(restartActiveAudit, "fresh authority use");
    await waitForAdmissionEvidence({
      auditPath: restartAuditPath,
      mode: "sibling",
      edgePrincipal: restartHandoff.principals.sibling,
      capabilityPrincipal: restartHandoff.principals.sibling,
      action: "open",
      outcome: "admitted",
    });
    await assertTcpControlAbsent(legacyTcpPort, restartControl.token);

    probeStage = "second fixture shutdown";
    await stopLaunch(restartLaunch, "containment-second-fixture-complete");

    probeStage = "capability non-disclosure";
    const firstOutput = firstLaunch.output();
    const restartOutput = restartLaunch.output();
    await qualifyCapabilityNonDisclosure({
      outputCapabilityLeak: firstOutput.capabilityLeak ?? restartOutput.capabilityLeak,
      knownCapabilities,
      stdout: `${firstOutput.stdout}\n${restartOutput.stdout}`,
      stderr: `${firstOutput.stderr}\n${restartOutput.stderr}`,
      auditPaths: [auditPath, restartAuditPath],
      canvasDocumentJson,
      electronArguments: [electronArguments, restartElectronArguments],
    });

    successfulProbeOutput = JSON.stringify({
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
        replayIdentityRequired: true,
        processBoundEdgeAuthorityAdmitted: true,
        terminalAndUnboundPeersDeniedBeforeCapabilityOrViewCreation: true,
        realPeerPidAndFiveCanvasEdgesQualified: true,
        processBoundRequestCarriedNoIdentityClaim: true,
        clientCapabilityHeadersIgnored: true,
        exactPrincipalTupleEnforced: true,
        wrongActionAndTargetDenied: true,
        fullFivePageEdgeScopeAdmitted: true,
        freshRequestIdPerProtectedCall: true,
        shortTtlExpiryCancelsInFlightUse: true,
        expiryDestroysExactOwnerSessions: true,
        siblingAuthoritySurvivesExpiry: true,
        edgeLeaseRevocationEnforced: true,
        explicitRevocationCancelsInFlightUse: true,
        siblingOwnerSurvivesRevocation: true,
        freshProcessRotatesControlToken: true,
        previousControlTokenRejectedAndClientBearerIgnored: true,
        freshProcessAuthorityUsable: true,
        capabilityAbsentFromArtifactsAndLogs: true,
        tcpListenerAbsent: true,
        runtimeDebugAuthorityAbsent: true,
        popupAndNewWebContentsDenied: true,
        permissionsDeniedWithoutPagePrompt: true,
        downloadBlockedWithoutFile: true,
        customProtocolNotDispatched: true,
        privateLoopbackSentinelUnreached: true,
        dedicatedEntryBuiltHermetically: true,
        cleanControlDrainBeforeProcessExit: true,
      },
    });
  } catch (error) {
    const firstOutput = firstLaunch.output();
    const restartOutput = restartLaunch?.output();
    const combinedStdout = [firstOutput.stdout, restartOutput?.stdout ?? ""].join("\n");
    const combinedStderr = [firstOutput.stderr, restartOutput?.stderr ?? ""].join("\n");
    console.error(
      JSON.stringify({
        ok: false,
        stage: probeStage,
        error: redactKnownSecrets(
          error instanceof Error ? error.message : String(error),
          knownCapabilities,
        ),
        stdout: redactKnownSecrets(combinedStdout, knownCapabilities),
        stderr: redactKnownSecrets(combinedStderr, knownCapabilities),
      }),
    );
    if (!watchdogExitRequested) process.exitCode = 2;
  } finally {
    let cleanupFailed = false;
    probeStage = "cleanup children";
    for (const [launch, reason] of [
      [restartLaunch, "containment-restart-finalize"],
      [firstLaunch, "containment-first-finalize"],
    ] as const) {
      if (launch === undefined) continue;
      try {
        await stopLaunch(launch, reason);
      } catch (error) {
        cleanupFailed = true;
        console.error(error instanceof Error ? error.message : String(error));
      }
    }
    probeStage = "cleanup fixture server";
    server.closeAllConnections();
    await Promise.race([closeServer(server), delay(2_000)]);
    probeStage = "cleanup sentinel server";
    sentinelServer.closeAllConnections();
    await Promise.race([closeServer(sentinelServer), delay(2_000)]);
    probeStage = "verify process group drain";
    const drainReceipt = await probeSupervisor.shutdown(
      "containment-probe-finalize",
    );
    if (!drainReceipt.clean) cleanupFailed = true;
    const removed = await removeProbeSandboxIfClean({
      sandbox,
      receipt: drainReceipt,
      label: "Electron containment probe",
    });
    if (removed && activeProbeSandbox === sandbox) {
      activeProbeSandbox = undefined;
    }
    if (activeProbeServer === server) activeProbeServer = undefined;
    if (activeSentinelServer === sentinelServer) activeSentinelServer = undefined;
    if (cleanupFailed && !watchdogExitRequested && (process.exitCode ?? 0) === 0) {
      process.exitCode = 2;
    }
    normalCleanupCompleted = true;
  }
};

const watchdog = setTimeout(() => {
  watchdogExitRequested = true;
  console.error(
    JSON.stringify({
      ok: false,
      error: `Electron containment probe exceeded ${PROBE_RUNTIME_TIMEOUT_MS}ms during ${probeStage}`,
    }),
  );
  void (async () => {
    const drainReceipt = await probeSupervisor.shutdown(
      "containment-probe-watchdog",
    );
    try {
      activeProbeServer?.closeAllConnections();
      activeProbeServer?.close();
      activeSentinelServer?.closeAllConnections();
      activeSentinelServer?.close();
    } catch {
      // Watchdog cleanup is best effort; process termination is the final bound.
    }
    const sandbox = activeProbeSandbox;
    if (sandbox !== undefined) {
      await removeProbeSandboxIfClean({
        sandbox,
        receipt: drainReceipt,
        label: "Electron containment probe watchdog",
      }).catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        return false;
      });
    }
    process.exitCode = 124;
  })();
}, PROBE_RUNTIME_TIMEOUT_MS);
watchdog.unref();
try {
  await main();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    stage: probeStage,
    error: error instanceof Error ? error.message : String(error),
  }));
  if (!watchdogExitRequested) process.exitCode = 2;
} finally {
  clearTimeout(watchdog);
  const finalReceipt = await probeSupervisor.shutdown(
    "containment-probe-top-level-finalize",
  );
  if (!normalCleanupCompleted) {
    for (const server of [activeProbeServer, activeSentinelServer]) {
      if (server === undefined) continue;
      server.closeAllConnections();
      await Promise.race([closeServer(server), delay(2_000)]).catch(() => undefined);
    }
    if (activeProbeSandbox !== undefined) {
      const removed = await removeProbeSandboxIfClean({
        sandbox: activeProbeSandbox,
        receipt: finalReceipt,
        label: "Electron containment top-level cleanup",
      });
      if (removed) activeProbeSandbox = undefined;
    }
  }
  if (!finalReceipt.clean && !watchdogExitRequested && (process.exitCode ?? 0) === 0) {
    process.exitCode = 2;
  }
  if (
    successfulProbeOutput !== undefined &&
    finalReceipt.clean &&
    !watchdogExitRequested &&
    (process.exitCode ?? 0) === 0
  ) {
    console.log(successfulProbeOutput);
  }
}
