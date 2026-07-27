import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Either, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  workTaskClaim,
  workTaskCreate,
  workTaskDescribe,
  type WorkIds,
} from "../src/shared/work";
import {
  WorkRepository,
  WorkRepositoryLive,
  stationEventFromWorkEvent,
} from "../src/main/vellum/work/repository";
import { makeStateEngineLive } from "../src/main/vellum/state/engine";
import { Schema } from "effect";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
} from "../src/shared/station-api";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

const runtime = () => {
  const root = join(tmpdir(), `vellum-work-replication-${randomUUID()}`);
  roots.push(root);
  return ManagedRuntime.make(
    Layer.provideMerge(
      WorkRepositoryLive,
      makeStateEngineLive(join(root, "vellum.db")),
    ),
  );
};

const installation = (value: string): InstallationIdValue =>
  Schema.decodeUnknownSync(InstallationId)(value);

const ids = (prefix: string): WorkIds => {
  let task = 0;
  let message = 0;
  return {
    id: () => `${prefix}-task-${++task}`,
    messageId: () => `${prefix}-message-${++message}`,
  };
};

const taskCanvas = (nodeId: string, host: string): CanvasDoc => ({
  nodes: [{
    id: nodeId,
    type: "text",
    text: "station task sink",
    x: 0,
    y: 0,
    width: 220,
    height: 100,
    ether: {
      entity: { kind: "task" },
      host,
    },
  }],
  edges: [],
});

const createTask = (
  repository: typeof WorkRepository.Service,
  input: {
    readonly canvasName: string;
    readonly nodeId: string;
    readonly entityHome: string;
    readonly eventHome: string;
    readonly brief: string;
    readonly ids: WorkIds;
  },
) =>
  repository.mutate({
    canvasName: input.canvasName,
    nodeId: input.nodeId,
    entityHome: input.entityHome,
    eventHome: input.eventHome,
    operation: "task.create",
    authoredDoc: taskCanvas(input.nodeId, input.entityHome),
    transform: (projected) => {
      const result = workTaskCreate(
        projected,
        input.canvasName,
        input.nodeId,
        input.brief,
        undefined,
        input.ids,
      );
      return { doc: result.doc, value: result.task };
    },
  });

