import { readFileSync } from "node:fs";
import { Context, Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";

vi.mock("@shared/release-capabilities", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/shared/release-capabilities")
  >();
  return {
    ...actual,
    RELEASE_CAPABILITIES: Object.freeze({
      ...actual.RELEASE_CAPABILITIES,
      freshRemoteEnrollment: true,
      managedRemoteDeploy: true,
      darwinRemoteDeploy: true,
    }),
  };
});
import { defaultSettings } from "../src/shared/settings";
import { BoxFleetService } from "../src/main/vellum/box";
import {
  configureRemoteEffect,
  deployRemoteEffect,
  makeHostsOperatorCoordinator,
  makeOperatorCoordinator,
  operatorArtifactSource,
} from "../src/main/vellum/hosts/operator-coordinator";
import {
  appendDeployJobStage,
  beginDeployJob,
  getDeployJob,
} from "../src/main/vellum/hosts/deploy-job-registry";
import { HOST_RUNTIME_REMEDY_STAGE } from "../src/shared/deploy-job";
import { HostsService } from "../src/main/vellum/hosts/service";
import { HostRuntime } from "../src/main/vellum/hosts/host-runtime";
import { AppInfoService } from "../src/main/services/app-info";
import { SettingsService } from "../src/main/vellum/settings/service";
import { StationStatusService } from "../src/main/vellum/station-status-store";
import { StationFleetTargetRepository } from "../src/main/vellum/station/fleet-target-repository";
import { StationRepository } from "../src/main/vellum/station/repository";
import {
  HOST_OPERATION_ADMISSIONS,
  HostOperationShutdownRefused,
  type HostOperationGate,
} from "../src/main/vellum/hosts/shutdown";
import {
  OPERATOR_PROTOCOL_VERSION,
  type OperatorRequestEnvelope,
} from "../src/shared/operator-control";

const stub = <Tag extends Context.Service<any, any>>(
  tag: Tag,
): Context.Service.Shape<Tag> => ({}) as Context.Service.Shape<Tag>;

