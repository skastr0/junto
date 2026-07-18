import { randomUUID } from "node:crypto";
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import { url as inspectorUrl } from "node:inspector";
import { dirname, isAbsolute } from "node:path";
import { app, BrowserWindow, session, webContents } from "electron";
import { Effect } from "effect";
import { CanvasesLive, CanvasesService } from "../../../src/main/vellum/canvases";
import {
  BROWSER_CAPABILITY_ACTIONS,
  makeBrowserCapabilityRegistry,
  type BrowserCapabilityRegistry,
} from "../../../src/main/vellum/browser/capabilities";
import { startBrowserControlServer, type BrowserControlServer } from "../../../src/main/vellum/browser/control";
import { makePageTargetResolver } from "../../../src/main/vellum/browser/page-target";
import { makeBrowserProfileService } from "../../../src/main/vellum/browser/profiles";
import { BrowserSessionService } from "../../../src/main/vellum/browser/sessions";
import { makeBrowserTestOnlyElectronHarness } from "../../../src/main/vellum/browser/view-adapter";
import { isManagedBrowserWebContents } from "../../../src/main/vellum/browser/web-policy";
import { formatNodeRef } from "../../../src/shared/node-ref";
import { partitionNameForProfile } from "../../../src/shared/browser";

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
const revokeMarkerPath = requiredArgument("revoke-marker-path");

for (const [name, path] of [
  ["browser-root", browserRoot],
  ["control-home", controlHome],
  ["download-path", downloadPath],
  ["audit-path", auditPath],
  ["capability-path", capabilityPath],
  ["revoke-marker-path", revokeMarkerPath],
] as const) {
  if (!isAbsolute(path)) throw new Error(`${name} must be absolute`);
}

const canvasName = "browser-containment";
const capabilityTargets = [
  { nodeId: "personal-seed", profile: "personal" },
  { nodeId: "work-read", profile: "work" },
  { nodeId: "filler-one", profile: "personal" },
  { nodeId: "filler-two", profile: "work" },
  { nodeId: "personal-restored", profile: "personal" },
].map(({ nodeId, profile }) => ({
  ref: formatNodeRef({ canvasName, nodeId }),
  profile,
  exactOrigins: [exactOrigin],
}));
const siblingCapabilityTarget = capabilityTargets.find(
  (target) => target.ref === formatNodeRef({ canvasName, nodeId: "work-read" }),
);
if (siblingCapabilityTarget === undefined) {
  throw new Error("dedicated browser probe sibling target is missing");
}

interface CapabilityHandoff {
  readonly version: 2;
  readonly capability: string;
  readonly expiringCapability: string;
  readonly expiringIssuedAt: number;
  readonly expiringExpiresAt: number;
  readonly unrelatedCapability: string;
  readonly siblingCapability: string;
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
  ready: false,
};
let auditTail: Promise<void> = Promise.resolve();

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

app.on("before-quit", () => {
  if (revocationWatcher !== undefined) clearInterval(revocationWatcher);
  control?.close();
  capabilities?.close();
  unrelatedCapabilities?.close();
  sessions?.detachAllOnQuit("browser containment probe");
  void persistAudit();
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => app.quit());
}

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

  const harness = makeBrowserTestOnlyElectronHarness(exactOrigin, downloadPath);
  const profiles = makeBrowserProfileService(browserRoot);
  sessions = new BrowserSessionService(
    harness.adapter,
    profiles,
    Date.now,
    randomUUID,
    harness.targetAdmission,
  );
  const canvases = await Effect.runPromise(
    Effect.provide(CanvasesService, CanvasesLive),
  );
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

  control = await startBrowserControlServer({
    sessions,
    capabilities,
    resolvePageTarget: makePageTargetResolver(canvases),
    version: app.getVersion(),
    home: controlHome,
  });
  await writeCapabilityHandoff({
    version: 2,
    capability: grant.secret,
    expiringCapability: expiringGrant.secret,
    expiringIssuedAt: expiringGrant.issuedAt,
    expiringExpiresAt: expiringGrant.expiresAt,
    unrelatedCapability: unrelatedGrant.secret,
    siblingCapability: siblingGrant.secret,
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
