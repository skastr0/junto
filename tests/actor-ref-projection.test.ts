import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
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
} from "../src/main/junto/canvases";
import {
  makeStateEngineLive,
} from "../src/main/junto/state/engine";
import {
  StationFleetTargetRepository,
  StationFleetTargetRepositoryLive,
} from "../src/main/junto/station/fleet-target-repository";
import {
  makeStationRepositoryLive,
  StationRepository,
  stationProjectionContentSha256,
} from "../src/main/junto/station/repository";
import {
  compileStationPortfolioBody,
} from "../src/main/junto/station/portfolio";
import { deriveActorSeatId } from "../src/main/junto/station/actor-seat-compiler";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";

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
  const state = makeStateEngineLive(join(root, "junto.db"));
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
      "junto-actor-ref-command-",
      "installation-command",
    );
    const localInstallationId = installation("installation-command");
    const remoteInstallationId = installation("installation-remote");

    try {
      const { canvases, fleetTargets, sql } = await runtime.runPromise(
        Effect.gen(function* () {
          return {
            canvases: yield* CanvasesService,
            fleetTargets: yield* StationFleetTargetRepository,
            sql: yield* SqlClient.SqlClient,
          };
        }),
      );
      await runtime.runPromise(
        sql.withTransaction(sql`INSERT INTO station_configuration(
               singleton,
               role,
               host_id,
               agent_host_id,
               command_center_installation_id,
               supervised_preferred,
               configured_at
             ) VALUES (1, 'command-center', 'local', NULL, NULL, 0, ${"2026-07-27T12:00:00.000Z"})`),
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
      expect([...(await runtime.runPromise(canvases.activeActorRefs()))].sort((left, right) => left.seatId.localeCompare(right.seatId) || left.canvasName.localeCompare(right.canvasName))).toEqual(
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

      const beforeRefs = [...(await runtime.runPromise(canvases.activeActorRefs()))].sort((left, right) => left.seatId.localeCompare(right.seatId) || left.canvasName.localeCompare(right.canvasName));
      await expect(
        runtime.runPromise(
          canvases.write(
            "unresolved",
            actorDoc(
              "lost-agent",
              "missing-host",
              "binding-lost",
              "missing-host:codex",
            ),
          ),
        ),
      ).rejects.toThrow("unresolved host");
      expect(await runtime.runPromise(canvases.read("alpha"))).toEqual(alpha);
      expect([...(await runtime.runPromise(canvases.activeActorRefs()))].sort((left, right) => left.seatId.localeCompare(right.seatId) || left.canvasName.localeCompare(right.canvasName))).toEqual(beforeRefs);
    } finally {
      await runtime.dispose();
    }
  });


});
