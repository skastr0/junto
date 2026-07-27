import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("browser startup recovery gate", () => {
  const root = join(import.meta.dirname, "..");
  const indexSrc = readFileSync(join(root, "src/main/index.ts"), "utf8");
  const browserIpcSrc = readFileSync(
    join(root, "src/main/vellum/browser/ipc.ts"),
    "utf8",
  );
  const vellumIpcSrc = readFileSync(join(root, "src/main/vellum/ipc.ts"), "utf8");

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

  it("passes the composition's physical browser authority into the production edge grant", () => {
    const activation = indexSrc.slice(indexSrc.indexOf("async (composition) =>"));
    const grantStart = activation.indexOf("const edgeGrant = makeEdgeGrantService({");
    const controlStart = activation.indexOf("browserControl = await startBrowserControlServer(");
    const grant = activation.slice(grantStart, controlStart);

    expect(grantStart).toBeGreaterThanOrEqual(0);
    expect(controlStart).toBeGreaterThan(grantStart);
    expect(grant).toContain("station: () => composition.sessions.stationIdentity()");
    expect(grant).toContain(
      "admitBrowserHost: (hostId) => composition.sessions.admitAutomationHost(hostId)",
    );
    expect(grant).toContain("admitStation: stationAdmission.admit");
    expect(activation).toContain(
      "const stationUnsubscribe = stationAdmission.subscribe(() =>",
    );
    expect(activation).toContain("edgeGrant.clear()");
  });

  it("composes station browser routes before exposing the owner-local control socket", () => {
    const activation = indexSrc.slice(indexSrc.indexOf("async (composition) =>"));
    const routes = activation.indexOf(
      "await prepareStationBrowserRuntimeRoutes({",
    );
    const control = activation.indexOf(
      "browserControl = await startBrowserControlServer({",
    );
    const bind = activation.indexOf(
      "composition.bindControlShutdown(browserControl)",
    );

    expect(routes).toBeGreaterThanOrEqual(0);
    expect(control).toBeGreaterThan(routes);
    expect(bind).toBeGreaterThan(control);
    const composition = activation.slice(routes, control);
    expect(composition).toContain("sessions: composition.sessions");
    expect(composition).toContain("stationAdmission");
    expect(composition).toContain("hosts: hostsSnapshot");
    expect(composition).toContain("ssh");
    expect(composition).toContain("trust: stationBrowserTrust");
    expect(activation.slice(control, bind)).toContain(
      "...stationBrowserRoutes",
    );
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
    expect(indexSrc).toContain('import { loadStationSupervisor } from "./vellum/supervision/select";');
    expect(indexSrc).toContain("const handoff = await supervisor.requestHandoff();");
    expect(indexSrc).not.toContain("kickstartLaunchAgent");
    expect(supervised).toBeGreaterThanOrEqual(0);
    expect(host).toBeGreaterThan(supervised);
  });

  it("does not infer Linux Remote supervision for a Command Center with the unit installed", () => {
    const ensureSupervised = indexSrc.slice(
      indexSrc.indexOf("const ensureSupervised ="),
      indexSrc.indexOf("const supervisor = await loadStationSupervisor();"),
    );
    expect(indexSrc).toContain('if (process.platform === "linux")');
    expect(indexSrc).not.toContain('process.platform === "linux" && !headless');
    expect(indexSrc).toContain('station.role !== "remote"');
    expect(indexSrc).toContain("station.supervisedPreferred !== true");
    expect(ensureSupervised).toContain("await AppRuntime.runPromise(");
    expect(ensureSupervised).toContain(
      "Effect.flatMap(SettingsService, (settings) => settings.get)",
    );
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
    const ordinaryVellumIpc = vellumIpcSrc.slice(
      vellumIpcSrc.indexOf("export const registerVellumIpc"),
      vellumIpcSrc.indexOf("export const registerVellumBrowserIpc"),
    );
    expect(ordinaryVellumIpc).not.toContain("registerBrowserIpc(");
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
      ready.indexOf("} catch {", ready.indexOf("startBrowserComposition(")),
      ready.indexOf("if (!headless) createWindow()"),
    );
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