describe("operator deployment coordinator", () => {
  it("checks the managed-install gate before refreshing a Box route", async () => {
    let boxRefreshes = 0;
    const settings = defaultSettings();
    const disabled = {
      ...settings,
      station: {
        ...settings.station,
        role: "command-center" as const,
      },
      fleet: {
        ...settings.fleet,
        remoteManagedInstalls: false,
      },
    };

    const layer = Layer.mergeAll(
      Layer.succeed(SettingsService, {
        ...stub(SettingsService),
        get: Effect.succeed(disabled),
      }),
      Layer.succeed(HostsService, stub(HostsService)),
      Layer.succeed(StationStatusService, stub(StationStatusService)),
      Layer.succeed(BoxFleetService, {
        ...stub(BoxFleetService),
        ensureHostAvailable: () =>
          Effect.sync(() => {
            boxRefreshes += 1;
            return undefined;
          }),
      }),
      Layer.succeed(AppInfoService, stub(AppInfoService)),
      Layer.succeed(StationRepository, stub(StationRepository)),
      Layer.succeed(
        StationFleetTargetRepository,
        stub(StationFleetTargetRepository),
      ),
      Layer.succeed(HostRuntime, stub(HostRuntime)),
    );

    const result = await Effect.runPromise(
      deployRemoteEffect({ id: "station-1" }).pipe(Effect.provide(layer)),
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("turned off");
    expect(boxRefreshes).toBe(0);
  });

  it("deploys only through HostRuntime.reconcile", async () => {
    const prior = "station-remote-a";
    let reconciled: string | undefined;
    const settings = defaultSettings();
    const enabled = {
      ...settings,
      station: { ...settings.station, role: "command-center" as const },
      fleet: { ...settings.fleet, remoteManagedInstalls: true },
    };
    const layer = Layer.mergeAll(
      Layer.succeed(SettingsService, {
        ...stub(SettingsService),
        get: Effect.succeed(enabled),
      }),
      Layer.succeed(HostsService, {
        ...stub(HostsService),
        get: () =>
          Effect.succeed({
            id: "remote-a",
            label: "remote-a",
            kind: "remote",
            sshEndpoint: "remote-a",
            capabilities: [],
          }),
      }),
      Layer.succeed(StationStatusService, {
        ...stub(StationStatusService),
        recordDeployment: () => Effect.void,
      }),
      Layer.succeed(BoxFleetService, {
        ...stub(BoxFleetService),
        ensureHostAvailable: () => Effect.succeed(undefined),
      }),
      Layer.succeed(AppInfoService, {
        ...stub(AppInfoService),
        stationInfo: Effect.succeed({
          name: "Vellum Command",
          version: "0.0.0",
          userDataPath: "/tmp",
        }),
      }),
      Layer.succeed(StationRepository, {
        ...stub(StationRepository),
        installationId: Effect.succeed("cc-install" as never),
      }),
      Layer.succeed(StationFleetTargetRepository, {
        ...stub(StationFleetTargetRepository),
        bind: () =>
          Effect.succeed({
            hostId: "remote-a",
            stationInstallationId: prior,
            boundAt: "2026-01-01T00:00:00.000Z",
          } as never),
      }),
      Layer.succeed(HostRuntime, {
        ...stub(HostRuntime),
        reconcile: (hostId, request) => {
          reconciled = `${hostId}:${request.intent}`;
          return Effect.succeed({
            ok: true,
            detail: "updated",
            stages: [],
            disposition: "ready",
            outcome: "ready",
            packageState: "present",
            role: "remote",
            stationInstallationId: prior,
            configuration: { ok: true, detail: "configure skipped" },
          } as never);
        },
      }),
    );

    const result = await Effect.runPromise(
      deployRemoteEffect({ id: "remote-a" }).pipe(Effect.provide(layer)),
    );

    expect(reconciled).toBe("remote-a:deploy");
    expect(result.ok).toBe(true);
  });

  it("keeps live copy/restart/wait stages instead of package progress", async () => {
    const hostId = `live-stages-${String(Date.now())}`;
    beginDeployJob(hostId);
    const settings = defaultSettings();
    const enabled = {
      ...settings,
      station: { ...settings.station, role: "command-center" as const },
      fleet: { ...settings.fleet, remoteManagedInstalls: true },
    };
    const layer = Layer.mergeAll(
      Layer.succeed(SettingsService, {
        ...stub(SettingsService),
        get: Effect.succeed(enabled),
      }),
      Layer.succeed(HostsService, {
        ...stub(HostsService),
        get: () =>
          Effect.succeed({
            id: hostId,
            label: hostId,
            kind: "remote",
            sshEndpoint: hostId,
            capabilities: [],
          }),
      }),
      Layer.succeed(StationStatusService, {
        ...stub(StationStatusService),
        recordDeployment: () => Effect.void,
      }),
      Layer.succeed(BoxFleetService, {
        ...stub(BoxFleetService),
        ensureHostAvailable: () => Effect.succeed(undefined),
      }),
      Layer.succeed(AppInfoService, {
        ...stub(AppInfoService),
        stationInfo: Effect.succeed({
          name: "Vellum Command",
          version: "0.0.0",
          userDataPath: "/tmp",
        }),
      }),
      Layer.succeed(StationRepository, {
        ...stub(StationRepository),
        installationId: Effect.succeed("cc-install" as never),
      }),
      Layer.succeed(StationFleetTargetRepository, {
        ...stub(StationFleetTargetRepository),
        bind: () =>
          Effect.succeed({
            hostId,
            stationInstallationId: "station-box",
            boundAt: "2026-01-01T00:00:00.000Z",
          } as never),
      }),
      Layer.succeed(HostRuntime, {
        ...stub(HostRuntime),
        reconcile: (reconcileHostId) => {
          appendDeployJobStage(reconcileHostId, HOST_RUNTIME_REMEDY_STAGE.copy);
          appendDeployJobStage(reconcileHostId, HOST_RUNTIME_REMEDY_STAGE.restart);
          appendDeployJobStage(reconcileHostId, HOST_RUNTIME_REMEDY_STAGE.wait);
          return Effect.succeed({
            ok: true,
            detail: "updated",
            stages: ["endpoint ok", "ssh warm ok"],
            disposition: "ready",
            outcome: "ready",
            packageState: "present",
            role: "remote",
            stationInstallationId: "station-box",
            configuration: { ok: true, detail: "configure skipped" },
          } as never);
        },
      }),
    );

    const result = await Effect.runPromise(
      deployRemoteEffect({ id: hostId }).pipe(Effect.provide(layer)),
    );

    expect(result.ok).toBe(true);
    const job = getDeployJob(hostId);
    expect(job?.stages).toContain(HOST_RUNTIME_REMEDY_STAGE.copy);
    expect(job?.stages).toContain(HOST_RUNTIME_REMEDY_STAGE.restart);
    expect(job?.stages).toContain(HOST_RUNTIME_REMEDY_STAGE.wait);
    expect(job?.stages).not.toEqual(["endpoint ok", "ssh warm ok"]);
  });

  it("does not create a deploy job when shutdown refuses admission", async () => {
    const hostId = `shutdown-refused-${String(Date.now())}`;
    const refusal = new HostOperationShutdownRefused(
      HOST_OPERATION_ADMISSIONS.deployRemote,
      1,
    );
    const gate = {
      run: () => Promise.reject(refusal),
      beginShutdown: () => ({
        phase: "closed" as const,
        closedAt: 1,
        activeLabels: [],
      }),
      drainOnQuit: () =>
        Promise.resolve({
          phase: "closed" as const,
          clean: true as const,
          timedOut: false,
          rounds: 0,
          settled: 0,
          fulfilled: 0,
          rejected: 0,
          retained: 0,
          retainedLabels: [],
          causes: [],
        }),
      snapshot: () => ({
        phase: "closed" as const,
        activeLabels: [],
      }),
    } as HostOperationGate;
    const coordinator = makeHostsOperatorCoordinator(gate);

    await expect(
      coordinator.deployRemote({ id: hostId }),
    ).resolves.toMatchObject({
      ok: false,
      code: "shutdown",
    });
    expect(getDeployJob(hostId)).toBeUndefined();
  });

  it("refuses a concurrent deploy for the same host and admits other hosts", async () => {
    const busyHost = `busy-${String(Date.now())}`;
    const otherHost = `other-${String(Date.now())}`;
    const started: string[] = [];
    const resolvers: Array<(value: unknown) => void> = [];
    const gate = {
      run: (_admission: unknown, body: () => Promise<unknown>) => {
        void body;
        return new Promise((resolve) => {
          started.push("run");
          resolvers.push(resolve);
        });
      },
      beginShutdown: () => ({
        phase: "open" as const,
        closedAt: 0,
        activeLabels: [],
      }),
      drainOnQuit: () =>
        Promise.resolve({
          phase: "open" as const,
          clean: true as const,
          timedOut: false,
          rounds: 0,
          settled: 0,
          fulfilled: 0,
          rejected: 0,
          retained: 0,
          retainedLabels: [],
          causes: [],
        }),
      snapshot: () => ({ phase: "open" as const, activeLabels: [] }),
    } as unknown as HostOperationGate;
    const coordinator = makeHostsOperatorCoordinator(gate);

    const inFlight = coordinator.deployRemote({ id: busyHost });
    expect(started).toHaveLength(1);

    // Same host while running: typed busy refusal, no second gate admission.
    const busy = await coordinator.deployRemote({ id: busyHost });
    expect(busy.ok).toBe(false);
    expect(busy.code).toBe("conflict");
    expect(busy.detail).toContain("already running");
    expect(started).toHaveLength(1);

    // A different host proceeds concurrently.
    const otherFlight = coordinator.deployRemote({ id: otherHost });
    expect(started).toHaveLength(2);

    const fakeResult = {
      ok: true,
      detail: "done",
      message: "done",
    };
    resolvers[0]?.(fakeResult);
    await inFlight;
    resolvers[1]?.(fakeResult);
    await otherFlight;

    // The slot frees on completion: the same host is admitted again.
    const reAdmitted = coordinator.deployRemote({ id: busyHost });
    expect(started).toHaveLength(3);
    resolvers[2]?.(fakeResult);
    await reAdmitted;
  });

  const configureLayer = (input: {
    readonly remoteManagedInstalls: boolean;
    readonly reconcile: Context.Service.Shape<typeof HostRuntime>["reconcile"];
    readonly configureDetail?: string;
  }) => {
    const settings = defaultSettings();
    return Layer.mergeAll(
      Layer.succeed(SettingsService, {
        ...stub(SettingsService),
        get: Effect.succeed({
          ...settings,
          station: { ...settings.station, role: "command-center" as const },
          fleet: {
            ...settings.fleet,
            remoteManagedInstalls: input.remoteManagedInstalls,
          },
        }),
      }),
      Layer.succeed(HostsService, {
        ...stub(HostsService),
        get: () =>
          Effect.succeed({
            id: "studio",
            label: "Studio",
            kind: "remote",
            sshEndpoint: "studio-box",
            capabilities: [],
          }),
        configureRemote: () =>
          Effect.succeed({
            ok: true,
            detail: input.configureDetail ?? "Remote station configured",
            stationInstallationId: "station-studio" as never,
            station: {
              role: "remote",
              hostId: "studio",
              supervisedPreferred: true,
            } as never,
          }),
      }),
      Layer.succeed(StationStatusService, {
        ...stub(StationStatusService),
        recordDeployment: () => Effect.void,
      }),
      Layer.succeed(AppInfoService, {
        ...stub(AppInfoService),
        stationInfo: Effect.succeed({
          name: "Vellum Command",
          version: "0.0.0",
          userDataPath: "/tmp",
        }),
      }),
      Layer.succeed(StationRepository, {
        ...stub(StationRepository),
        installationId: Effect.succeed("cc-install" as never),
      }),
      Layer.succeed(StationFleetTargetRepository, {
        ...stub(StationFleetTargetRepository),
        bind: () =>
          Effect.succeed({
            hostId: "studio",
            stationInstallationId: "station-studio",
            boundAt: "2026-01-01T00:00:00.000Z",
          } as never),
      }),
      Layer.succeed(HostRuntime, {
        ...stub(HostRuntime),
        reconcile: input.reconcile,
      }),
    );
  };

  it("Configure continues into the reconcile activate lifecycle", async () => {
    let reconciled: string | undefined;
    const result = await Effect.runPromise(
      configureRemoteEffect("studio").pipe(
        Effect.provide(
          configureLayer({
            remoteManagedInstalls: true,
            reconcile: (hostId, request) => {
              reconciled = `${hostId}:${request.intent}`;
              return Effect.succeed({
                ok: true,
                detail: "Vellum Command is running on this Mac",
                stages: [],
                disposition: "ready",
                outcome: "ready",
                packageState: "present",
                role: "remote",
                stationInstallationId: "station-studio",
                configuration: { ok: true, detail: "configure skipped" },
              } as never);
            },
          }),
        ),
      ),
    );
    expect(reconciled).toBe("studio:deploy");
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("Remote station configured");
    expect(result.detail).toContain("Vellum Command is running on this Mac");
  });

  it("Configure reports truthfully when the runtime does not transition", async () => {
    const result = await Effect.runPromise(
      configureRemoteEffect("studio").pipe(
        Effect.provide(
          configureLayer({
            remoteManagedInstalls: true,
            reconcile: () =>
              Effect.succeed({
                ok: false,
                detail: "supervised runtime activate failed",
                code: "io",
                message: "supervised runtime activate failed",
                stages: [],
                disposition: "indeterminate",
                outcome: "indeterminate",
                packageState: "present",
                role: "remote",
                configuration: { ok: true, detail: "configured" },
              } as never),
          }),
        ),
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain(
      "configured, but the runtime did not transition",
    );
    expect(result.detail).toContain("supervised runtime activate failed");
    expect(result.code).toBe("io");
  });

  it("Configure surfaces the maintenance recovery action, never drops it", async () => {
    const result = await Effect.runPromise(
      configureRemoteEffect("studio").pipe(
        Effect.provide(
          configureLayer({
            remoteManagedInstalls: true,
            reconcile: () =>
              Effect.succeed({
                ok: false,
                detail:
                  "Studio: package activation deferred — 2 Vellum Command terminal session(s) active.",
                code: "conflict",
                message: "close the active terminal sessions",
                stages: [],
                disposition: "not-started",
                outcome: "failed",
                packageState: "previous",
                role: "previous",
                configuration: { ok: false, detail: "deferred" },
                recoveryAction: {
                  kind: "close-active-vellum-terminals",
                  activeTerminalSessions: 2,
                },
              } as never),
          }),
        ),
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.recoveryAction).toEqual({
      kind: "close-active-vellum-terminals",
      activeTerminalSessions: 2,
    });
  });

  it("Configure refuses truthfully when managed installs are off", async () => {
    let reconcileCalls = 0;
    const result = await Effect.runPromise(
      configureRemoteEffect("studio").pipe(
        Effect.provide(
          configureLayer({
            remoteManagedInstalls: false,
            reconcile: () => {
              reconcileCalls += 1;
              throw new Error("gated Configure must not reconcile");
            },
          }),
        ),
      ),
    );
    expect(reconcileCalls).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain(
      "configured, but the runtime was not restarted",
    );
  });

  it("Configure shares the per-host single flight with Deploy", async () => {
    const hostId = `configure-busy-${String(Date.now())}`;
    const resolvers: Array<(value: unknown) => void> = [];
    const gate = {
      run: (_admission: unknown, body: () => Promise<unknown>) => {
        void body;
        return new Promise((resolve) => {
          resolvers.push(resolve);
        });
      },
      beginShutdown: () => ({
        phase: "open" as const,
        closedAt: 0,
        activeLabels: [],
      }),
      drainOnQuit: () =>
        Promise.resolve({
          phase: "open" as const,
          clean: true as const,
          timedOut: false,
          rounds: 0,
          settled: 0,
          fulfilled: 0,
          rejected: 0,
          retained: 0,
          retainedLabels: [],
          causes: [],
        }),
      snapshot: () => ({ phase: "open" as const, activeLabels: [] }),
    } as unknown as HostOperationGate;
    const coordinator = makeHostsOperatorCoordinator(gate);

    const deploying = coordinator.deployRemote({ id: hostId });
    const busy = await coordinator.configureRemote(hostId);
    expect(busy.ok).toBe(false);
    expect(busy.code).toBe("conflict");
    expect(busy.detail).toContain("already running");

    resolvers[0]?.({ ok: true, detail: "done", message: "done" });
    await deploying;
  });

  it("keeps final-release and qualification artifact sources disjoint", () => {
    const deploy = (
      source: "stable" | "cached",
    ): Extract<OperatorRequestEnvelope, { readonly op: "fleet.deploy" }> => ({
      protocol: OPERATOR_PROTOCOL_VERSION,
      id: `deploy-${source}`,
      op: "fleet.deploy",
      args: { id: "station-1", source },
    });
    const qualify: Extract<
      OperatorRequestEnvelope,
      { readonly op: "fleet.qualify" }
    > = {
      protocol: OPERATOR_PROTOCOL_VERSION,
      id: "qualify",
      op: "fleet.qualify",
      args: { id: "station-1" },
    };

    expect(operatorArtifactSource(deploy("stable"))).toBe("stable-feed");
    expect(operatorArtifactSource(deploy("cached"))).toBe("verified-cache");
    expect(operatorArtifactSource(qualify)).toBe("qualification-candidate");
    expect([
      operatorArtifactSource(deploy("stable")),
      operatorArtifactSource(deploy("cached")),
    ]).not.toContain("qualification-candidate");
  });

  it("keeps every fleet verb unavailable in bootstrap-only mode", async () => {
    const coordinator = makeOperatorCoordinator({
      fleetReady: () => false,
      readiness: () => ({
        database: true,
        workControl: false,
        simulation: false,
        session: false,
      }),
      sessionReady: () => false,
    });
    const response = await coordinator.dispatch({
      protocol: OPERATOR_PROTOCOL_VERSION,
      id: "bootstrap-fleet",
      op: "fleet.list",
      args: {},
    });

    expect(response).toMatchObject({
      ok: false,
      op: "fleet.list",
      error: { type: "runtime_down" },
    });
  });

  it("does not call leftover Deploy ceremony on the product path", () => {
    const coordinator = readFileSync(
      new URL(
        "../src/main/vellum/hosts/operator-coordinator.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(coordinator).toContain(".reconcile(");
    expect(coordinator).not.toMatch(/hosts\s*\n?\s*\.deployConfiguredRemote/u);
    expect(coordinator).not.toContain("deployConfiguredRemoteHost");
    expect(coordinator).not.toContain("deployRemoteHost");
    expect(coordinator).not.toMatch(/hosts\s*\n?\s*\.deployRemote\b/u);
    expect(coordinator).not.toContain("darwinRemoteDeploymentProvider");
    expect(coordinator).not.toMatch(
      /darwinRemoteDeploymentProvider\s*\.\s*deploy/u,
    );
  });
});
