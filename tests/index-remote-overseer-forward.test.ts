import { CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Layer, ManagedRuntime, Result, Schema } from "effect";
import {
  InstallationId,
  PairRequest,
  STATION_API_PROTOCOL,
  StationOverseerRequest,
  StationOverseerResponse,
  type InstallationId as InstallationIdValue,
} from "../src/shared/station-api";
import {
  OverseerCaller,
  OverseerRequest,
  type OverseerResult,
} from "../src/shared/overseer-control";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { WorkLive } from "../src/main/junto/work/service";
import { CanvasesLive } from "../src/main/junto/canvases";
import {
  StationRepository,
  StationRepositoryLive,
} from "../src/main/junto/station/repository";
import { StationFleetTargetRepositoryLive } from "../src/main/junto/station/fleet-target-repository";
import { StationLivePeerRegistryLive } from "../src/main/junto/station/session-registry";
import {
  makeSettingsLive,
} from "../src/main/junto/settings/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { makeContentServiceLive } from "../src/main/junto/content/service";
import { ChatServiceContext } from "../src/main/junto/chat/service";
import type { ChatService } from "../src/main/junto/chat/service";
import { ActorSeatOccupy } from "../src/main/junto/term/actor-seat-occupy";
import { composeOverseer } from "../src/main/junto/overseer/composition";

const decodeInstallationId = Schema.decodeUnknownSync(InstallationId);
const COMMAND_CENTER = decodeInstallationId("cc-forward-test");
const caller = Schema.decodeUnknownSync(OverseerCaller)({
  canvasName: "factory",
  nodeId: "remote-agent",
});
const request = Schema.decodeUnknownSync(OverseerRequest)({
  operation: "status",
  args: {},
});

const pairRequest = (
  local: InstallationIdValue,
  commandCenter: InstallationIdValue,
) =>
  PairRequest.make({
    protocol: STATION_API_PROTOCOL,
    op: "pair",
    commandCenterInstallationId: commandCenter,
    stationInstallationId: local,
    stationLabel: "Forward Test Station",
    appVersion: "test",
  });

const overseerResponse = (input: StationOverseerRequest) =>
  Schema.decodeUnknownSync(StationOverseerResponse, {
    onExcessProperty: "error",
  })({
    protocol: STATION_API_PROTOCOL,
    op: "overseer",
    senderInstallationId: input.targetInstallationId,
    targetInstallationId: input.senderInstallationId,
    caller: input.caller,
    result: {
      ok: true,
      operation: input.request.operation,
      data: { forwarded: true },
    } satisfies OverseerResult,
  });

// The forward path never occupies seats: a failing stub proves the bound
// dispatcher is the only authority the seam consults.
const seatStubLayer = Layer.succeed(ActorSeatOccupy, {
  occupy: () =>
    Effect.fail(new Error("overseer forward must not occupy actor seats")),
  occupancy: () =>
    Effect.fail(new Error("overseer forward must not read seat occupancy")),
});
// The forward path never touches chats; the composition only closes over it.
const chatsStubLayer = Layer.succeed(
  ChatServiceContext,
  {} as unknown as ChatService,
);

