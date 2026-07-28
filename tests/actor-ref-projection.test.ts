import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { InstallationId } from "../src/shared/installation-id";
import {
  ConfigureRequest,
  LogicalSequence,
  PairRequest,
  ProjectRequest,
  STATION_API_PROTOCOL,
  StationHostId,
} from "../src/shared/station-api";
import {
  CanvasesLive,
  CanvasesService,
} from "../src/main/vellum/canvases";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum/state/engine";
import {
  StationFleetTargetRepository,
  StationFleetTargetRepositoryLive,
} from "../src/main/vellum/station/fleet-target-repository";
import {
  makeStationRepositoryLive,
  StationRepository,
  stationProjectionContentSha256,
} from "../src/main/vellum/station/repository";
import {
  compileStationPortfolioBody,
} from "../src/main/vellum/station/portfolio";
import { deriveActorSeatId } from "../src/main/vellum/station/actor-seat-compiler";
import { WorkRepositoryLive } from "../src/main/vellum/work/repository";

const installation = Schema.decodeUnknownSync(InstallationId);
const hostId = Schema.decodeUnknownSync(StationHostId);
const sequence = Schema.decodeUnknownSync(LogicalSequence);

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const actorDoc = (
  nodeId: string,
  host: string,
  bindingId: string,
  agentKey: string,
): CanvasDoc => ({
  nodes: [
    {
      id: nodeId,
      type: "text",
      x: 0,
      y: 0,
      width: 240,
      height: 100,
      text: agentKey,
      ether: {
        entity: { kind: "agent", name: agentKey },
        terminal: {
          bindingId,
          launch: { kind: "harness", argv: ["codex"] },
          harness: "codex",
        },
        host,
      },
    },
  ],
  edges: [],
});

const mergeDocs = (...documents: ReadonlyArray<CanvasDoc>): CanvasDoc => ({
  nodes: documents.flatMap((document) => document.nodes),
  edges: documents.flatMap((document) => document.edges),
});

const makeRuntime = async (
  prefix: string,
  localInstallationId: string,
) => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  const state = makeStateEngineLive(join(root, "vellum.db"));
  const repositories = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      StationFleetTargetRepositoryLive,
      makeStationRepositoryLive({
        makeInstallationId: () => installation(localInstallationId),
        now: () => "2026-07-27T12:00:00.000Z",
      }),
    ),
    state,
  );
  return ManagedRuntime.make(
    Layer.provideMerge(CanvasesLive, repositories),
  );
};

