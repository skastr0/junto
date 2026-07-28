import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Effect,
  Layer,
  ManagedRuntime,
  Schema,
} from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigureRequest,
  InstallationId,
  LogicalSequence,
  PairRequest,
  ProjectRequest,
  STATION_API_PROTOCOL,
  StationHostId,
} from "../src/shared/station-api";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  CanvasesLive,
  CanvasesService,
} from "../src/main/vellum/canvases";
import {
  makeStateEngineLive,
  StateEngine,
  type StateRow,
} from "../src/main/vellum/state/engine";
import {
  StationRepository,
  makeStationRepositoryLive,
  stationProjectionContentSha256,
} from "../src/main/vellum/station/repository";
import { compileStationPortfolioBody } from "../src/main/vellum/station/portfolio";
import { WorkRepositoryLive } from "../src/main/vellum/work/repository";

const decodeInstallationId = Schema.decodeUnknownSync(InstallationId);
const decodeSequence = Schema.decodeUnknownSync(LogicalSequence);
const decodeHostId = Schema.decodeUnknownSync(StationHostId);

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

const note = (text: string): CanvasDoc => ({
  nodes: [
    {
      id: "note",
      type: "text",
      x: 0,
      y: 0,
      width: 240,
      height: 100,
      text,
    },
  ],
  edges: [],
});

describe("CanvasesService Station projection", () => {
  it("reads Remote intent from the complete projection and refuses authorship", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-canvas-station-"));
    roots.push(root);
    const local = decodeInstallationId("remote-installation");
    const commandCenter = decodeInstallationId("command-installation");
    const state = makeStateEngineLive(join(root, "vellum.db"));
    const repositories = Layer.provideMerge(
      Layer.mergeAll(
        WorkRepositoryLive,
        makeStationRepositoryLive({
          makeInstallationId: () => local,
          now: () => "2026-07-27T12:00:00.000Z",
        }),
      ),
      state,
    );
    const runtime = ManagedRuntime.make(
      Layer.provideMerge(CanvasesLive, repositories),
    );

    try {
      const { canvases, station, stateEngine } = await runtime.runPromise(
        Effect.gen(function* () {
          return {
            canvases: yield* CanvasesService,
            station: yield* StationRepository,
            stateEngine: yield* StateEngine,
          };
        }),
      );
      await runtime.runPromise(
        canvases.write("local-draft", note("must not survive cutover")),
      );
      expect(
        await runtime.runPromise(canvases.liveAuthorityGeneration()),
      ).toBe("1");

      await runtime.runPromise(
        station.pair(
          PairRequest.make({
            protocol: STATION_API_PROTOCOL,
            op: "pair",
            commandCenterInstallationId: commandCenter,
            stationInstallationId: local,
            stationLabel: "Studio Mini",
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
              hostId: decodeHostId("studio"),
              agentHostId: decodeHostId("studio"),
              commandCenterInstallationId: commandCenter,
              supervisedPreferred: true,
            },
            host: {
              id: "studio",
              label: "Studio Mini",
              kind: "remote",
              sshEndpoint: "studio",
              capabilities: ["terminal", "browser", "hermes"],
            },
          }),
        ),
      );
      const body = compileStationPortfolioBody(
        new Map([["command-floor", note("remote intent")]]),
        new Map([["studio", local]]),
      );
      await runtime.runPromise(
        station.installProjection(
          ProjectRequest.make({
            protocol: STATION_API_PROTOCOL,
            op: "project",
            stationInstallationId: local,
            projection: {
              scope: "full",
              generation: decodeSequence("8"),
              sourceCanvasGeneration: decodeSequence("3"),
              sourceIntentSha256:
                stationProjectionContentSha256("remote intent source"),
              body,
              contentSha256: stationProjectionContentSha256(body),
              createdAt: "2026-07-27T12:01:00.000Z",
            },
          }),
        ),
      );

      expect(
        (await runtime.runPromise(canvases.list)).map((row) => row.name),
      ).toEqual(["command-floor"]);
      expect(
        (await runtime.runPromise(canvases.read("command-floor"))).doc
          .nodes[0],
      ).toMatchObject({ text: "remote intent" });
      const projectedWitness = await runtime.runPromise(
        canvases.readWithIntentWitness("command-floor"),
      );
      expect(projectedWitness).toMatchObject({
        read: { name: "command-floor" },
        intentWitness: {
          generation: "8",
          contentSha256: stationProjectionContentSha256(body),
        },
      });
      await expect(
        runtime.runPromise(canvases.read("local-draft")),
      ).rejects.toThrow("active portfolio");
      await expect(
        runtime.runPromise(
          canvases.write("command-floor", note("remote forged")),
        ),
      ).rejects.toThrow("Remote installations");

      const authorialRows = await runtime.runPromise(
        stateEngine.read("test.remote-authorial-rows", (reader) => ({
          heads: Number(
            reader.get<StateRow & { readonly count: number }>(
              "SELECT count(*) AS count FROM canvas_head",
            )?.count ?? -1,
          ),
          documents: Number(
            reader.get<StateRow & { readonly count: number }>(
              "SELECT count(*) AS count FROM canvas_generation_documents",
            )?.count ?? -1,
          ),
          generations: Number(
            reader.get<StateRow & { readonly count: number }>(
              "SELECT count(*) AS count FROM canvas_generations",
            )?.count ?? -1,
          ),
        })),
      );
      expect(authorialRows).toEqual({
        heads: 0,
        documents: 0,
        generations: 0,
      });
    } finally {
      await runtime.dispose();
    }
  });
});
