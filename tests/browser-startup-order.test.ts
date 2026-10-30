import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearTouchedServiceWorkersAtStart } from "../src/main/junto/browser/composition";
import type { BrowserTouchedOrigin } from "../src/main/junto/browser/touched-origins";
import { partitionNameForProfile } from "../src/shared/browser";

describe("browser startup recovery gate", () => {
  const root = join(import.meta.dirname, "..");
  const indexSrc = readFileSync(join(root, "src/main/index.ts"), "utf8");
  const browserIpcSrc = readFileSync(
    join(root, "src/main/junto/browser/ipc.ts"),
    "utf8",
  );
  const juntoIpcSrc = readFileSync(join(root, "src/main/junto/ipc.ts"), "utf8");

  it("keeps browser handlers inside the post-recovery activation boundary", () => {
    const ready = indexSrc.slice(indexSrc.indexOf("app.whenReady().then"));
    const composition = ready.indexOf("startBrowserComposition(");
    const activation = ready.indexOf("async (composition) =>", composition);
    const control = ready.indexOf("startBrowserControlServer(", activation);
    const browserIpc = ready.indexOf("registerBrowserIpcHandlers(", activation);
    const window = ready.indexOf("if (!headless) createWindow()", composition);

    expect(composition).toBeGreaterThanOrEqual(0);
    expect(activation).toBeGreaterThan(composition);
    expect(control).toBeGreaterThan(activation);
    expect(browserIpc).toBeGreaterThan(control);
    // Ceremony agent IPC must stay gone.
    expect(ready.indexOf("registerBrowserAgentIpc(")).toBe(-1);
    expect(window).toBeGreaterThan(browserIpc);
    expect(ready.slice(composition, window)).not.toContain("session.fromPartition");
  });

  it("clears the touched origins' service workers before the browser activates", async () => {
    const compositionSrc = readFileSync(join(root, "src/main/junto/browser/composition.ts"), "utf8");
    const start = compositionSrc.slice(compositionSrc.indexOf("export const startBrowserComposition"));
    const clear = start.indexOf("await clearTouchedServiceWorkersAtStart(");
    expect(clear).toBeGreaterThan(start.indexOf("await runClosedBrowserEffect(profiles.recoverPendingWipe)"));
    const bound = start.indexOf("sessions.setTouchedOriginStore(touchedOrigins)");
    expect(bound).toBeGreaterThan(clear);
    // Activation opens IPC and control, the only ways a view opens.
    expect(start.indexOf("await activate(composition)")).toBeGreaterThan(bound);

    let rows: ReadonlyArray<BrowserTouchedOrigin> = [
      { profile: "default", origin: "https://a.example.com" },
      { profile: "work", origin: "https://b.example.com" },
    ];
    const store = {
      record: async () => undefined,
      list: async () => rows,
      remove: async (gone: ReadonlyArray<BrowserTouchedOrigin>) => {
        rows = rows.filter((row) => !gone.includes(row));
      },
      removeProfile: async () => undefined,
    };
    const cleared: string[] = [];
    await expect(
      clearTouchedServiceWorkersAtStart(store, async () => {
        throw new Error("disk");
      }),
    ).rejects.toThrow("disk");
    // A failed clear keeps every row.
    expect(rows).toHaveLength(2);
    await clearTouchedServiceWorkersAtStart(store, async (partition, origin) => {
      cleared.push(`${partition} ${origin}`);
    });
    expect(cleared).toEqual([
      `${partitionNameForProfile("default")} https://a.example.com`,
      `${partitionNameForProfile("work")} https://b.example.com`,
    ]);
    expect(rows).toEqual([]);
  });

  it("passes this machine's name into the production edge grant", () => {
    const activation = indexSrc.slice(indexSrc.indexOf("async (composition) =>"));
    const grantStart = activation.indexOf("const edgeGrant = makeEdgeGrantService({");
    const controlStart = activation.indexOf("browserControl = await startBrowserControlServer(");
    const grant = activation.slice(grantStart, controlStart);

    expect(grantStart).toBeGreaterThanOrEqual(0);
    expect(controlStart).toBeGreaterThan(grantStart);
    expect(grant).toContain("machineName: () => composition.sessions.machineName()");
    expect(grant).not.toContain("admitBrowserHost");
    expect(grant).toContain('core.call("model.editsCanvas", { canvasName })');
    expect(activation).not.toContain("subscribeHostsSnapshot");
    expect(activation).toContain("edgeGrant.clear()");
  });

  it("starts host-local browser control without remote Station-browser routes", () => {
    const activation = indexSrc.slice(indexSrc.indexOf("async (composition) =>"));
    const control = activation.indexOf(
      "browserControl = await startBrowserControlServer({",
    );
    const bind = activation.indexOf(
      "composition.bindControlShutdown(browserControl)",
    );

    expect(control).toBeGreaterThanOrEqual(0);
    expect(bind).toBeGreaterThan(control);
    expect(activation).not.toContain("prepareStationBrowserRuntimeRoutes");
    expect(activation).not.toContain("stationBrowserRoutes");
    expect(activation).not.toContain("StationBrowserTrustRepository");
    const composition = activation.slice(control, bind);
    expect(composition).toContain("sessions: composition.sessions");
    expect(composition).toContain("edgeGrant");
    expect(composition).toContain("listCanvasModels");
  });

  it("creates the headless native parent before composition and injects the attachment target", () => {
    const ready = indexSrc.slice(indexSrc.indexOf("app.whenReady().then"));
    const host = ready.indexOf("await browserCompositionHost.ensureHeadlessHost()");
    const composition = ready.indexOf("startBrowserComposition(");
    const adapter = ready.indexOf("viewAdapter: browserViewAttachmentTarget.adapter", composition);

    expect(host).toBeGreaterThanOrEqual(0);
    expect(host).toBeLessThan(composition);
    expect(adapter).toBeGreaterThan(composition);
  });

  it("uses the platform supervisor handoff before any composition host exists", () => {
    const ready = indexSrc.slice(indexSrc.indexOf("app.whenReady().then"));
    const supervised = ready.indexOf("if (!(await ensureSupervised())) return;");
    const host = ready.indexOf("await browserCompositionHost.ensureHeadlessHost()");
    expect(indexSrc).toContain('import { loadStationSupervisor } from "./junto/supervision/select";');
    expect(indexSrc).toContain("const handoff = await supervisor.requestHandoff();");
    expect(indexSrc).not.toContain("kickstartLaunchAgent");
    expect(supervised).toBeGreaterThanOrEqual(0);
    expect(host).toBeGreaterThan(supervised);
  });

  it("asks only the machine's own preference before seeking supervision", () => {
    const ensureSupervised = indexSrc.slice(
      indexSrc.indexOf("const ensureSupervised ="),
      indexSrc.indexOf("const supervisor = await loadStationSupervisor();"),
    );
    expect(ensureSupervised).toContain("if (!machine.supervisedPreferred) return true;");
    expect(ensureSupervised).not.toContain("process.platform");
    expect(ensureSupervised).not.toContain("role");
    expect(ensureSupervised).toContain('(await core.call("settings.read", {})).machine');
    expect(indexSrc).not.toContain("StateEngineLive");
    expect(indexSrc).not.toContain("SettingsLive");
    expect(indexSrc).not.toContain("ManagedRuntime.make");
    expect(indexSrc).not.toContain('readFile(settingsPath(), "utf8")');
  });

  it("routes an accepted supervisor handoff through the app runtime disposal path", () => {
    const ensureSupervised = indexSrc.slice(
      indexSrc.indexOf("const ensureSupervised ="),
      indexSrc.indexOf("} else if (!gotSingleInstanceLock)"),
    );
    const exitAfterDetach = indexSrc.slice(
      indexSrc.indexOf("const exitAfterDetach ="),
      indexSrc.indexOf("let quitPreparation:"),
    );
    const disposeRuntime = indexSrc.slice(
      indexSrc.indexOf("const disposeRuntime ="),
      indexSrc.indexOf(
        "/** An app exit is authorized only after every owned local child reports exit. */",
      ),
    );

    expect(ensureSupervised).toMatch(
      /if \(handoff\.accepted\) \{[\s\S]*exitAfterDetach\(0, `\$\{supervisor\.metadata\.provider\}-handoff`\)/,
    );
    expect(exitAfterDetach).toContain("return disposeRuntime();");
    expect(disposeRuntime).toContain("AppRuntime.dispose()");
  });

  it("preserves non-browser IPC before recovery without registering browser IPC", () => {
    const ready = indexSrc.slice(indexSrc.indexOf("app.whenReady().then"));
    expect(ready.indexOf("registerIpcHandlers();")).toBeLessThan(
      ready.indexOf("startBrowserComposition("),
    );
    const ordinaryJuntoIpc = juntoIpcSrc.slice(
      juntoIpcSrc.indexOf("export const registerJuntoIpc"),
      juntoIpcSrc.indexOf("export const registerJuntoBrowserIpc"),
    );
    expect(ordinaryJuntoIpc).not.toContain("registerBrowserIpc(");
  });

  it("has no eager session singleton and requires injected recovered sessions", () => {
    expect(browserIpcSrc).not.toMatch(/new BrowserSessionService/);
    expect(browserIpcSrc).not.toContain("electronViewAdapter");
    expect(browserIpcSrc).toMatch(
      /registerBrowserIpc = \([\s\S]*browserSessions: BrowserSessionService/,
    );
  });

  it("exits nonzero with the fixed diagnostic and no window on startup failure", () => {
    const ready = indexSrc.slice(indexSrc.indexOf("app.whenReady().then"));
    const failure = ready.slice(
      ready.indexOf("} catch (startupError) {", ready.indexOf("startBrowserComposition(")),
      ready.indexOf("if (!headless) createWindow()"),
    );
    expect(failure.startsWith("} catch (startupError) {")).toBe(true);
    expect(failure).toContain("BROWSER_COMPOSITION_STARTUP_FAILURE_MESSAGE");
    expect(failure).toContain(
      'exitAfterDetach(1, "browser-composition-startup-failure")',
    );
    expect(failure).toMatch(
      /exitAfterDetach\(1, "browser-composition-startup-failure"\);\s*return;/,
    );
    expect(failure).not.toContain("createWindow(");
  });
});
