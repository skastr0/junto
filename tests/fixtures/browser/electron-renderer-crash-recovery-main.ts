import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, isAbsolute } from "node:path";
import { app, webContents, type WebContents } from "electron";
import { ManagedRuntime } from "effect";
import { makeBrowserProfileService } from "../../../src/main/vellum/browser/profiles";
import { BrowserSessionService } from "../../../src/main/vellum/browser/sessions";
import {
  makeStateEngineLive,
  StateEngine,
} from "../../../src/main/vellum/state/engine";
import { makeBrowserTestOnlyElectronHarness } from "../../../src/main/vellum/browser/view-adapter";
import { isManagedBrowserWebContents } from "../../../src/main/vellum/browser/web-policy";
import type { ResolvedPageTarget } from "../../../src/main/vellum/browser/page-target";
import { formatNodeRef } from "../../../src/shared/node-ref";
import { LOCAL_BROWSER_TEST_AUTHORITY } from "../../browser-host-test-authority";

const requiredArgument = (name: string): string => {
  const prefix = `--${name}=`;
  const values = process.argv
    .filter((argument) => argument.startsWith(prefix))
    .map((argument) => argument.slice(prefix.length));
  if (values.length !== 1 || values[0] === "") {
    throw new Error(`renderer crash probe requires exactly one ${prefix}<value>`);
  }
  return values[0];
};

const browserRoot = requiredArgument("browser-root");
const downloadPath = requiredArgument("download-path");
const reportPath = requiredArgument("report-path");
const stateDatabasePath = requiredArgument("state-db-path");
for (const [name, path] of [
  ["browser-root", browserRoot],
  ["download-path", downloadPath],
  ["report-path", reportPath],
  ["state-db-path", stateDatabasePath],
] as const) {
  if (!isAbsolute(path)) throw new Error(`${name} must be absolute`);
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

const writeReport = async (report: unknown): Promise<void> => {
  const temporary = `${reportPath}.${randomUUID()}.tmp`;
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(report)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, reportPath);
};

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const listen = (server: Server): Promise<string> =>
  new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      const address = server.address();
      if (address === null || typeof address === "string") {
        rejectListen(new Error("fixture listener has no TCP address"));
        return;
      }
      resolveListen(`http://127.0.0.1:${address.port}`);
    });
  });

const waitUntil = async (predicate: () => boolean, message: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error(message);
};

const managedContents = (): WebContents[] =>
  webContents.getAllWebContents().filter(isManagedBrowserWebContents);

const target = (origin: string, nodeId: string): ResolvedPageTarget => ({
  ref: formatNodeRef({ canvasName: "renderer-crash-recovery", nodeId }),
  nodeId,
  url: `${origin}/${nodeId}`,
  hostId: "local",
  profile: "personal",
});

const createdWebContentsIds: number[] = [];
app.on("web-contents-created", (_event, contents) => {
  createdWebContentsIds.push(contents.id);
});

let fixtureServer: Server | undefined;
let sessions: BrowserSessionService | undefined;
const makeStateRuntime = () =>
  ManagedRuntime.make(makeStateEngineLive(stateDatabasePath));
let stateRuntime: ReturnType<typeof makeStateRuntime> | undefined;
let shutdownFlight: Promise<void> | undefined;

const shutdownFixture = (): Promise<void> => {
  if (shutdownFlight !== undefined) return shutdownFlight;
  sessions?.detachAllOnQuit("renderer crash recovery probe");
  fixtureServer?.close();
  const runtime = stateRuntime;
  stateRuntime = undefined;
  shutdownFlight = runtime?.dispose() ?? Promise.resolve();
  return shutdownFlight;
};

app.on("before-quit", (event) => {
  event.preventDefault();
  void shutdownFixture().finally(() => app.exit(0));
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => app.quit());
}

