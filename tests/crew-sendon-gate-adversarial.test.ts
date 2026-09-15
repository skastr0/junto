import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Layer, ManagedRuntime, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InstallationId } from "../src/shared/installation-id";
import {
  WorkRepository,
  WorkRepositoryLive,
  type SendOnTaskInput,
} from "../src/main/vellum-command/work/repository";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum-command/state/engine";
import { IntentFactBasis } from "../src/shared/work-protocol";
import { serializeCanvas, type CanvasDoc } from "../src/shared/canvas";
import type { Task } from "../src/shared/work-model";
import { seedCanvasAuthority } from "./helpers/canvas-authority-material";
import {
  authorialMaterialForTest,
  authorialTaskTopologyCapabilityForTest,
} from "./helpers/task-topology-authority";

// Independent adversarial pin for the requires-review write-time gate
// (docs/crew-contract.md). transitionTask re-checks the green inside its
// own transaction via reviewGateSatisfiedWithin; sendTaskOn — the path a
// task takes when completing onto the next board — silently drops the
// same input, so a concurrent blocking verdict between preflight and
// commit slips through. Pinned expected-fail until the field is consumed.

const root = join(tmpdir(), `vellum-command-crew-sendon-${randomUUID()}`);
const runtime = ManagedRuntime.make(
  Layer.provideMerge(
    WorkRepositoryLive,
    makeStateEngineLive(join(root, "vellum-command.db")),
  ),
);

let repository: Context.Service.Shape<typeof WorkRepository>;
let state: Context.Service.Shape<typeof StateEngine>;

const observedAt = "2026-08-20T09:00:00.000Z";
const cc = Schema.decodeUnknownSync(InstallationId)("cc-sendon-gate");
const topology: CanvasDoc = {
  nodes: ["build", "review"].map((id, index) => ({
    id,
    type: "text" as const,
    x: index * 240,
    y: 0,
    width: 180,
    height: 80,
    text: id,
    ether: { entity: { kind: "task" } },
  })),
  edges: [],
};
const authorityRawBody = serializeCanvas(topology);
const authorityMaterial = authorialMaterialForTest({
  generation: "1",
  documents: new Map([["factory", { document: topology, rawBody: authorityRawBody }]]),
});
const basis = Schema.decodeUnknownSync(IntentFactBasis, {
  onExcessProperty: "error",
})({
  kind: "authorial-intent",
  generation: "1",
  contentSha256: authorityMaterial.intentSha256,
});
const dependencyScope = (sink: { canvasName: string; nodeId: string }) =>
  authorialTaskTopologyCapabilityForTest({
    basis,
    sink,
    document: topology,
    rawBody: authorityRawBody,
  });

const s1 = { canvasName: "factory", nodeId: "build" };
const s2 = { canvasName: "factory", nodeId: "review" };

const taskAt = async (
  sink: { canvasName: string; nodeId: string },
  taskId: string,
): Promise<Task | undefined> => {
  const snapshot = await runtime.runPromise(
    repository.readSnapshot(sink.canvasName, sink.nodeId),
  );
  return snapshot.tasks.items.find((item) => item.id === taskId);
};

beforeAll(async () => {
  repository = await runtime.runPromise(WorkRepository);
  state = await runtime.runPromise(StateEngine);
  await runtime.runPromise(
    state.transaction("test.seed", (writer) => {
      writer.run(
        `INSERT INTO station_known_installations(installation_id, registered_at)
         VALUES (?, ?)`,
        [cc, observedAt],
      );
      writer.run(
        `INSERT INTO station_installation(singleton, installation_id, created_at)
         VALUES (1, ?, ?)`,
        [cc, observedAt],
      );
      writer.run(
        `INSERT INTO station_configuration(
           singleton, role, host_id, agent_host_id,
           command_center_installation_id, supervised_preferred, configured_at
         ) VALUES (1, 'command-center', 'local', NULL, NULL, 1, ?)`,
        [observedAt],
      );
      seedCanvasAuthority(writer, {
        generation: "1",
        documents: new Map([["factory", topology]]),
        at: observedAt,
      });
    }),
  );
});

afterAll(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const mintTask = async (id: string) => {
  await runtime.runPromise(
    repository.createTask({
      sink: s1,
      basis,
      dependencyScope: dependencyScope(s1),
      task: {
        id,
        state: "submitted",
        history: [
          {
            messageId: `m-${id}`,
            role: "user",
            parts: [{ kind: "text", text: "work" }],
          },
        ],
        epoch: 3,
        visits: [{ board: "build", enteredAt: observedAt, epoch: 3 }],
      },
      originAt: observedAt,
      receivedAt: observedAt,
    }),
  );
};

const sendOn = (id: string, extra: Record<string, unknown> = {}) =>
  repository.sendTaskOn({
    sink: s1,
    basis,
    taskId: id,
    visits: [
      {
        board: "build",
        enteredAt: observedAt,
        epoch: 3,
        exitedAt: "2026-08-20T11:00:00.000Z",
        exit: "sent-on" as const,
        next: "review",
      },
    ],
    next: s2,
    nextTask: {
      id,
      state: "submitted",
      history: [
        {
          messageId: `m-${id}-2`,
          role: "user",
          parts: [{ kind: "text", text: "work" }],
        },
      ],
      epoch: 3,
      visits: [
        {
          board: "build",
          enteredAt: observedAt,
          epoch: 3,
          exitedAt: "2026-08-20T11:00:00.000Z",
          exit: "sent-on" as const,
          next: "review",
        },
        { board: "review", enteredAt: "2026-08-20T11:00:00.000Z", epoch: 3 },
      ],
    },
    originAt: "2026-08-20T11:00:00.000Z",
    receivedAt: "2026-08-20T11:00:00.000Z",
    ...extra,
  } as SendOnTaskInput);

describe("sendTaskOn writer-time review gate", () => {
  it("sends on without a gate as the control", async () => {
    await mintTask("task-control");
    const result = await runtime.runPromise(sendOn("task-control"));
    expect(result.value.completed.state).toBe("completed");
    expect((await taskAt(s2, "task-control"))?.state).toBe("submitted");
  });

  it(
    "a failing reviewGate refuses the send-on commit — the writer-time " +
      "re-check runs inside the move-to-next-board transaction",
    async () => {
      await mintTask("task-gated");
      const unsatisfiableGate = {
        installationId: cc,
        canvasName: s1.canvasName,
        nodeId: s1.nodeId,
        taskId: "task-gated",
        epoch: 3,
        subjectHash: "no-verdicts-exist-for-this-hash",
        excludingSeatId:
          "seat_" + "a".repeat(64),
      };
      await expect(
        runtime.runPromise(
          sendOn("task-gated", { reviewGate: unsatisfiableGate }),
        ),
      ).rejects.toThrow();
      // The task must not have completed or moved.
      expect((await taskAt(s1, "task-gated"))?.state).toBe("submitted");
      expect(await taskAt(s2, "task-gated")).toBeUndefined();
    },
  );
});