const layers = (root: string) => {
  // Remote boots never auto-configure a Command Center role; the pairing is
  // the only identity this test seeds.
  const settings = makeSettingsLive({ ensureDefaultCommandCenter: false });
  const repositories = Layer.provideMerge(Layer.mergeAll(
    CrewRepositoryLive, WorkRepositoryLive, StationRepositoryLive, StationFleetTargetRepositoryLive,
    settings, makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
  ), Layer.mergeAll(
    makeStateEngineLive(join(root, "state.db")),
    makeInstallOpsLive(join(root, "install-ops.db")),
  ));
  return Layer.provideMerge(WorkLive, Layer.mergeAll(
    Layer.provideMerge(CanvasesLive, repositories),
    StationLivePeerRegistryLive,
    seatStubLayer,
    chatsStubLayer,
  ));
};

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("Electron Remote overseer forward seam", () => {
  it("refuses a disconnected session without dispatching and dispatches once with the paired identity once active", async () => {
    root = await mkdtemp(join(tmpdir(), "index-remote-forward-"));
    const runtime = ManagedRuntime.make(layers(root));
    const composition = await composeOverseer({
      run: runtime.runPromise,
      captureApplicationPage: async () => ({
        ok: false,
        unavailable: true,
        reason: "Remote has no Command Center window to observe",
      }),
    });
    try {
      const stations = await runtime.runPromise(StationRepository);
      // The local identity is minted by the repository; pair it durably.
      const remoteInstallationId = await runtime.runPromise(
        stations.installationId,
      );
      await runtime.runPromise(
        stations.pair(pairRequest(remoteInstallationId, COMMAND_CENTER)),
      );
      // The startup seam reads the durable pairing, never literals.
      const pairing = await runtime.runPromise(stations.pairing);
      expect(pairing).toBeDefined();
      expect(pairing?.commandCenterInstallationId).toBe(COMMAND_CENTER);

      const dispatched: StationOverseerRequest[] = [];
      let sessionReady = false;
      const control = {
        sessionReady: () => sessionReady,
        overseer: async (input: StationOverseerRequest) => {
          dispatched.push(input);
          return overseerResponse(input);
        },
      };

      composition.bindStationForward({
        control,
        remoteInstallationId,
        commandCenterInstallationId: pairing!.commandCenterInstallationId,
      });

      const refused = await runtime.runPromise(
        Effect.result(composition.runtime.forward(caller, request)),
      );
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) {
        expect(refused.failure).toMatchObject({
          type: "RuntimeDown",
          message: "Command Center has no active Station session",
        });
      }
      expect(dispatched).toHaveLength(0);

      sessionReady = true;
      const active = await runtime.runPromise(
        Effect.result(composition.runtime.forward(caller, request)),
      );
      expect(Result.isSuccess(active)).toBe(true);
      if (Result.isSuccess(active)) {
        expect(active.success).toMatchObject({
          ok: true,
          operation: "status",
          data: { forwarded: true },
        });
      }
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({
        senderInstallationId: remoteInstallationId,
        targetInstallationId: pairing?.commandCenterInstallationId,
        caller,
        request,
      });
    } finally {
      composition.dispose();
      await runtime.dispose();
    }
  });
});

describe("Electron main binds the Remote overseer forward at the peer door", () => {
  const source = readFileSync(
    join(import.meta.dirname, "..", "src/main/index.ts"),
    "utf8",
  );

  it("binds the composition forward to the peer control with the durable pairing identity", () => {
    const peerStart = source.indexOf('if (stationDoor === "peer") {');
    expect(peerStart).toBeGreaterThanOrEqual(0);
    const peerEnd = source.indexOf(
      "[station-control] failed to start:",
      peerStart,
    );
    const peerBlock = source.slice(peerStart, peerEnd);

    // Same control instance the report pump uses, and the durable pairing
    // identity — not a second dial and not inferred role state.
    expect(peerBlock).toContain(
      "const pairing = await AppRuntime.runPromise(stations.pairing)",
    );
    expect(peerBlock).toContain(
      "const remoteInstallationId = await AppRuntime.runPromise(",
    );
    expect(peerBlock).toContain("stations.installationId");
    expect(peerBlock).toContain("overseerComposition.bindStationForward({");
    expect(peerBlock).toContain("control: stationControl");
    expect(peerBlock).toContain(
      "commandCenterInstallationId: pairing.commandCenterInstallationId",
    );
  });

  it("never binds a forward on the enroll door", () => {
    const enrollStart = source.indexOf('if (stationDoor === "enroll") {');
    expect(enrollStart).toBeGreaterThanOrEqual(0);
    const enrollEnd = source.indexOf(
      "stationFleetPropagationService = await AppRuntime.runPromise(",
      enrollStart,
    );
    expect(
      source.slice(enrollStart, enrollEnd),
    ).not.toContain("bindStationForward");
  });
});