void app.whenReady().then(async () => {
  fixtureServer = createServer((request, response) => {
    const path = request.url === "/sibling" ? "sibling" : "crashed";
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'",
    });
    response.end(`<!doctype html><title>${path}</title><main>${path}</main>`);
  });
  const origin = await listen(fixtureServer);
  await mkdir(downloadPath, { recursive: true });
  const harness = makeBrowserTestOnlyElectronHarness(origin, downloadPath);
  stateRuntime = makeStateRuntime();
  const state = await stateRuntime.runPromise(StateEngine);
  sessions = new BrowserSessionService(
    harness.adapter,
    LOCAL_BROWSER_TEST_AUTHORITY,
    makeBrowserProfileService(state, browserRoot),
    Date.now,
    randomUUID,
    harness.targetAdmission,
  );

  const crashedTarget = target(origin, "crashed");
  const siblingTarget = target(origin, "sibling");
  const crashed = await sessions.openForOwner("crashed-owner", crashedTarget);
  const sibling = await sessions.openForOwner("sibling-owner", siblingTarget);
  ensure(crashed.ok && sibling.ok, "initial sessions did not open");
  const [crashedReady, siblingReady] = await Promise.all([
    sessions.awaitNavigationTerminalForOwner("crashed-owner", crashed.data.sessionId),
    sessions.awaitNavigationTerminalForOwner("sibling-owner", sibling.data.sessionId),
  ]);
  ensure(crashedReady.ok && siblingReady.ok, "initial sessions did not finish navigation");
  ensure(managedContents().length === 2, "initial managed WebContents count is not two");

  const crashedContents = managedContents().find(
    (contents) => contents.getURL() === crashedTarget.url,
  );
  const siblingContents = managedContents().find(
    (contents) => contents.getURL() === siblingTarget.url,
  );
  ensure(crashedContents !== undefined, "crash target WebContents is missing");
  ensure(siblingContents !== undefined, "sibling WebContents is missing");
  const crashedWebContentsId = crashedContents.id;
  const siblingWebContentsId = siblingContents.id;

  const pendingEvaluation = sessions.evalForOwner(
    "crashed-owner",
    crashed.data.sessionId,
    "new Promise(() => {})",
  );
  await delay(25);
  const contention = await sessions.screenshotForOwner(
    "crashed-owner",
    crashed.data.sessionId,
  );
  ensure(
    !contention.ok && contention.code === "resource_exhausted",
    "crash target did not hold an in-flight operation",
  );

  const createdBeforeCrash = createdWebContentsIds.length;
  crashedContents.forcefullyCrashRenderer();
  const evaluation = await Promise.race([
    pendingEvaluation,
    delay(5_000).then(() => {
      throw new Error("in-flight evaluation did not terminate after renderer crash");
    }),
  ]);
  ensure(
    !evaluation.ok &&
      evaluation.code === "failed" &&
      evaluation.message === "browser renderer terminated unexpectedly",
    "renderer crash did not return the fixed operation failure",
  );
  ensure(
    !sessions.stateForOwner("crashed-owner", crashed.data.sessionId).ok,
    "crashed session remains registered",
  );
  ensure(
    sessions.stateForOwner("sibling-owner", sibling.data.sessionId).ok,
    "sibling session was invalidated",
  );
  await waitUntil(
    () =>
      managedContents().length === 1 &&
      managedContents()[0]?.id === siblingWebContentsId,
    "crashed WebContents was not removed exactly",
  );
  await delay(250);
  const createdAfterCrashStability = createdWebContentsIds.length;
  ensure(
    createdAfterCrashStability === createdBeforeCrash,
    "renderer crash triggered an implicit reconstruction loop",
  );

  const siblingEvaluation = await sessions.evalForOwner(
    "sibling-owner",
    sibling.data.sessionId,
    "document.title",
  );
  ensure(
    siblingEvaluation.ok && siblingEvaluation.data.result === "sibling",
    "sibling session is not usable after the crash",
  );

  const reopened = await sessions.openForOwner("crashed-owner", crashedTarget);
  ensure(reopened.ok, "same ref did not reopen after renderer crash");
  ensure(
    reopened.data.sessionId !== crashed.data.sessionId,
    "same ref reused the crashed generation",
  );
  const reopenedReady = await sessions.awaitNavigationTerminalForOwner(
    "crashed-owner",
    reopened.data.sessionId,
  );
  ensure(reopenedReady.ok, "reopened session did not finish navigation");
  await waitUntil(
    () => managedContents().length === 2,
    "reopened WebContents did not join the sibling",
  );
  const reopenedContents = managedContents().find(
    (contents) => contents.getURL() === crashedTarget.url,
  );
  ensure(reopenedContents !== undefined, "reopened WebContents is missing");
  ensure(reopenedContents.id !== crashedWebContentsId, "reopen reused the crashed WebContents");
  const reopenedEvaluation = await sessions.evalForOwner(
    "crashed-owner",
    reopened.data.sessionId,
    "document.title",
  );
  ensure(
    reopenedEvaluation.ok && reopenedEvaluation.data.result === "crashed",
    "reopened session is not usable",
  );
  await delay(250);
  ensure(
    createdWebContentsIds.length === createdBeforeCrash + 1,
    "reopen created more than one replacement WebContents",
  );

  await writeReport({
    version: 1,
    ok: true,
    operationFailure: evaluation,
    oldSessionRemoved: true,
    sameRefFreshGeneration: true,
    siblingUsable: true,
    replacementUsable: true,
    implicitRetryCount: createdAfterCrashStability - createdBeforeCrash,
    explicitReplacementCount: createdWebContentsIds.length - createdBeforeCrash,
    liveManagedWebContents: managedContents().length,
  });
  await shutdownFixture();
  app.exit(0);
}).catch(async (error: unknown) => {
  await writeReport({
    version: 1,
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }).catch(() => undefined);
  await shutdownFixture().catch(() => undefined);
  app.exit(2);
});
