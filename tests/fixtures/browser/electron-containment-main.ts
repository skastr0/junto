import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { url as inspectorUrl } from "node:inspector";
import { basename, dirname, isAbsolute, join } from "node:path";
import { app, BrowserWindow, session, webContents } from "electron";
import { Effect, Result, Layer, ManagedRuntime } from "effect";
import { CanvasesLive, CanvasesService } from "../../../src/main/vellum/canvases";
import {
  makeStateEngineLive,
  StateEngine,
} from "../../../src/main/vellum/state/engine";
import { WorkRepositoryLive } from "../../../src/main/vellum/work/repository";
import {
  BROWSER_CAPABILITY_ACTIONS,
  makeBrowserCapabilityRegistry,
  type BrowserAutomationPrincipal,
  type BrowserCapabilityAuditOutcome,
  type BrowserCapabilityRegistry,
} from "../../../src/main/vellum/browser/capabilities";
import {
  makeEdgeGrantService,
  type EdgeGrantResult,
  type EdgeGrantService,
} from "../../../src/main/vellum/browser/edge-grant";
import { startBrowserControlServer, type BrowserControlServer } from "../../../src/main/vellum/browser/control";
import { makePageTargetResolver } from "../../../src/main/vellum/browser/page-target";
import { makeBrowserProfileService } from "../../../src/main/vellum/browser/profiles";
import { BrowserSessionService } from "../../../src/main/vellum/browser/sessions";
import { admitBrowserHostCapability } from "../../../src/main/vellum/browser/host-capability";
import { makeBrowserTestOnlyElectronHarness } from "../../../src/main/vellum/browser/view-adapter";
import { isManagedBrowserWebContents } from "../../../src/main/vellum/browser/web-policy";
import {
  configurePeerPidHelperRoots,
  makeProcessIdentityMap,
  readParentPid,
  type ProcessPrincipal,
} from "../../../src/main/vellum/process-identity";
import { formatNodeRef } from "../../../src/shared/node-ref";
import { partitionNameForProfile } from "../../../src/shared/browser";
import { decodeCanvasDoc } from "../../../src/shared/canvas";
import { LOCAL_BROWSER_TEST_AUTHORITY } from "../../browser-host-test-authority";

app.commandLine.appendSwitch("no-proxy-server");

const requiredArgument = (name: string): string => {
  const prefix = `--${name}=`;
  const values = process.argv
    .filter((argument) => argument.startsWith(prefix))
    .map((argument) => argument.slice(prefix.length));
  if (values.length !== 1 || values[0] === "") {
    throw new Error(`dedicated browser probe requires exactly one ${prefix}<value>`);
  }
  return values[0];
};

const exactOrigin = requiredArgument("fixture-origin");
const browserRoot = requiredArgument("browser-root");
const controlHome = requiredArgument("control-home");
const downloadPath = requiredArgument("download-path");
const auditPath = requiredArgument("audit-path");
const capabilityPath = requiredArgument("capability-path");
const canvasPayload = requiredArgument("canvas-payload");
const revokeMarkerPath = requiredArgument("revoke-marker-path");
const admissionModePath = requiredArgument("admission-mode-path");
const shutdownRequestPath = requiredArgument("shutdown-request-path");
const peerPidHelperRoot = requiredArgument("peer-pid-helper-root");
const terminalPeerPid = Number(requiredArgument("terminal-peer-pid"));
const unboundPeerPid = Number(requiredArgument("unbound-peer-pid"));

for (const [name, path] of [
  ["browser-root", browserRoot],
  ["control-home", controlHome],
  ["download-path", downloadPath],
  ["audit-path", auditPath],
  ["capability-path", capabilityPath],
  ["revoke-marker-path", revokeMarkerPath],
  ["admission-mode-path", admissionModePath],
  ["shutdown-request-path", shutdownRequestPath],
  ["peer-pid-helper-root", peerPidHelperRoot],
] as const) {
  if (!isAbsolute(path)) throw new Error(`${name} must be absolute`);
}
for (const [name, pid] of [
  ["terminal-peer-pid", terminalPeerPid],
  ["unbound-peer-pid", unboundPeerPid],
] as const) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`${name} must be a live pid`);
}
configurePeerPidHelperRoots([peerPidHelperRoot]);

