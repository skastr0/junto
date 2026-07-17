import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { app, BrowserWindow, webContents } from "electron";
import { Effect } from "effect";
import { CanvasesLive, CanvasesService } from "../../../src/main/vellum/canvases";
import { startBrowserControlServer, type BrowserControlServer } from "../../../src/main/vellum/browser/control";
import { makePageTargetResolver } from "../../../src/main/vellum/browser/page-target";
import { makeBrowserProfileService } from "../../../src/main/vellum/browser/profiles";
import { BrowserSessionService } from "../../../src/main/vellum/browser/sessions";
import { makeBrowserTestOnlyElectronHarness } from "../../../src/main/vellum/browser/view-adapter";
import { isManagedBrowserWebContents } from "../../../src/main/vellum/browser/web-policy";

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

for (const [name, path] of [
  ["browser-root", browserRoot],
  ["control-home", controlHome],
  ["download-path", downloadPath],
  ["audit-path", auditPath],
] as const) {
  if (!isAbsolute(path)) throw new Error(`${name} must be absolute`);
}

interface ProbeAudit {
  baselineWebContents: number;
  currentWebContents: number;
  maximumWebContents: number;
  browserWindows: number;
  createdWebContents: Array<{ readonly id: number; readonly type: string }>;
  externalProtocolDispatches: string[];
  ready: boolean;
}

const audit: ProbeAudit = {
  baselineWebContents: 0,
  currentWebContents: 0,
  maximumWebContents: 0,
  browserWindows: 0,
  createdWebContents: [],
  externalProtocolDispatches: [],
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

app.on("before-quit", () => {
  control?.close();
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
  control = await startBrowserControlServer({
    sessions,
    resolvePageTarget: makePageTargetResolver(canvases),
    version: app.getVersion(),
    home: controlHome,
  });
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
