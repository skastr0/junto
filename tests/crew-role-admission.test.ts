import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigureRequest,
  InstallationId,
  PairRequest,
  STATION_API_PROTOCOL,
  StationHostId,
} from "../src/shared/station-api";
import type { VerdictPostArgs } from "../src/shared/work-control";
import { ActorRef } from "../src/shared/work-reference";
import { CanvasesLive } from "../src/main/vellum-command/canvases";
import { makeContentServiceLive } from "../src/main/vellum-command/content/service";
import { makeInstallOpsLive } from "../src/main/vellum-command/install-ops/engine";
import { makeSettingsLive, SettingsService } from "../src/main/vellum-command/settings/service";
import { makeStateEngineLive } from "../src/main/vellum-command/state/engine";
import { StationFleetTargetRepositoryLive } from "../src/main/vellum-command/station/fleet-target-repository";
import { StationRepository, StationRepositoryLive } from "../src/main/vellum-command/station/repository";
import { StationLivePeerRegistryLive } from "../src/main/vellum-command/station/session-registry";
import { CrewRepository, CrewRepositoryLive } from "../src/main/vellum-command/work/crew-repository";
import { WorkRepositoryLive } from "../src/main/vellum-command/work/repository";
import { WorkLive, WorkService } from "../src/main/vellum-command/work/service";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const makeFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "vellum-command-crew-role-"));
  const repositories = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      StationRepositoryLive,
      StationFleetTargetRepositoryLive,
      makeSettingsLive({ ensureDefaultCommandCenter: false }),
      makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
    ),
    Layer.mergeAll(
      makeStateEngineLive(join(root, "vellum-command.db")),
      makeInstallOpsLive(join(root, "install-ops.db")),
    ),
  );
  const runtime = ManagedRuntime.make(Layer.provideMerge(
    WorkLive,
    Layer.mergeAll(Layer.provideMerge(CanvasesLive, repositories), StationLivePeerRegistryLive),
  ));
  cleanups.push(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const services = await runtime.runPromise(Effect.gen(function* () {
    return {
      work: yield* WorkService,
      stations: yield* StationRepository,
      settings: yield* SettingsService,
      crew: yield* CrewRepository,
    };
  }));
  expect(await runtime.runPromise(services.stations.configuration)).toBeUndefined();
  return { runtime, ...services };
};

const configureRemote = async ({ runtime, stations }: Awaited<ReturnType<typeof makeFixture>>) => {
  const local = await runtime.runPromise(stations.installationId);
  const commandCenter = Schema.decodeUnknownSync(InstallationId)("crew-role-command-center");
  const hostId = Schema.decodeUnknownSync(StationHostId)("crew-role-remote");
  await runtime.runPromise(stations.pair(PairRequest.make({
    protocol: STATION_API_PROTOCOL,
    op: "pair",
    commandCenterInstallationId: commandCenter,
    stationInstallationId: local,
    stationLabel: "Crew role fixture",
    appVersion: "test",
  })));
  await runtime.runPromise(stations.configureRemote(ConfigureRequest.make({
    protocol: STATION_API_PROTOCOL,
    op: "configure",
    installationId: local,
    configuration: {
      role: "remote",
      hostId,
      agentHostId: hostId,
      commandCenterInstallationId: commandCenter,
      supervisedPreferred: true,
    },
    host: {
      id: hostId,
      label: "Crew role fixture",
      kind: "remote",
      capabilities: ["terminal"],
    },
  })));
  expect(await runtime.runPromise(stations.configuration)).toMatchObject({
    configuration: { role: "remote", commandCenterInstallationId: commandCenter },
  });
};

const refusal = {
  code: "scope_error",
  details: { reason: "crew-command-center-only", retryable: false },
};
const reviewer = Schema.decodeUnknownSync(ActorRef)({
  seatId: `seat_${"c".repeat(64)}`,
  canvasName: "unopened-factory",
  nodeId: "reviewer",
});
const sha = "a".repeat(40);
const subjects: ReadonlyArray<VerdictPostArgs["subject"]> = [
  { kind: "commit", sha },
  { kind: "task", taskId: "task", epoch: 0, subjectHash: "b".repeat(64) },
];

describe("crew station role admission through real WorkService", () => {
  it.each(["unconfigured", "remote"] as const)(
    "refuses %s admission and direct verdicts before reading a canvas",
    async (role) => {
      const fixture = await makeFixture();
      const { runtime, work, crew } = fixture;
      if (role === "remote") await configureRemote(fixture);

      await expect(runtime.runPromise(work.crewAdmission)).rejects.toMatchObject(refusal);
      // There is no canvas or projection: the role refusal must win before
      // subject lookup, rather than accidentally failing later on missing data.
      for (const subject of subjects) {
        const posted = await runtime.runPromise(work.workVerdictPost(
          reviewer.canvasName,
          subject.kind === "task" ? "tasks" : "author",
          { subject, kind: "green" },
          reviewer,
        ));
        expect(posted).toMatchObject({ ok: false, ...refusal });
      }
      expect(await runtime.runPromise(crew.verdictsForSubject({ kind: "commit", sha }))).toEqual([]);
    },
  );

  it("admits the same WorkService after real Command Center configuration", async () => {
    const { runtime, work, settings, stations } = await makeFixture();
    await expect(runtime.runPromise(work.crewAdmission)).rejects.toMatchObject(refusal);
    await runtime.runPromise(settings.setStationTopology({
      role: "command-center",
      hostId: "local",
      supervisedPreferred: true,
    }));
    expect(await runtime.runPromise(stations.configuration)).toMatchObject({
      configuration: { role: "command-center" },
    });
    await expect(runtime.runPromise(work.crewAdmission)).resolves.toBeUndefined();
  });
});