const canvasName = "browser-containment";
const makeCanvasRuntime = () => {
  const stateLive = makeStateEngineLive(
    join(controlHome, ".vellum", "state", "vellum.db"),
  );
  const repositoriesLive = Layer.provideMerge(WorkRepositoryLive, stateLive);
  return ManagedRuntime.make(
    Layer.provideMerge(CanvasesLive, repositoriesLive),
  );
};
const capabilityTargets = [
  { nodeId: "personal-seed", profile: "personal" },
  { nodeId: "work-read", profile: "work" },
  { nodeId: "filler-one", profile: "personal" },
  { nodeId: "filler-two", profile: "work" },
  { nodeId: "personal-restored", profile: "personal" },
].map(({ nodeId, profile }) => ({
  ref: formatNodeRef({ canvasName, nodeId }),
  hostId: "local",
  profile,
  exactOrigins: [exactOrigin],
}));
const siblingCapabilityTarget = capabilityTargets.find(
  (target) => target.ref === formatNodeRef({ canvasName, nodeId: "work-read" }),
);
if (siblingCapabilityTarget === undefined) {
  throw new Error("dedicated browser probe sibling target is missing");
}

type AdmitMode =
  | "process-bound"
  | "primary"
  | "expiring"
  | "sibling"
  | "mismatched"
  | "terminal"
  | "unbound";

type AdmissionAuthorityPath = "unix-peer-pid+process-map+canvas-edges" | "fixture-tuple";

interface AdmissionTuple {
  readonly secret: string;
  readonly expectedPrincipal: BrowserAutomationPrincipal;
  readonly auditId: string;
  readonly targetCount: number;
}

interface EdgeAdmissionAudit {
  readonly sequence: number;
  readonly mode: AdmitMode;
  readonly authorityPath: AdmissionAuthorityPath;
  readonly principalId: string;
  readonly jobId: string;
  readonly auditId: string;
  readonly targetCount: number;
}

const readAdmitMode = async (modePath: string): Promise<AdmitMode> => {
  try {
    const raw = (await readFile(modePath, "utf8")).trim();
    if (
      raw === "process-bound" ||
      raw === "primary" ||
      raw === "expiring" ||
      raw === "sibling" ||
      raw === "mismatched" ||
      raw === "terminal" ||
      raw === "unbound"
    ) {
      return raw;
    }
  } catch {
    // Missing or unreadable mode files default to primary admission.
  }
  return "primary";
};

