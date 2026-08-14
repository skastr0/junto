import { Context, Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { defaultSettings } from "../src/shared/settings";
import { BoxFleetService } from "../src/main/vellum/box";
import {
  deployRemoteEffect,
  makeHostsOperatorCoordinator,
  makeOperatorCoordinator,
  operatorArtifactSource,
} from "../src/main/vellum/hosts/operator-coordinator";
import {
  beginDeployJob,
  getDeployJob,
  reportDeployStage,
} from "../src/main/vellum/hosts/deploy-job-registry";
import { HOST_RUNTIME_REMEDY_STAGE } from "../src/shared/deploy-job";
import { HostsService } from "../src/main/vellum/hosts/service";
import { HostRuntime } from "../src/main/vellum/hosts/host-runtime";
import { PrismService } from "../src/main/services/prism";
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
      Layer.succeed(PrismService, stub(PrismService)),
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
        deployConfiguredRemote: () => {
          throw new Error("coordinator must not call deployConfiguredRemote");
        },
      }),
      Layer.succeed(StationStatusService, {
        ...stub(StationStatusService),
        recordDeployment: () => Effect.void,
      }),
      Layer.succeed(BoxFleetService, {
        ...stub(BoxFleetService),
        ensureHostAvailable: () => Effect.succeed(undefined),
      }),
      Layer.succeed(PrismService, {
        ...stub(PrismService),
        stationInfo: Effect.succeed({
          name: "Vellum Command",
          version: "0.0.0",
          userDataPath: "/tmp",
          stationPluginPath: "/tmp",
          prismRoot: "/tmp",
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
      Layer.succeed(PrismService, {
        ...stub(PrismService),
        stationInfo: Effect.succeed({
          name: "Vellum Command",
          version: "0.0.0",
          userDataPath: "/tmp",
          stationPluginPath: "/tmp",
          prismRoot: "/tmp",
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
        reconcile: () => {
          reportDeployStage(HOST_RUNTIME_REMEDY_STAGE.copy);
          reportDeployStage(HOST_RUNTIME_REMEDY_STAGE.restart);
          reportDeployStage(HOST_RUNTIME_REMEDY_STAGE.wait);
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
});