describe("WorkRepository station replication", () => {
  it("atomically materializes a remotely homed task and its linked brief without an inbox", async () => {
    const commandCenter = runtime();
    const remote = runtime();
    const source = await commandCenter.runPromise(WorkRepository);
    const target = await remote.runPromise(WorkRepository);
    const cc = installation("cc-main");

    await commandCenter.runPromise(
      createTask(source, {
        canvasName: "factory",
        nodeId: "remote-tasks",
        entityHome: "studio",
        eventHome: cc,
        brief: "render the release",
        ids: ids("cc"),
      }),
    );
    const outbound = await commandCenter.runPromise(
      source.eventsAfter({
        eventHome: cc,
        entityHome: "studio",
        afterSeq: "0",
      }),
    );

    const accepted = await remote.runPromise(
      target.acceptReplicated({
        eventHome: cc,
        entityHome: "studio",
        events: outbound.map(stationEventFromWorkEvent),
        receivedAt: "2026-07-27T12:00:00.000Z",
      }),
    );
    expect(accepted).toMatchObject({
      accepted: 1,
      idempotent: 0,
      acknowledgement: { home: cc, through: "1" },
    });

    const snapshot = await remote.runPromise(
      target.readSnapshot("factory", "remote-tasks"),
    );
    expect(snapshot.tasks.items).toHaveLength(1);
    expect(snapshot.tasks.items[0]?.history[0]?.parts[0]).toEqual({
      kind: "text",
      text: "render the release",
    });
    expect(snapshot.messages.items).toEqual([]);

    const retry = await remote.runPromise(
      target.acceptReplicated({
        eventHome: cc,
        entityHome: "studio",
        events: outbound.map(stationEventFromWorkEvent),
      }),
    );
    expect(retry).toMatchObject({
      accepted: 0,
      idempotent: 1,
      acknowledgement: { home: cc, through: "1" },
    });

    await commandCenter.dispose();
    await remote.dispose();
  });

  it("does not acknowledge a concurrent command that loses its causal predecessor", async () => {
    const commandCenter = runtime();
    const remote = runtime();
    const source = await commandCenter.runPromise(WorkRepository);
    const target = await remote.runPromise(WorkRepository);
    const cc = installation("cc-concurrent");
    const station = installation("station-studio");
    const sourceIds = ids("cc");
    const remoteIds = ids("remote");
    const doc = taskCanvas("remote-tasks", "studio");

    const created = await commandCenter.runPromise(
      createTask(source, {
        canvasName: "factory",
        nodeId: "remote-tasks",
        entityHome: "studio",
        eventHome: cc,
        brief: "initial brief",
        ids: sourceIds,
      }),
    );
    const createEvents = await commandCenter.runPromise(
      source.eventsAfter({
        eventHome: cc,
        entityHome: "studio",
        afterSeq: "0",
      }),
    );
    await remote.runPromise(
      target.acceptReplicated({
        eventHome: cc,
        entityHome: "studio",
        events: createEvents.map(stationEventFromWorkEvent),
      }),
    );

    await remote.runPromise(
      target.mutate({
        canvasName: "factory",
        nodeId: "remote-tasks",
        entityHome: "studio",
        eventHome: station,
        operation: "task.claim",
        authoredDoc: doc,
        transform: (projected) => {
          const result = workTaskClaim(
            projected,
            "factory",
            "remote-tasks",
            created.value.id,
            "agent-studio",
            remoteIds,
          );
          return { doc: result.doc, value: result.task };
        },
      }),
    );
    await commandCenter.runPromise(
      source.mutate({
        canvasName: "factory",
        nodeId: "remote-tasks",
        entityHome: "studio",
        eventHome: cc,
        operation: "task.describe",
        authoredDoc: doc,
        transform: (projected) => {
          const result = workTaskDescribe(
            projected,
            "factory",
            "remote-tasks",
            created.value.id,
            "concurrent replacement",
            sourceIds,
          );
          return { doc: result.doc, value: result.task };
        },
      }),
    );
    const concurrentCommand = await commandCenter.runPromise(
      source.eventsAfter({
        eventHome: cc,
        entityHome: "studio",
        afterSeq: "1",
      }),
    );

    const conflict = await remote.runPromise(
      target.acceptReplicated({
        eventHome: cc,
        entityHome: "studio",
        events: concurrentCommand.map(stationEventFromWorkEvent),
      }).pipe(Effect.either),
    );
    expect(Either.isLeft(conflict)).toBe(true);
    if (Either.isLeft(conflict)) {
      expect(conflict.left).toMatchObject({
        _tag: "WorkReplicationError",
        reason: "causal-conflict",
        eventHome: cc,
        sequence: "2",
      });
    }

    const snapshot = await remote.runPromise(
      target.readSnapshot("factory", "remote-tasks"),
    );
    expect(snapshot.tasks.items[0]).toMatchObject({
      state: "working",
      metadata: { claimedBy: "agent-studio" },
    });
    const retryCreate = await remote.runPromise(
      target.acceptReplicated({
        eventHome: cc,
        entityHome: "studio",
        events: createEvents.map(stationEventFromWorkEvent),
      }),
    );
    expect(retryCreate.acknowledgement.through).toBe("1");

    await commandCenter.dispose();
    await remote.dispose();
  });

  it("allocates independent route sequences and accepts two Remote seq-1 result streams", async () => {
    const commandCenter = runtime();
    const remoteA = runtime();
    const remoteB = runtime();
    const ccRepository = await commandCenter.runPromise(WorkRepository);
    const repositoryA = await remoteA.runPromise(WorkRepository);
    const repositoryB = await remoteB.runPromise(WorkRepository);
    const cc = installation("cc-routes");
    const stationA = installation("station-a");
    const stationB = installation("station-b");

    for (const route of [
      {
        repository: repositoryA,
        runtime: remoteA,
        host: "host-a",
        node: "tasks-a",
        station: stationA,
      },
      {
        repository: repositoryB,
        runtime: remoteB,
        host: "host-b",
        node: "tasks-b",
        station: stationB,
      },
    ]) {
      const routeIds = ids(route.host);
      const created = await commandCenter.runPromise(
        createTask(ccRepository, {
          canvasName: "factory",
          nodeId: route.node,
          entityHome: route.host,
          eventHome: cc,
          brief: `work for ${route.host}`,
          ids: routeIds,
        }),
      );
      const commands = await commandCenter.runPromise(
        ccRepository.eventsAfter({
          eventHome: cc,
          entityHome: route.host,
          afterSeq: "0",
        }),
      );
      expect(commands.map((event) => event.seq)).toEqual(["1"]);
      expect(
        commands.every((event) => event.homeStation === route.host),
      ).toBe(true);
      await route.runtime.runPromise(
        route.repository.acceptReplicated({
          eventHome: cc,
          entityHome: route.host,
          events: commands.map(stationEventFromWorkEvent),
        }),
      );
      await route.runtime.runPromise(
        route.repository.mutate({
          canvasName: "factory",
          nodeId: route.node,
          entityHome: route.host,
          eventHome: route.station,
          operation: "task.claim",
          authoredDoc: taskCanvas(route.node, route.host),
          transform: (projected) => {
            const result = workTaskClaim(
              projected,
              "factory",
              route.node,
              created.value.id,
              `agent-${route.host}`,
              routeIds,
            );
            return { doc: result.doc, value: result.task };
          },
        }),
      );
      const result = await route.runtime.runPromise(
        route.repository.eventsAfter({
          eventHome: route.station,
          entityHome: route.host,
          afterSeq: "0",
        }),
      );
      expect(result.map((event) => event.seq)).toEqual(["1"]);
      const accepted = await commandCenter.runPromise(
        ccRepository.acceptReplicated({
          eventHome: route.station,
          entityHome: route.host,
          events: result.map(stationEventFromWorkEvent),
        }),
      );
      expect(accepted.acknowledgement).toEqual({
        home: route.station,
        through: "1",
      });
    }

    await commandCenter.dispose();
    await remoteA.dispose();
    await remoteB.dispose();
  });
});