const admittingEdgeGrant = (
  tuples: Readonly<Record<Exclude<AdmitMode, "terminal" | "unbound">, AdmissionTuple>>,
  processBoundEdgeGrant: EdgeGrantService,
  admitModePath: string,
  onAdmission: (entry: EdgeAdmissionAudit) => void,
  onDenial: (mode: "terminal" | "unbound", result: Extract<EdgeGrantResult, { readonly ok: false }>) => void,
  probePeerPid: number,
  processBoundPrincipal: ProcessPrincipal,
): EdgeGrantService => {
  const recordProcessBoundAdmission = (
    result: Extract<EdgeGrantResult, { readonly ok: true }>,
  ): void => {
    const expected = tuples["process-bound"];
    if (
      result.secret !== expected.secret ||
      result.expectedPrincipal !== expected.expectedPrincipal ||
      result.targetCount !== expected.targetCount
    ) {
      throw new Error("process-bound edge admission did not reuse its exact warmed grant");
    }
    onAdmission({
      sequence: 0,
      mode: "process-bound",
      authorityPath: "unix-peer-pid+process-map+canvas-edges",
      principalId: result.expectedPrincipal.principalId,
      jobId: result.expectedPrincipal.jobId,
      auditId: expected.auditId,
      targetCount: result.targetCount,
    });
  };

  const admitTuple = async (mode: Exclude<AdmitMode, "process-bound" | "terminal" | "unbound">) => {
    const tuple = tuples[mode];
    onAdmission({
      sequence: 0,
      mode,
      authorityPath: "fixture-tuple",
      principalId: tuple.expectedPrincipal.principalId,
      jobId: tuple.expectedPrincipal.jobId,
      auditId: tuple.auditId,
      targetCount: tuple.targetCount,
    });
    return {
      ok: true as const,
      secret: tuple.secret,
      expectedPrincipal: tuple.expectedPrincipal,
      principal: { kind: "agent" as const, agentKey: "browser-containment-probe" },
      targetCount: tuple.targetCount,
    };
  };

  return {
    processMap: processBoundEdgeGrant.processMap,
    admitSocket: async (socket) => {
      const mode = await readAdmitMode(admitModePath);
      if (mode === "terminal" || mode === "unbound") {
        if (mode === "unbound") processBoundEdgeGrant.processMap.unbind(probePeerPid);
        try {
          const result = await processBoundEdgeGrant.admitSocket(socket);
          if (result.ok) throw new Error(`${mode} peer unexpectedly received browser authority`);
          onDenial(mode, result);
          return result;
        } finally {
          if (mode === "unbound" && !processBoundEdgeGrant.processMap.bind(probePeerPid, processBoundPrincipal)) {
            throw new Error("dedicated browser probe could not restore its live process binding");
          }
        }
      }
      if (mode !== "process-bound") {
        return admitTuple(mode as Exclude<AdmitMode, "process-bound" | "terminal" | "unbound">);
      }
      const result = await processBoundEdgeGrant.admitSocket(socket);
      if (result.ok) recordProcessBoundAdmission(result);
      return result;
    },
    admitPrincipal: async (principal) => {
      const mode = await readAdmitMode(admitModePath);
      if (mode !== "process-bound" && mode !== "terminal" && mode !== "unbound") {
        return admitTuple(mode);
      }
      if (mode === "terminal" || mode === "unbound") {
        return processBoundEdgeGrant.admitPrincipal(principal);
      }
      const result = await processBoundEdgeGrant.admitPrincipal(principal);
      if (result.ok) recordProcessBoundAdmission(result);
      return result;
    },
    clear: () => processBoundEdgeGrant.clear(),
    invalidateCanvas: (canvas, detail) =>
      processBoundEdgeGrant.invalidateCanvas(canvas, detail),
    lastRevocationReceipts: () => processBoundEdgeGrant.lastRevocationReceipts(),
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

const writeCapabilityHandoff = async (handoff: CapabilityHandoff): Promise<void> => {
  const temporary = `${capabilityPath}.${randomUUID()}.tmp`;
  await mkdir(dirname(capabilityPath), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(handoff)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, capabilityPath);
};

interface ProbeAudit {
  baselineWebContents: number;
  currentWebContents: number;
  maximumWebContents: number;
  browserWindows: number;
  createdWebContents: Array<{ readonly id: number; readonly type: string }>;
  externalProtocolDispatches: string[];
  capabilityRevoked: boolean;
  revokedCapabilityDestroyedSessions: number;
  expiringCapabilityExpired: boolean;
  expiringCapabilityDestroyedSessions: number;
  remoteDebuggingSwitchPresent: boolean;
  mainInspectorActive: boolean;
  managedDevToolsOpenEvents: number;
  managedDevToolsCurrentlyOpen: number;
  defaultProxyResolution: string;
  profileProxyResolution: string;
  edgeAdmissions: EdgeAdmissionAudit[];
  edgeDenials: Array<{
    readonly mode: "terminal" | "unbound";
    readonly denial: string;
    readonly capabilityIssuesBefore: number;
    readonly capabilityIssuesAfter: number;
    readonly webContentsBefore: number;
    readonly webContentsAfter: number;
  }>;
  capabilityEvents: Array<{
    readonly sequence: number;
    readonly outcome: BrowserCapabilityAuditOutcome;
    readonly principalId?: string;
    readonly jobId?: string;
    readonly auditId?: string;
    readonly action?: string;
  }>;
  shutdownRequested: boolean;
  shutdownControlClean: boolean;
  shutdownRetainedLabels: string[];
  shutdownCompleted: boolean;
  ready: boolean;
}

const audit: ProbeAudit = {
  baselineWebContents: 0,
  currentWebContents: 0,
  maximumWebContents: 0,
  browserWindows: 0,
  createdWebContents: [],
  externalProtocolDispatches: [],
  capabilityRevoked: false,
  revokedCapabilityDestroyedSessions: 0,
  expiringCapabilityExpired: false,
  expiringCapabilityDestroyedSessions: 0,
  remoteDebuggingSwitchPresent: false,
  mainInspectorActive: false,
  managedDevToolsOpenEvents: 0,
  managedDevToolsCurrentlyOpen: 0,
  defaultProxyResolution: "",
  profileProxyResolution: "",
  edgeAdmissions: [],
  edgeDenials: [],
  capabilityEvents: [],
  shutdownRequested: false,
  shutdownControlClean: false,
  shutdownRetainedLabels: [],
  shutdownCompleted: false,
  ready: false,
};
let auditTail: Promise<void> = Promise.resolve();
const MAX_SECURITY_AUDIT_EVENTS = 512;
let nextEdgeAdmissionSequence = 0;

const recordEdgeAdmission = (entry: EdgeAdmissionAudit): void => {
  audit.edgeAdmissions.push({
    ...entry,
    sequence: ++nextEdgeAdmissionSequence,
  });
  if (audit.edgeAdmissions.length > MAX_SECURITY_AUDIT_EVENTS) {
    audit.edgeAdmissions.splice(
      0,
      audit.edgeAdmissions.length - MAX_SECURITY_AUDIT_EVENTS,
    );
  }
  // Registry preflight/authorization runs after EdgeGrant resolves. Capture its
  // secret-free audit on the following event-loop turn.
  setImmediate(() => {
    void persistAudit();
  });
};

const recordEdgeDenial = (
  mode: "terminal" | "unbound",
  result: Extract<EdgeGrantResult, { readonly ok: false }>,
): void => {
  const capabilityIssuesBefore = capabilities?.auditSnapshot().filter((event) => event.outcome === "issued").length ?? 0;
  const webContentsBefore = webContents.getAllWebContents().length;
  setImmediate(() => {
    const capabilityIssuesAfter = capabilities?.auditSnapshot().filter((event) => event.outcome === "issued").length ?? 0;
    const webContentsAfter = webContents.getAllWebContents().length;
    audit.edgeDenials.push({
      mode,
      denial: result.denial,
      capabilityIssuesBefore,
      capabilityIssuesAfter,
      webContentsBefore,
      webContentsAfter,
    });
    if (audit.edgeDenials.length > MAX_SECURITY_AUDIT_EVENTS) audit.edgeDenials.shift();
    void persistAudit();
  });
};

const persistAudit = (): Promise<void> => {
  const allWebContents = webContents.getAllWebContents();
  audit.currentWebContents = allWebContents.length;
  audit.maximumWebContents = Math.max(audit.maximumWebContents, audit.currentWebContents);
  audit.browserWindows = BrowserWindow.getAllWindows().length;
  audit.remoteDebuggingSwitchPresent =
    process.argv.some((argument) => argument.startsWith("--remote-debugging-")) ||
    app.commandLine.hasSwitch("remote-debugging-port") ||
    app.commandLine.hasSwitch("remote-debugging-pipe");
  try {
    audit.mainInspectorActive = inspectorUrl() !== undefined;
  } catch {
    // A failed active check is not evidence of absence.
    audit.mainInspectorActive = true;
  }
  audit.managedDevToolsCurrentlyOpen = allWebContents.filter((contents) => {
    if (!isManagedBrowserWebContents(contents)) return false;
    try {
      return contents.isDevToolsOpened();
    } catch {
      // A failed active check is not evidence of absence.
      return true;
    }
  }).length;
  audit.capabilityEvents = (capabilities?.auditSnapshot() ?? [])
    .slice(-MAX_SECURITY_AUDIT_EVENTS)
    .map((event) => ({
      sequence: event.sequence,
      outcome: event.outcome,
      ...(event.principalId === undefined ? {} : { principalId: event.principalId }),
      ...(event.jobId === undefined ? {} : { jobId: event.jobId }),
      ...(event.auditId === undefined ? {} : { auditId: event.auditId }),
      ...(event.action === undefined ? {} : { action: event.action }),
    }));
  const snapshot = `${JSON.stringify(audit)}\n`;
  const temporary = `${auditPath}.${randomUUID()}.tmp`;
  auditTail = auditTail.then(async () => {
    await mkdir(dirname(auditPath), { recursive: true });
    await writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, auditPath);
  });
  return auditTail;
};

app.on("web-contents-created", (_event, contents) => {
  audit.createdWebContents.push({ id: contents.id, type: contents.getType() });
  contents.on("devtools-opened", () => {
    if (!isManagedBrowserWebContents(contents)) return;
    audit.managedDevToolsOpenEvents += 1;
    void persistAudit();
  });
  contents.once("destroyed", () => {
    void persistAudit();
  });
  setImmediate(() => {
    void persistAudit();
  });
});

// A prevented custom-scheme navigation must never return through OS protocol
// dispatch. Tracking this event makes a transient dispatch observable even if
// the hostile page itself remains alive.
app.on("open-url", (event, url) => {
  event.preventDefault();
  audit.externalProtocolDispatches.push(url);
  void persistAudit();
});

app.on(
  "select-client-certificate",
  (event, contents, _url, _certificateList, callback) => {
    if (!isManagedBrowserWebContents(contents)) return;
    event.preventDefault();
    callback();
  },
);

let control: BrowserControlServer | undefined;
let sessions: BrowserSessionService | undefined;
let capabilities: BrowserCapabilityRegistry | undefined;
let unrelatedCapabilities: BrowserCapabilityRegistry | undefined;
let revocationWatcher: ReturnType<typeof setInterval> | undefined;
let primaryCapabilityAuditId: string | undefined;
let expiringCapabilityAuditId: string | undefined;
let shutdownFlight: Promise<void> | undefined;
let shutdownRequestWatcher: FSWatcher | undefined;
let canvasRuntime: ReturnType<typeof makeCanvasRuntime> | undefined;

const beginFixtureShutdown = (): Promise<void> => {
  if (shutdownFlight !== undefined) return shutdownFlight;
  const flight = Promise.resolve().then(async () => {
    audit.shutdownRequested = true;
    shutdownRequestWatcher?.close();
    shutdownRequestWatcher = undefined;
    console.error(
      `[browser-containment] shutdown begin control=${control !== undefined} sessions=${
        sessions !== undefined
      } capabilities=${capabilities !== undefined}`,
    );
    if (revocationWatcher !== undefined) clearInterval(revocationWatcher);
    control?.beginShutdown();
    const controlReceipt = await control?.drainOnQuit();
    capabilities?.close();
    unrelatedCapabilities?.close();
    sessions?.detachAllOnQuit("browser containment probe");
    await canvasRuntime?.dispose();
    canvasRuntime = undefined;
    if (controlReceipt === undefined) {
      throw new Error("browser control was not started before fixture shutdown");
    }
    audit.shutdownControlClean = controlReceipt.clean;
    audit.shutdownRetainedLabels = [...controlReceipt.retainedLabels];
    audit.shutdownCompleted = controlReceipt.clean;
    await persistAudit();
    if (!controlReceipt.clean) {
      throw new Error(
        `browser control drain retained ${controlReceipt.retainedLabels.join(",")}`,
      );
    }
    console.error("[browser-containment] shutdown clean");
  });
  shutdownFlight = flight;
  return flight;
};

const exitAfterFixtureShutdown = (): void => {
  void beginFixtureShutdown().then(
    () => app.exit(0),
    (error) => {
      console.error(
        `[browser-containment] shutdown failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      app.exit(2);
    },
  );
};

app.on("before-quit", (event) => {
  event.preventDefault();
  exitAfterFixtureShutdown();
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, exitAfterFixtureShutdown);
}

shutdownRequestWatcher = watch(dirname(shutdownRequestPath), (_event, filename) => {
  if (filename === basename(shutdownRequestPath)) exitAfterFixtureShutdown();
});
shutdownRequestWatcher.on("error", (error) => {
  console.error(`[browser-containment] shutdown watcher failed: ${error.message}`);
  app.exit(2);
});
// Close the race between directory watcher installation and the first event.
void access(shutdownRequestPath).then(exitAfterFixtureShutdown, () => undefined);

void app.whenReady().then(async () => {
  const proxyProbeUrl = "https://vellum-direct-network-probe.invalid/";
  [audit.defaultProxyResolution, audit.profileProxyResolution] = await Promise.all([
    session.defaultSession.resolveProxy(proxyProbeUrl),
    session.fromPartition(partitionNameForProfile("personal")).resolveProxy(proxyProbeUrl),
  ]);
  await mkdir(downloadPath, { recursive: true });
  audit.baselineWebContents = webContents.getAllWebContents().length;
  audit.currentWebContents = audit.baselineWebContents;
  audit.maximumWebContents = audit.baselineWebContents;
  await persistAudit();

  const activeCanvasRuntime = makeCanvasRuntime();
  canvasRuntime = activeCanvasRuntime;
  const state = await activeCanvasRuntime.runPromise(StateEngine);
  const harness = makeBrowserTestOnlyElectronHarness(exactOrigin, downloadPath);
  const profiles = makeBrowserProfileService(state, browserRoot);
  sessions = new BrowserSessionService(
    harness.adapter,
    LOCAL_BROWSER_TEST_AUTHORITY,
    profiles,
    Date.now,
    randomUUID,
    harness.targetAdmission,
  );
  const canvases = await activeCanvasRuntime.runPromise(CanvasesService);
  const fixtureCanvas = decodeCanvasDoc(
    JSON.parse(Buffer.from(canvasPayload, "base64url").toString("utf8")),
  );
  if (Result.isFailure(fixtureCanvas)) {
    throw new Error(
      `dedicated browser probe canvas is invalid: ${fixtureCanvas.failure.message}`,
    );
  }
  await activeCanvasRuntime.runPromise(
    canvases.write(canvasName, fixtureCanvas.success),
  );
  const listCanvasDocuments = async () =>
    (await activeCanvasRuntime.runPromise(canvases.liveDocuments())).map(
      ({ canvasName: name, doc }) => ({ name, doc }),
    );
  const resolvePageTarget = makePageTargetResolver(canvases);
  capabilities = makeBrowserCapabilityRegistry({
    onTerminate: (notice) => {
      const destroyedSessions =
        sessions?.destroyOwnerSessions(notice.auditId, "browser containment capability ended") ?? 0;
      if (notice.auditId === primaryCapabilityAuditId && notice.reason === "revoked_operator") {
        audit.revokedCapabilityDestroyedSessions = destroyedSessions;
      }
      if (notice.auditId === expiringCapabilityAuditId && notice.reason === "expired") {
        audit.expiringCapabilityExpired = true;
        audit.expiringCapabilityDestroyedSessions = destroyedSessions;
      }
      void persistAudit();
    },
  });
  unrelatedCapabilities = makeBrowserCapabilityRegistry();

  const principal = capabilities.createPrincipal();
  const grant = capabilities.issue(principal, {
    actions: BROWSER_CAPABILITY_ACTIONS,
    targets: capabilityTargets,
    ttlMs: 5 * 60_000,
    maxUses: 512,
    maxInFlight: 4,
  });
  primaryCapabilityAuditId = grant.auditId;
  const expiringPrincipal = capabilities.createPrincipal();
  const expiringGrant = capabilities.issue(expiringPrincipal, {
    actions: ["open", "sessions", "eval"],
    targets: [capabilityTargets[0]!],
    ttlMs: 6_000,
    maxUses: 16,
    maxInFlight: 2,
  });
  expiringCapabilityAuditId = expiringGrant.auditId;
  const siblingPrincipal = capabilities.createPrincipal();
  const siblingGrant = capabilities.issue(siblingPrincipal, {
    actions: ["open", "sessions", "eval"],
    targets: [siblingCapabilityTarget],
    ttlMs: 5 * 60_000,
    maxUses: 128,
    maxInFlight: 4,
  });
  const unrelatedPrincipal = unrelatedCapabilities.createPrincipal();
  const unrelatedGrant = unrelatedCapabilities.issue(unrelatedPrincipal, {
    actions: BROWSER_CAPABILITY_ACTIONS,
    targets: capabilityTargets,
    ttlMs: 5 * 60_000,
    maxUses: 128,
    maxInFlight: 4,
  });

  // The dedicated Electron binary is launched by node_modules/electron/cli.js,
  // whose parent is this probe. Register that observed, live launcher process
  // in the same main-owned map production uses for ACP/herdr children. No PID,
  // node ref, host, or capability is accepted from a control request.
  const probePeerPid = readParentPid(process.ppid);
  if (probePeerPid === undefined) {
    throw new Error("dedicated browser probe could not resolve its live launcher process");
  }
  const processBoundPrincipal: ProcessPrincipal = Object.freeze({ agentKey: "browser-containment-probe",
    canvasName,
    nodeId: "probe-agent",
  });
  const processMap = makeProcessIdentityMap();
  if (!processMap.bind(probePeerPid, processBoundPrincipal)) {
    throw new Error("dedicated browser probe could not register its live launcher process");
  }
  if (!processMap.bind(terminalPeerPid, { bindingId: "browser-containment-terminal-peer",
    canvasName,
    nodeId: "probe-terminal",
  })) {
    throw new Error("dedicated browser probe could not register its live terminal peer");
  }
  if (processMap.resolve(unboundPeerPid) !== undefined) {
    throw new Error("dedicated browser probe unbound peer unexpectedly had a direct identity");
  }
  const processBoundEdgeGrant = makeEdgeGrantService({
    capabilities,
    resolvePageTarget,
    listCanvasDocuments,
    processMap,
    station: LOCAL_BROWSER_TEST_AUTHORITY.station,
    admitBrowserHost: (hostId) =>
      admitBrowserHostCapability(hostId, LOCAL_BROWSER_TEST_AUTHORITY),
  });
  // Warm only to make the secret-free expected-principal witness available to
  // the outer probe. The protected request still goes through admitSocket and
  // must reuse this exact cached tuple after resolving the real Unix peer PID.
  const processBoundAdmission = await processBoundEdgeGrant.admitPrincipal(
    processBoundPrincipal,
  );
  if (!processBoundAdmission.ok) {
    throw new Error(
      `dedicated browser probe edge warmup failed: ${processBoundAdmission.denial}`,
    );
  }
  const processBoundIssue = [...capabilities.auditSnapshot()]
    .reverse()
    .find(
      (event) =>
        event.outcome === "issued" &&
        event.principalId === processBoundAdmission.expectedPrincipal.principalId &&
        event.jobId === processBoundAdmission.expectedPrincipal.jobId,
    );
  if (processBoundIssue?.auditId === undefined) {
    throw new Error("dedicated browser probe did not record the edge-derived grant issue");
  }

  const admissionTuples: Readonly<Record<Exclude<AdmitMode, "terminal" | "unbound">, AdmissionTuple>> = Object.freeze({
    "process-bound": Object.freeze({
      secret: processBoundAdmission.secret,
      expectedPrincipal: processBoundAdmission.expectedPrincipal,
      auditId: processBoundIssue.auditId,
      targetCount: processBoundAdmission.targetCount,
    }),
    primary: Object.freeze({
      secret: grant.secret,
      expectedPrincipal: principal,
      auditId: grant.auditId,
      targetCount: capabilityTargets.length,
    }),
    expiring: Object.freeze({
      secret: expiringGrant.secret,
      expectedPrincipal: expiringPrincipal,
      auditId: expiringGrant.auditId,
      targetCount: 1,
    }),
    sibling: Object.freeze({
      secret: siblingGrant.secret,
      expectedPrincipal: siblingPrincipal,
      auditId: siblingGrant.auditId,
      targetCount: 1,
    }),
    // Adversarial fixture tuple: a real secret paired with a different
    // registry-created principal must fail before request body dispatch.
    mismatched: Object.freeze({
      secret: grant.secret,
      expectedPrincipal: siblingPrincipal,
      auditId: grant.auditId,
      targetCount: capabilityTargets.length,
    }),
  });

  control = await startBrowserControlServer({
    sessions,
    capabilities,
    resolvePageTarget,
    version: app.getVersion(),
    home: controlHome,
    listCanvasDocuments,
    edgeGrant: admittingEdgeGrant(
      admissionTuples,
      processBoundEdgeGrant,
      admissionModePath,
      recordEdgeAdmission,
      recordEdgeDenial,
      probePeerPid,
      processBoundPrincipal,
    ),
  });
  await writeCapabilityHandoff({
    version: 3,
    capability: grant.secret,
    expiringCapability: expiringGrant.secret,
    expiringIssuedAt: expiringGrant.issuedAt,
    expiringExpiresAt: expiringGrant.expiresAt,
    unrelatedCapability: unrelatedGrant.secret,
    siblingCapability: siblingGrant.secret,
    principals: Object.freeze({
      processBound: Object.freeze({
        principalId: processBoundAdmission.expectedPrincipal.principalId,
        jobId: processBoundAdmission.expectedPrincipal.jobId,
        auditId: processBoundIssue.auditId,
      }),
      primary: Object.freeze({
        principalId: principal.principalId,
        jobId: principal.jobId,
        auditId: grant.auditId,
      }),
      expiring: Object.freeze({
        principalId: expiringPrincipal.principalId,
        jobId: expiringPrincipal.jobId,
        auditId: expiringGrant.auditId,
      }),
      sibling: Object.freeze({
        principalId: siblingPrincipal.principalId,
        jobId: siblingPrincipal.jobId,
        auditId: siblingGrant.auditId,
      }),
    }),
  });

  let revocationCheckInFlight = false;
  revocationWatcher = setInterval(() => {
    if (revocationCheckInFlight || audit.capabilityRevoked) return;
    revocationCheckInFlight = true;
    void access(revokeMarkerPath).then(
      () => {
        if (revocationWatcher !== undefined) clearInterval(revocationWatcher);
        audit.capabilityRevoked = capabilities?.revoke(grant.handle) ?? false;
        void persistAudit();
      },
      () => {
        revocationCheckInFlight = false;
      },
    );
  }, 25);
  audit.ready = true;
  await persistAudit();
}).catch(async (error: unknown) => {
  console.error(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  await persistAudit().catch(() => undefined);
  app.exit(2);
});
