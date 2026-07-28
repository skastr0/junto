import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Effect,
  Either,
  Layer,
  ManagedRuntime,
  Schema,
} from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
} from "../src/shared/installation-id";
import {
  HostId,
  type HostId as HostIdValue,
} from "../src/shared/remote-hosts";
import {
  ConfigureRequest,
  LogicalSequence,
  PairRequest,
  ProjectRequest,
  STATION_API_PROTOCOL,
  StationHostId,
  type StationReadiness,
} from "../src/shared/station-api";
import type { ActorRef } from "../src/shared/work-protocol";
import {
  CanvasesLive,
  CanvasesService,
} from "../src/main/vellum/canvases";
import {
  SettingsLive,
  SettingsService,
} from "../src/main/vellum/settings/service";
import {
  StationApiLive,
  StationApiService,
} from "../src/main/vellum/station/api";
import {
  deriveActorSeatId,
} from "../src/main/vellum/station/actor-seat-compiler";
import {
  StationFleetTargetRepository,
  StationFleetTargetRepositoryLive,
} from "../src/main/vellum/station/fleet-target-repository";
import {
  compileStationPortfolioBody,
} from "../src/main/vellum/station/portfolio";
import {
  makeStationRepositoryLive,
  stationProjectionContentSha256,
} from "../src/main/vellum/station/repository";
import {
  makeStateEngineLive,
} from "../src/main/vellum/state/engine";
import {
  WorkAuthorityError,
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/vellum/work/repository";

const now = "2026-07-27T18:00:00.000Z";
const strictDecode = { onExcessProperty: "error" } as const;
const readiness: StationReadiness = {
  database: true,
  workControl: true,
  simulation: true,
  session: true,
};

const installation = (value: string): InstallationIdValue =>
  Schema.decodeUnknownSync(InstallationId)(value);

const hostId = (value: string): HostIdValue =>
  Schema.decodeUnknownSync(HostId)(value);

const stationHostId = (value: string) =>
  Schema.decodeUnknownSync(StationHostId)(value);

const generation = (value: string) =>
  Schema.decodeUnknownSync(LogicalSequence)(value);

const makeInstallationRuntime = (
  databasePath: string,
  localInstallationId: InstallationIdValue,
) => {
  const state = makeStateEngineLive(databasePath);
  const repositories = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      makeStationRepositoryLive({
        makeInstallationId: () => localInstallationId,
        now: () => now,
      }),
      StationFleetTargetRepositoryLive,
      SettingsLive,
    ),
    state,
  );
  const canvases = Layer.provideMerge(CanvasesLive, repositories);
  return ManagedRuntime.make(
    Layer.provideMerge(StationApiLive, canvases),
  );
};

type InstallationHarness = {
  readonly root: string;
  readonly runtime: ReturnType<typeof makeInstallationRuntime>;
  readonly api: typeof StationApiService.Service;
  readonly canvases: typeof CanvasesService.Service;
  readonly work: typeof WorkRepository.Service;
  readonly settings: typeof SettingsService.Service;
  readonly fleetTargets: typeof StationFleetTargetRepository.Service;
};

const opened: Array<InstallationHarness> = [];

