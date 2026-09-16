import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const indexSource = readFileSync(
  join(root, "src/main/index.ts"),
  "utf8",
);
const remoteSource = readFileSync(
  join(root, "src/main/junto-remote.ts"),
  "utf8",
);

describe("main-process startup architecture", () => {
  it("selects the door from the persisted mode before any door binds", () => {
    const startup = indexSource.slice(
      indexSource.indexOf("app.whenReady().then"),
    );
    const configuration = startup.indexOf(
      "const stationConfiguration = await AppRuntime.runPromise(",
    );
    const selection = startup.indexOf("const stationDoor = startupDoor({");

    expect(configuration).toBeGreaterThanOrEqual(0);
    expect(selection).toBeGreaterThan(configuration);
    for (const bind of ['door: "enroll"', 'door: "peer"']) {
      expect(startup.indexOf(bind)).toBeGreaterThan(selection);
    }
    // One selection feeds both bind sites: enroll and peer can never both bind.
    expect(startup.split("const stationDoor = startupDoor({")).toHaveLength(2);
    // The one selection receives the real launch shape, not a constant.
    const selectionCall = startup.slice(selection, selection + 200);
    expect(selectionCall).toContain("mode: stationMode");
    expect(selectionCall).toContain("packaged: app.isPackaged");
    expect(selectionCall).toContain("headless,");
  });

  it("keeps the enroll ingress on the three enrollment verbs and holds", () => {
    const startup = indexSource.slice(
      indexSource.indexOf("app.whenReady().then"),
    );
    const bootstrapStart = startup.indexOf('if (stationDoor === "enroll")');
    const bootstrapEnd = startup.indexOf(
      "stationFleetPropagationService = await AppRuntime.runPromise(",
      bootstrapStart,
    );
    const bootstrap = startup.slice(bootstrapStart, bootstrapEnd);

    expect(bootstrapStart).toBeGreaterThanOrEqual(0);
    expect(bootstrap).toContain('door: "enroll"');
    expect(bootstrap).not.toContain('door: "peer"');
    expect(bootstrap).not.toContain("startStationRemoteReportPump");
    expect(bootstrap).not.toContain("stationConfiguration === undefined");
    expect(bootstrap).toMatch(/}\s+return;\s+}/);
  });

  it("binds peer whenever the mode owns that door, headless included", () => {
    const startup = indexSource.slice(
      indexSource.indexOf("app.whenReady().then"),
    );
    const kernelStart = startup.indexOf(
      "kernelService = await AppRuntime.runPromise(KernelService)",
    );
    const kernelEnd = startup.indexOf(
      "[station-control] failed to start",
      kernelStart,
    );
    const kernel = startup.slice(kernelStart, kernelEnd);

    expect(kernelStart).toBeGreaterThanOrEqual(0);
    expect(kernel).toContain('stationDoor === "peer"');
    expect(kernel).toContain('door: "peer"');
    expect(kernel).toContain("startStationRemoteReportPump");
    expect(kernel.indexOf('stationDoor === "peer"')).toBeLessThan(
      kernel.indexOf('door: "peer"'),
    );
    expect(kernel.indexOf('door: "peer"')).toBeLessThan(
      kernel.indexOf("startStationRemoteReportPump"),
    );
    expect(kernel).not.toContain('door: "enroll"');
  });

  it("never rewrites the persisted role while choosing a door", () => {
    const startup = indexSource.slice(
      indexSource.indexOf("app.whenReady().then"),
    );
    const selection = startup.indexOf("const stationDoor = startupDoor({");
    const doorRegion = startup.slice(
      selection,
      startup.indexOf(
        "stationFleetPropagationService = await AppRuntime.runPromise(",
        selection,
      ),
    );
    for (const write of [
      "configure(",
      "writeStationConfiguration",
      "role: \"command-center\"",
      "role: \"remote\"",
    ]) {
      expect(doorRegion).not.toContain(write);
    }
  });

  it("keeps the Node Remote on one door: enroll when unenrolled, peer when Remote", () => {
    const selection = remoteSource.indexOf("const stationDoor = startupDoor({");
    expect(selection).toBeGreaterThan(
      remoteSource.indexOf("const stationConfiguration = await"),
    );
    expect(remoteSource.split("const stationDoor = startupDoor({")).toHaveLength(
      2,
    );

    const enrollStart = remoteSource.indexOf('if (stationDoor === "enroll")');
    const enrollEnd = remoteSource.indexOf(
      "handles.workControl = await startWorkControlServer(",
      enrollStart,
    );
    const enroll = remoteSource.slice(enrollStart, enrollEnd);
    expect(enrollStart).toBeGreaterThan(selection);
    expect(enroll).toContain('door: "enroll"');
    expect(enroll).not.toContain('door: "peer"');
    expect(enroll).not.toContain("startStationRemoteReportPump");

    const peerStart = remoteSource.indexOf('if (stationDoor === "peer")');
    const peerEnd = remoteSource.indexOf(
      "[station-control] failed to start",
      peerStart,
    );
    const peer = remoteSource.slice(peerStart, peerEnd);
    expect(peerStart).toBeGreaterThan(enrollEnd);
    expect(peer).toContain('door: "peer"');
    expect(peer).toContain("startStationRemoteReportPump");
    expect(peer).not.toContain('door: "enroll"');
  });

  it("retains and drains the exact Station fleet supervisor on quit", () => {
    const fleetShutdown = indexSource.slice(
      indexSource.indexOf(
        "const beginStationFleetPropagationShutdown =",
      ),
      indexSource.indexOf(
        "const CANVAS_FLUSH_TIMEOUT_MS",
      ),
    );
    expect(fleetShutdown).toContain("service.beginShutdown()");
    expect(fleetShutdown).toContain(
      "stationFleetPropagationShutdown ??= AppRuntime.runPromise(",
    );
    expect(fleetShutdown).toContain("service.stop");

    const startup = indexSource.slice(
      indexSource.indexOf("app.whenReady().then"),
    );
    const retain = startup.indexOf(
      "stationFleetPropagationService = await AppRuntime.runPromise(",
    );
    const productIpc = startup.indexOf("registerIpcHandlers();");
    expect(retain).toBeGreaterThanOrEqual(0);
    expect(retain).toBeLessThan(productIpc);

    const drain = indexSource.slice(
      indexSource.indexOf("const drainRuntimeOnQuit ="),
      indexSource.indexOf("const disposeRuntime ="),
    );
    expect(drain).toContain(
      "await requireCleanStationFleetPropagationShutdown()",
    );
  });

  it("does not wait for authoring IPC when no product renderer owns it", () => {
    const commit = indexSource.slice(
      indexSource.indexOf("const flushCanvasOnQuit ="),
      indexSource.indexOf("let runtimeDetachedForQuit"),
    );
    expect(commit).toContain(
      "if (!productRuntimeStarted) return;",
    );
  });

});

describe("station helper door split", () => {
  it("bootstrap uses enroll/negotiation; peer exchange uses the session helper", () => {
    const bootstrap = readFileSync(
      join(root, "src/main/junto/station/openssh-bootstrap.ts"),
      "utf8",
    );
    const peer = readFileSync(
      join(root, "src/main/junto/station/openssh-peer-exchange.ts"),
      "utf8",
    );
    expect(bootstrap).toContain('"negotiation"');
    expect(bootstrap).not.toContain('"session"');
    expect(peer).toContain('details.platform,\n          "session"');
    expect(peer).not.toContain('details.platform,\n          "negotiation"');
  });
});
