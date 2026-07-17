import { randomUUID } from "node:crypto";
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { app, BrowserWindow, webContents } from "electron";
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
  readonly version: 1;
  readonly capability: string;
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
  ready: false,
};
let auditTail: Promise<void> = Promise.resolve();

const persistAudit = (): Promise<void> => {
  audit.currentWebContents = webContents.getAllWebContents().length;
  audit.maximumWebContents = Math.max(audit.maximumWebContents, audit.currentWebContents);
  audit.browserWindows = BrowserWindow.getAllWindows().length;
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
      sessions?.destroyOwnerSessions(notice.ownerId, "browser containment capability ended");
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
    version: 1,
    capability: grant.secret,
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
