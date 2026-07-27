import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Layer, ManagedRuntime } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  workTaskClaim,
  workTaskCreate,
  workTaskDescribe,
  workTaskTransition,
  type WorkIds,
} from "../src/shared/work";
import {
  COMMAND_CENTER_WORK_HOME,
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/vellum/work/repository";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum/state/engine";

const root = join(tmpdir(), `vellum-work-repository-${randomUUID()}`);
const stateLive = makeStateEngineLive(join(root, "vellum.db"));
const runtime = ManagedRuntime.make(
  Layer.provideMerge(WorkRepositoryLive, stateLive),
);

let repository: Context.Tag.Service<typeof WorkRepository>;
let state: Context.Tag.Service<typeof StateEngine>;

beforeAll(async () => {
  repository = await runtime.runPromise(WorkRepository);
  state = await runtime.runPromise(StateEngine);
});

afterAll(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const ids = (): WorkIds => {
  let task = 0;
  let message = 0;
  return {
    id: () => `task-${++task}`,
    messageId: () => `message-${++message}`,
  };
};

const taskCanvas = (
  nodeId = "tasks",
  host = "station-a",
): CanvasDoc => ({
  nodes: [
    {
      id: nodeId,
      type: "text",
      text: "authorial task sink",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      ether: {
        entity: { kind: "task" },
        host,
      },
    },
  ],
  edges: [],
});

describe("WorkRepository", () => {
  it("allocates exact per-home sequences and reconstructs work independently of canvas", async () => {
    const doc = taskCanvas("tasks-seq");
    const workIds = ids();
    const created = await runtime.runPromise(
      repository.mutate({
        canvasName: "sequence-canvas",
        nodeId: "tasks-seq",
        entityHome: "station-a",
        operation: "task.create",
        authoredDoc: doc,
        transform: (projected) => {
          const result = workTaskCreate(
            projected,
            "sequence-canvas",
            "tasks-seq",
            "ship sqlite",
            undefined,
            workIds,
          );
          return { doc: result.doc, value: result.task };
        },
        originAt: "2026-07-27T12:00:00.000Z",
        receivedAt: "2026-07-27T12:00:01.000Z",
      }),
    );
    expect(created.value.state).toBe("submitted");
    expect(created.projectedDoc.nodes[0]?.ether?.tasks?.items).toHaveLength(1);
    expect(doc.nodes[0]?.ether?.tasks).toBeUndefined();

    await runtime.runPromise(
      repository.mutate({
        canvasName: "sequence-canvas",
        nodeId: "tasks-seq",
        entityHome: "station-a",
        operation: "task.claim",
        authoredDoc: doc,
        transform: (projected) => {
          const result = workTaskClaim(
            projected,
            "sequence-canvas",
            "tasks-seq",
            created.value.id,
            "agent-a",
            workIds,
          );
          return { doc: result.doc, value: result.task };
        },
      }),
    );

    const taskEventsBeforeCompletion = await runtime.runPromise(
      repository.eventsAfter("station-a", "0"),
    );
    expect(taskEventsBeforeCompletion.map((event) => event.seq)).toEqual([
      "1",
      "2",
    ]);
    expect(taskEventsBeforeCompletion.map((event) => event.operation)).toEqual([
      "task.create",
      "task.claim",
    ]);
    expect(taskEventsBeforeCompletion[0]).toMatchObject({
      originAt: "2026-07-27T12:00:00.000Z",
      receivedAt: "2026-07-27T12:00:01.000Z",
    });

    const messageEvents = await runtime.runPromise(
      repository.eventsAfter(COMMAND_CENTER_WORK_HOME, "0"),
    );
    expect(messageEvents.slice(0, 2).map((event) => event.seq)).toEqual([
      "1",
      "2",
    ]);
    expect(
      messageEvents.slice(0, 2).every((event) => event.entityKind === "message"),
    ).toBe(true);

    const snapshot = await runtime.runPromise(
      repository.readSnapshot("sequence-canvas", "tasks-seq"),
    );
    expect(snapshot.tasks.items[0]).toMatchObject({
      id: created.value.id,
      state: "working",
      metadata: { claimedBy: "agent-a" },
    });
    expect(snapshot.tasks.items[0]?.history).toHaveLength(2);

    const claimedPayload = taskEventsBeforeCompletion[1]!.payloadJson;
    await runtime.runPromise(
      repository.mutate({
        canvasName: "sequence-canvas",
        nodeId: "tasks-seq",
        entityHome: "station-a",
        operation: "task.transition",
        authoredDoc: doc,
        transform: (projected) => {
          const result = workTaskTransition(
            projected,
            "sequence-canvas",
            "tasks-seq",
            created.value.id,
            "completed",
            undefined,
            workIds,
          );
          return { doc: result.doc, value: result.task };
        },
      }),
    );
    const taskEventsAfterCompletion = await runtime.runPromise(
      repository.eventsAfter("station-a", "0"),
    );
    expect(taskEventsAfterCompletion.map((event) => event.seq)).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(taskEventsAfterCompletion[1]?.payloadJson).toBe(claimedPayload);
    expect(
      JSON.parse(taskEventsAfterCompletion[1]!.payloadJson).body.task.state,
    ).toBe("working");
    expect(
      JSON.parse(taskEventsAfterCompletion[2]!.payloadJson).body.task.state,
    ).toBe("completed");
    expect(taskEventsAfterCompletion[1]?.contentSha256).not.toBe(
      taskEventsAfterCompletion[2]?.contentSha256,
    );
    expect(taskEventsAfterCompletion[1]?.contentSha256).toBe(
      createHash("sha256")
        .update(taskEventsAfterCompletion[1]!.payloadJson, "utf8")
        .digest("hex"),
    );
    expect(taskEventsAfterCompletion[1]?.entityId).toBe(
      taskEventsAfterCompletion[2]?.entityId,
    );
  });

  it("keeps superseded briefs and transitions append-only", async () => {
    const doc = taskCanvas("tasks-history");
    const workIds = ids();
    const created = await runtime.runPromise(
      repository.mutate({
        canvasName: "history-canvas",
        nodeId: "tasks-history",
        entityHome: "station-a",
        operation: "task.create",
        authoredDoc: doc,
        transform: (projected) => {
          const result = workTaskCreate(
            projected,
            "history-canvas",
            "tasks-history",
            "first brief",
            undefined,
            workIds,
          );
          return { doc: result.doc, value: result.task };
        },
      }),
    );
    await runtime.runPromise(
      repository.mutate({
        canvasName: "history-canvas",
        nodeId: "tasks-history",
        entityHome: "station-a",
        operation: "task.describe",
        authoredDoc: doc,
        transform: (projected) => {
          const result = workTaskDescribe(
            projected,
            "history-canvas",
            "tasks-history",
            created.value.id,
            "replacement brief",
            workIds,
          );
          return { doc: result.doc, value: result.task };
        },
      }),
    );

    const counts = await runtime.runPromise(
      state.read("test.work.history", (reader) => ({
        messages: Number(
          reader.get<{ count: number } & Record<string, string | number | bigint | Uint8Array | null>>(
            `
              SELECT COUNT(*) AS count
              FROM work_messages
              WHERE canvas_name = ? AND node_id = ? AND task_id = ?
            `,
            ["history-canvas", "tasks-history", created.value.id],
          )?.count ?? 0,
        ),
        transitions: Number(
          reader.get<{ count: number } & Record<string, string | number | bigint | Uint8Array | null>>(
            `
              SELECT COUNT(*) AS count
              FROM work_task_transitions
              WHERE canvas_name = ? AND node_id = ? AND task_id = ?
            `,
            ["history-canvas", "tasks-history", created.value.id],
          )?.count ?? 0,
        ),
      })),
    );
    expect(counts).toEqual({ messages: 2, transitions: 1 });

    const snapshot = await runtime.runPromise(
      repository.readSnapshot("history-canvas", "tasks-history"),
    );
    expect(snapshot.tasks.items[0]?.history).toHaveLength(1);
    expect(snapshot.tasks.items[0]?.history[0]?.parts[0]).toEqual({
      kind: "text",
      text: "replacement brief",
    });
  });

  it("returns a full runtime projection across multiple work sinks", async () => {
    const doc: CanvasDoc = {
      nodes: [
        taskCanvas("tasks-left").nodes[0]!,
        {
          ...taskCanvas("tasks-right").nodes[0]!,
          x: 260,
        },
      ],
      edges: [],
    };
    const leftIds = ids();
    const rightIds = ids();
    await runtime.runPromise(
      repository.mutate({
        canvasName: "multi-sink-canvas",
        nodeId: "tasks-left",
        entityHome: "station-a",
        operation: "task.create",
        authoredDoc: doc,
        transform: (projected) => {
          const result = workTaskCreate(
            projected,
            "multi-sink-canvas",
            "tasks-left",
            "left task",
            undefined,
            leftIds,
          );
          return { doc: result.doc, value: result.task };
        },
      }),
    );
    const right = await runtime.runPromise(
      repository.mutate({
        canvasName: "multi-sink-canvas",
        nodeId: "tasks-right",
        entityHome: "station-a",
        operation: "task.create",
        authoredDoc: doc,
        transform: (projected) => {
          const result = workTaskCreate(
            projected,
            "multi-sink-canvas",
            "tasks-right",
            "right task",
            undefined,
            rightIds,
          );
          return { doc: result.doc, value: result.task };
        },
      }),
    );

    expect(
      right.projectedDoc.nodes.find((node) => node.id === "tasks-left")?.ether
        ?.tasks?.items,
    ).toHaveLength(1);
    expect(
      right.projectedDoc.nodes.find((node) => node.id === "tasks-right")?.ether
        ?.tasks?.items,
    ).toHaveLength(1);
  });

  it("refuses an implicit home change", async () => {
    const doc = taskCanvas("tasks-home");
    const workIds = ids();
    const created = await runtime.runPromise(
      repository.mutate({
        canvasName: "home-canvas",
        nodeId: "tasks-home",
        entityHome: "station-a",
        operation: "task.create",
        authoredDoc: doc,
        transform: (projected) => {
          const result = workTaskCreate(
            projected,
            "home-canvas",
            "tasks-home",
            "stay home",
            undefined,
            workIds,
          );
          return { doc: result.doc, value: result.task };
        },
      }),
    );

    await expect(
      runtime.runPromise(
        repository.mutate({
          canvasName: "home-canvas",
          nodeId: "tasks-home",
          entityHome: "station-b",
          operation: "task.describe",
          authoredDoc: doc,
          transform: (projected) => {
            const result = workTaskDescribe(
              projected,
              "home-canvas",
              "tasks-home",
              created.value.id,
              "try to move",
              workIds,
            );
            return { doc: result.doc, value: result.task };
          },
        }),
      ),
    ).rejects.toThrow(/explicit re-home is required/u);
  });

  it("keeps sequence cursors exact beyond Number.MAX_SAFE_INTEGER", async () => {
    await runtime.runPromise(
      state.transaction("test.work.seedHugeSequence", (writer) => {
        writer.run(
          `
            INSERT INTO work_home_sequences(home_station, last_seq)
            VALUES (?, ?)
          `,
          ["station-huge", "9007199254740993"],
        );
      }),
    );
    const doc = taskCanvas("tasks-huge", "station-huge");
    const workIds = ids();
    await runtime.runPromise(
      repository.mutate({
        canvasName: "huge-canvas",
        nodeId: "tasks-huge",
        entityHome: "station-huge",
        operation: "task.create",
        authoredDoc: doc,
        transform: (projected) => {
          const result = workTaskCreate(
            projected,
            "huge-canvas",
            "tasks-huge",
            "exact order",
            undefined,
            workIds,
          );
          return { doc: result.doc, value: result.task };
        },
      }),
    );
    const events = await runtime.runPromise(
      repository.eventsAfter("station-huge", "9007199254740993"),
    );
    expect(events.map((event) => event.seq)).toEqual(["9007199254740994"]);
  });
});