describe("active ActorRef projection", () => {
  it("compiles Command Center refs from one coherent canvas and fleet topology read", async () => {
    const runtime = await makeRuntime(
      "vellum-actor-ref-command-",
      "installation-command",
    );
    const localInstallationId = installation("installation-command");
    const remoteInstallationId = installation("installation-remote");

    try {
      const { canvases, fleetTargets, state } = await runtime.runPromise(
        Effect.gen(function* () {
          return {
            canvases: yield* CanvasesService,
            fleetTargets: yield* StationFleetTargetRepository,
            state: yield* StateEngine,
          };
        }),
      );
      await runtime.runPromise(
        state.transaction("test.configure-command-center", (writer) => {
          writer.run(
            `INSERT INTO station_configuration(
               singleton,
               role,
               host_id,
               agent_host_id,
               command_center_installation_id,
               supervised_preferred,
               configured_at
             ) VALUES (1, 'command-center', 'local', NULL, NULL, 0, ?)`,
            ["2026-07-27T12:00:00.000Z"],
          );
        }),
      );
      await runtime.runPromise(
        fleetTargets.bind({
          hostId: "remote-a",
          stationInstallationId: remoteInstallationId,
        }),
      );

      await runtime.runPromise(
        canvases.write(
          "alpha",
          mergeDocs(
            actorDoc(
              "local-agent",
              "local",
              "binding-local",
              "local:codex",
            ),
            actorDoc(
              "remote-agent",
              "remote-a",
              "binding-remote",
              "remote-a:codex",
            ),
          ),
        ),
      );
      await runtime.runPromise(
        canvases.write(
          "zeta",
          actorDoc(
            "local-alias",
            "local",
            "binding-local",
            "local:codex",
          ),
        ),
      );

      const localSeatId = deriveActorSeatId(
        localInstallationId,
        "binding-local",
      );
      const remoteSeatId = deriveActorSeatId(
        remoteInstallationId,
        "binding-remote",
      );
      const alpha = await runtime.runPromise(canvases.read("alpha"));
      expect(alpha.actorRefs).toEqual(
        [
          {
            seatId: localSeatId,
            canvasName: "alpha",
            nodeId: "local-agent",
          },
          {
            seatId: remoteSeatId,
            canvasName: "alpha",
            nodeId: "remote-agent",
          },
        ].sort((left, right) => left.seatId.localeCompare(right.seatId)),
      );
      expect(await runtime.runPromise(canvases.activeActorRefs())).toEqual(
        [
          {
            seatId: localSeatId,
            canvasName: "alpha",
            nodeId: "local-agent",
          },
          {
            seatId: localSeatId,
            canvasName: "zeta",
            nodeId: "local-alias",
          },
          {
            seatId: remoteSeatId,
            canvasName: "alpha",
            nodeId: "remote-agent",
          },
        ].sort(
          (left, right) =>
            left.seatId.localeCompare(right.seatId) ||
            left.canvasName.localeCompare(right.canvasName),
        ),
      );

      await runtime.runPromise(
        canvases.write(
          "unresolved",
          actorDoc(
            "lost-agent",
            "missing-host",
            "binding-lost",
            "missing-host:codex",
          ),
        ),
      );
      await expect(
        runtime.runPromise(canvases.read("alpha")),
      ).rejects.toThrow("unresolved host");
      await expect(
        runtime.runPromise(canvases.activeActorRefs()),
      ).rejects.toThrow("unresolved host");
    } finally {
      await runtime.dispose();
    }
  });

  it("reads Remote refs only from the validated installed portfolio registry", async () => {
    const runtime = await makeRuntime(
      "vellum-actor-ref-remote-",
      "installation-remote",
    );
    const local = installation("installation-remote");
    const commandCenter = installation("installation-command");
    const remoteActor = actorDoc(
      "remote-agent",
      "remote-a",
      "binding-remote",
      "remote-a:codex",
    );

    try {
      const { canvases, station } = await runtime.runPromise(
        Effect.gen(function* () {
          return {
            canvases: yield* CanvasesService,
            station: yield* StationRepository,
          };
        }),
      );
      await runtime.runPromise(
        station.pair(
          PairRequest.make({
            protocol: STATION_API_PROTOCOL,
            op: "pair",
            commandCenterInstallationId: commandCenter,
            stationInstallationId: local,
            stationLabel: "Remote A",
            appVersion: "0.1.0",
          }),
        ),
      );
      await runtime.runPromise(
        station.configureRemote(
          ConfigureRequest.make({
            protocol: STATION_API_PROTOCOL,
            op: "configure",
            installationId: local,
            configuration: {
              role: "remote",
              hostId: hostId("remote-a"),
              agentHostId: hostId("remote-a"),
              commandCenterInstallationId: commandCenter,
              supervisedPreferred: true,
            },
            host: {
              id: "remote-a",
              label: "Remote A",
              kind: "remote",
              sshEndpoint: "remote-a",
              capabilities: ["terminal"],
            },
          }),
        ),
      );
      const body = compileStationPortfolioBody(
        new Map([["factory", remoteActor]]),
        new Map([["remote-a", local]]),
      );
      await runtime.runPromise(
        station.installProjection(
          ProjectRequest.make({
            protocol: STATION_API_PROTOCOL,
            op: "project",
            stationInstallationId: local,
            projection: {
              scope: "full",
              generation: sequence("1"),
              sourceCanvasGeneration: sequence("1"),
              sourceIntentSha256:
                stationProjectionContentSha256("remote actor source"),
              body,
              contentSha256: stationProjectionContentSha256(body),
              createdAt: "2026-07-27T12:01:00.000Z",
            },
          }),
        ),
      );

      const expected = [{
        seatId: deriveActorSeatId(local, "binding-remote"),
        canvasName: "factory",
        nodeId: "remote-agent",
      }];
      expect(
        (await runtime.runPromise(canvases.read("factory"))).actorRefs,
      ).toEqual(expected);
      expect(
        await runtime.runPromise(canvases.activeActorRefs()),
      ).toEqual(expected);
    } finally {
      await runtime.dispose();
    }
  });
});