afterEach(async () => {
  const closing = opened.splice(0);
  await Promise.all(closing.map(({ runtime }) => runtime.dispose()));
  await Promise.all(
    closing.map(({ root }) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

const openInstallation = async (
  localInstallationId: InstallationIdValue,
): Promise<InstallationHarness> => {
  const root = await mkdtemp(
    join(tmpdir(), `vellum-station-offline-${localInstallationId}-`),
  );
  const runtime = makeInstallationRuntime(
    join(root, "vellum.db"),
    localInstallationId,
  );
  const services = await runtime.runPromise(
    Effect.gen(function* () {
      return {
        api: yield* StationApiService,
        canvases: yield* CanvasesService,
        work: yield* WorkRepository,
        settings: yield* SettingsService,
        fleetTargets: yield* StationFleetTargetRepository,
      };
    }),
  );
  const harness = {
    root,
    runtime,
    ...services,
  } satisfies InstallationHarness;
  opened.push(harness);
  return harness;
};

const message = (
  messageId: string,
  role: "user" | "agent",
  text: string,
  taskId: string,
) => ({
  messageId,
  role,
  parts: [{ kind: "text" as const, text }],
  taskId,
  contextId: "factory",
});

describe("Station work authority survives Command Center downtime", () => {
  it("adopts one live-reserved CC task, progresses it offline, and reconciles by route sequence", async () => {
    const commandCenterId = installation("cc-offline-roundtrip");
    const remoteId = installation("remote-offline-roundtrip");
    const remoteHost = hostId("remote");
    const remoteStationHost = stationHostId(remoteHost);
    const commandCenter = await openInstallation(commandCenterId);
    const remote = await openInstallation(remoteId);
    const bindingId = "binding-remote-worker";
    const actor: ActorRef = {
      seatId: deriveActorSeatId(remoteId, bindingId),
      canvasName: "factory",
      nodeId: "remote-worker",
    };
    const sink = {
      canvasName: "factory",
      nodeId: "shared-tasks",
    };
    const document: CanvasDoc = {
      nodes: [
        {
          id: sink.nodeId,
          type: "text",
          x: 0,
          y: 0,
          width: 240,
          height: 100,
          text: "Shared Command Center tasks",
          ether: {
            entity: { kind: "task" },
            host: "local",
          },
        },
        {
          id: actor.nodeId,
          type: "text",
          x: 320,
          y: 0,
          width: 240,
          height: 100,
          text: "Remote worker",
          ether: {
            entity: { kind: "agent", name: "remote:builder" },
            host: remoteHost,
            terminal: {
              bindingId,
              harness: "codex",
              launch: { kind: "harness", argv: ["codex"] },
            },
          },
        },
      ],
      edges: [
        {
          id: "remote-worker-to-shared-tasks",
          fromNode: actor.nodeId,
          toNode: sink.nodeId,
        },
      ],
    };

    await commandCenter.runtime.runPromise(
      commandCenter.settings.setStationTopology({
        role: "command-center",
        hostId: "local",
        supervisedPreferred: true,
      }),
    );
    await commandCenter.runtime.runPromise(
      commandCenter.fleetTargets.bind(
        {
          hostId: remoteHost,
          stationInstallationId: remoteId,
        },
        now,
      ),
    );
    await commandCenter.runtime.runPromise(
      commandCenter.canvases.write("factory", document),
    );

    await remote.runtime.runPromise(
      remote.api.handle(
        PairRequest.make({
          protocol: STATION_API_PROTOCOL,
          op: "pair",
          commandCenterInstallationId: commandCenterId,
          stationInstallationId: remoteId,
          stationLabel: "Remote",
          appVersion: "0.1.0",
        }),
        readiness,
        { _tag: "command-center-route" },
      ),
    );
    await remote.runtime.runPromise(
      remote.api.handle(
        ConfigureRequest.make({
          protocol: STATION_API_PROTOCOL,
          op: "configure",
          installationId: remoteId,
          configuration: {
            role: "remote",
            hostId: remoteStationHost,
            agentHostId: remoteStationHost,
            commandCenterInstallationId: commandCenterId,
            supervisedPreferred: true,
          },
          host: {
            id: remoteHost,
            label: "Remote",
            kind: "remote",
            sshEndpoint: "remote",
            capabilities: ["terminal"],
          },
        }),
        readiness,
        { _tag: "command-center-route" },
      ),
    );

    const authority = await commandCenter.runtime.runPromise(
      commandCenter.canvases.authoritySnapshot(),
    );
    const projectionBody = compileStationPortfolioBody(
      authority.documents,
      new Map([
        ["local", commandCenterId],
        [remoteHost, remoteId],
      ]),
    );
    await remote.runtime.runPromise(
      remote.api.handle(
        ProjectRequest.make({
          protocol: STATION_API_PROTOCOL,
          op: "project",
          stationInstallationId: remoteId,
          projection: {
            scope: "full",
            generation: generation("1"),
            body: projectionBody,
            contentSha256:
              stationProjectionContentSha256(projectionBody),
            createdAt: now,
          },
        }),
        readiness,
        { _tag: "command-center-route" },
      ),
    );

    const firstTaskId = "task-offline-roundtrip";
    const secondTaskId = "task-must-not-claim-offline";
    await commandCenter.runtime.runPromise(
      commandCenter.work.createTask({
        sink,
        task: {
          id: firstTaskId,
          state: "submitted",
          history: [
            message(
              "brief-offline-roundtrip",
              "user",
              "ship while Command Center is offline",
              firstTaskId,
            ),
          ],
        },
        originAt: now,
        receivedAt: now,
      }),
    );
    await commandCenter.runtime.runPromise(
      commandCenter.work.createTask({
        sink,
        task: {
          id: secondTaskId,
          state: "submitted",
          history: [
            message(
              "brief-must-not-claim-offline",
              "user",
              "remain at Command Center until a live reservation",
              secondTaskId,
            ),
          ],
        },
        originAt: now,
        receivedAt: now,
      }),
    );
    await commandCenter.runtime.runPromise(
      commandCenter.work.reserveRemoteTaskClaim({
        targetInstallationId: remoteId,
        sink,
        taskId: firstTaskId,
        actor,
        originAt: now,
        receivedAt: now,
      }),
    );

    const claimRequest = await commandCenter.runtime.runPromise(
      commandCenter.api.prepareReport(remoteId),
    );
    expect(claimRequest.batch.records).toHaveLength(1);
    expect(claimRequest.batch.records[0]).toMatchObject({
      recordType: "command",
      operation: "task.claim",
      id: {
        route: {
          eventHome: commandCenterId,
          entityHome: remoteId,
        },
        seq: "1",
      },
      body: {
        operation: "task.claim",
        sourceQueueHome: commandCenterId,
        targetHome: remoteId,
        actor,
        sourceTask: {
          id: firstTaskId,
          state: "submitted",
        },
      },
    });

    const claimResponse = await remote.runtime.runPromise(
      remote.api.handle(
        claimRequest,
        readiness,
        { _tag: "command-center-route" },
      ),
    );
    if (claimResponse.op !== "report") {
      throw new Error("claim report did not produce a report response");
    }
    expect(claimResponse.batch.records).toHaveLength(2);
    expect(
      claimResponse.batch.records.map((record) => record.recordType),
    ).toEqual(["fact", "disposition"]);
    expect(claimResponse.batch.records[0]).toMatchObject({
      recordType: "fact",
      operation: "task.claim",
      id: {
        route: { eventHome: remoteId, entityHome: remoteId },
        seq: "1",
      },
      body: {
        operation: "task.claim",
        previousHome: commandCenterId,
        claimedBy: actor,
        task: {
          id: firstTaskId,
          state: "working",
          claimedBy: actor.seatId,
        },
      },
    });
    expect(claimResponse.batch.records[1]).toMatchObject({
      recordType: "disposition",
      id: {
        route: { eventHome: remoteId, entityHome: remoteId },
        seq: "2",
      },
      body: {
        status: "applied",
        command: claimRequest.batch.records[0]?.id,
      },
    });

    expect(
      (
        await remote.runtime.runPromise(
          remote.work.readSnapshot(sink.canvasName, sink.nodeId),
        )
      ).tasks.items,
    ).toEqual([
      expect.objectContaining({
        id: firstTaskId,
        state: "working",
        claimedBy: actor.seatId,
      }),
    ]);
    expect(
      await remote.runtime.runPromise(
        remote.work.itemHome(
          "task",
          sink.canvasName,
          sink.nodeId,
          firstTaskId,
        ),
      ),
    ).toBe(remoteId);

    await commandCenter.runtime.runPromise(
      commandCenter.api.acceptReportResponse(
        remoteId,
        claimRequest,
        claimResponse,
      ),
    );
    const commandCenterAfterClaim =
      await commandCenter.runtime.runPromise(
        commandCenter.work.readSnapshot(
          sink.canvasName,
          sink.nodeId,
        ),
      );
    expect(commandCenterAfterClaim.tasks.items).toHaveLength(2);
    expect(commandCenterAfterClaim.tasks.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: firstTaskId,
          state: "working",
          claimedBy: actor.seatId,
        }),
        expect.objectContaining({
          id: secondTaskId,
          state: "submitted",
        }),
      ]),
    );
    expect(
      await commandCenter.runtime.runPromise(
        commandCenter.work.itemHome(
          "task",
          sink.canvasName,
          sink.nodeId,
          firstTaskId,
        ),
      ),
    ).toBe(remoteId);

    // No Command Center effect runs between this point and the later report.
    // The Remote owns the adopted row and can durably advance it by itself.
    const unreservedOfflineClaim = await remote.runtime.runPromise(
      remote.work.claimLocalTask({
        sink,
        taskId: secondTaskId,
        actor,
        originAt: now,
        receivedAt: now,
      }).pipe(Effect.either),
    );
    expect(Either.isLeft(unreservedOfflineClaim)).toBe(true);
    if (Either.isLeft(unreservedOfflineClaim)) {
      expect(unreservedOfflineClaim.left).toBeInstanceOf(
        WorkAuthorityError,
      );
      expect(unreservedOfflineClaim.left).toMatchObject({
        reason: "missing-entity",
      });
    }

    const completed = await remote.runtime.runPromise(
      remote.work.transitionTask({
        sink,
        taskId: firstTaskId,
        state: "completed",
        message: message(
          "done-offline-roundtrip",
          "agent",
          "completed without Command Center",
          firstTaskId,
        ),
        // Display time deliberately ties every fact. Logical route sequence,
        // not wall clock/LWW, establishes the terminal state.
        originAt: now,
        receivedAt: now,
      }),
    );
    expect(completed.record).toMatchObject({
      recordType: "fact",
      operation: "task.transition",
      id: {
        route: { eventHome: remoteId, entityHome: remoteId },
        seq: "3",
      },
      predecessor: claimResponse.batch.records[0]?.id,
      body: {
        operation: "task.transition",
        task: {
          id: firstTaskId,
          state: "completed",
          claimedBy: actor.seatId,
        },
      },
    });

    const progressRequest = await remote.runtime.runPromise(
      remote.api.prepareReport(commandCenterId),
    );
    expect(
      progressRequest.batch.records.map((record) => [
        record.recordType,
        record.operation,
        record.id.seq,
      ]),
    ).toEqual([
      ["fact", "task.claim", "1"],
      ["disposition", "task.claim", "2"],
      ["fact", "task.transition", "3"],
    ]);

    const progressResponse = await commandCenter.runtime.runPromise(
      commandCenter.api.handle(
        progressRequest,
        readiness,
        {
          _tag: "enrolled-remote",
          installationId: remoteId,
        },
      ),
    );
    if (progressResponse.op !== "report") {
      throw new Error("progress report did not produce a report response");
    }
    await remote.runtime.runPromise(
      remote.api.acceptReportResponse(
        commandCenterId,
        progressRequest,
        progressResponse,
      ),
    );

    const reconciled = await commandCenter.runtime.runPromise(
      commandCenter.work.readSnapshot(
        sink.canvasName,
        sink.nodeId,
      ),
    );
    expect(reconciled.tasks.items).toHaveLength(2);
    expect(reconciled.tasks.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: firstTaskId,
          state: "completed",
          claimedBy: actor.seatId,
        }),
        expect.objectContaining({
          id: secondTaskId,
          state: "submitted",
        }),
      ]),
    );
    expect(
      await commandCenter.runtime.runPromise(
        commandCenter.work.itemHome(
          "task",
          sink.canvasName,
          sink.nodeId,
          firstTaskId,
        ),
      ),
    ).toBe(remoteId);
  });
});
