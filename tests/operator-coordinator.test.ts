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
import { getDeployJob } from "../src/main/vellum/hosts/deploy-job-registry";
import { HostsService } from "../src/main/vellum/hosts/service";
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

const stub = <Tag extends Context.Tag<any, any>>(
  tag: Tag,
): Context.Tag.Service<Tag> => ({}) as Context.Tag.Service<Tag>;

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
    );

    const result = await Effect.runPromise(
      deployRemoteEffect({ id: "station-1" }).pipe(Effect.provide(layer)),
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("turned off");
    expect(boxRefreshes).toBe(0);
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
