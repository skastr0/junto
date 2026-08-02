import { Result, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  Artifact,
  Task,
  WorkSnapshot,
  type WorkSnapshot as WorkSnapshotType,
} from "../src/shared/work-model";
import {
  WorkSnapshot as CanvasWorkSnapshot,
  type WorkSnapshot as CanvasWorkSnapshotType,
} from "../src/shared/canvas";
import { taskItem } from "./helpers/task-fixtures";

const seatId = `seat_${"1".repeat(64)}`;

const snapshotInput = {
  canvasName: "factory",
  nodeId: "task-sink",
  tasks: {
    items: [
      {
        ...taskItem("task-1", "Ship the release", "working"),
        claimedBy: seatId,
      },
    ],
  },
  requests: {
    items: [
      {
        ...taskItem("request-1", "Approve release?", "input-required"),
        claimedBy: seatId,
      },
    ],
  },
  messages: {
    items: [
      {
        messageId: "message-1",
        role: "user" as const,
        parts: [{ kind: "text" as const, text: "Please ship it." }],
        contextId: "factory",
      },
    ],
  },
  artifacts: {
    items: [
      {
        artifactId: "artifact-1",
        name: "release-notes",
        parts: [{ kind: "url" as const, url: "https://example.invalid/release" }],
        task: {
          kind: "task" as const,
          itemId: "task-1",
          sink: {
            canvasName: "factory",
            nodeId: "task-sink",
          },
        },
      },
    ],
  },
  board: {
    topics: [],
  },
};

describe("WorkSnapshot", () => {
  it("round-trips an explicit canvas/node work read model", () => {
    const decoded = Schema.decodeUnknownResult(WorkSnapshot)(snapshotInput);
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isFailure(decoded)) return;

    expect(decoded.success.canvasName).toBe("factory");
    expect(decoded.success.nodeId).toBe("task-sink");
    expect(decoded.success.tasks.items[0]?.state).toBe("working");
    expect(decoded.success.requests.items[0]?.state).toBe("input-required");
    expect(decoded.success.messages.items[0]?.messageId).toBe("message-1");
    expect(decoded.success.artifacts.items[0]?.artifactId).toBe("artifact-1");

    const encoded = Schema.encodeResult(WorkSnapshot)(decoded.success);
    expect(Result.isSuccess(encoded)).toBe(true);
    if (Result.isSuccess(encoded)) expect(encoded.success).toEqual(snapshotInput);
  });

  it("rejects a lane whose hydrated rows have the wrong domain shape", () => {
    const decoded = Schema.decodeUnknownResult(WorkSnapshot)({
      ...snapshotInput,
      tasks: {
        items: [{ id: "task-1", state: "unknown", history: [] }],
      },
    });

    expect(Result.isFailure(decoded)).toBe(true);
  });

  it("keeps the canvas export as the same schema and derived type", () => {
    expect(CanvasWorkSnapshot).toBe(WorkSnapshot);
    expectTypeOf<CanvasWorkSnapshotType>().toEqualTypeOf<WorkSnapshotType>();
  });
});

describe("Artifact task provenance", () => {
  const base = {
    artifactId: "artifact-1",
    parts: [{ kind: "text" as const, text: "receipt" }],
  };

  it("accepts only an exact task reference", () => {
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(Artifact, {
          onExcessProperty: "error",
        })({
          ...base,
          task: {
            kind: "task",
            itemId: "task-1",
            sink: { canvasName: "factory", nodeId: "tasks" },
          },
        }),
      ),
    ).toBe(true);

    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(Artifact, {
          onExcessProperty: "error",
        })({
          ...base,
          taskId: "task-1",
        }),
      ),
    ).toBe(true);

    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(Artifact, {
          onExcessProperty: "error",
        })({
          ...base,
          task: {
            kind: "request",
            itemId: "task-1",
            sink: { canvasName: "factory", nodeId: "tasks" },
          },
        }),
      ),
    ).toBe(true);
  });
});

describe("Task claimant invariant", () => {
  const decode = (state: string, claimedBy?: string, metadata?: unknown) =>
    Schema.decodeUnknownResult(Task)({
      id: `task-${state}`,
      state,
      history: [],
      ...(claimedBy === undefined ? {} : { claimedBy }),
      ...(metadata === undefined ? {} : { metadata }),
    });

  it("requires submitted inventory to be unclaimed", () => {
    expect(Result.isSuccess(decode("submitted"))).toBe(true);
    expect(Result.isFailure(decode("submitted", seatId))).toBe(true);
  });

  it("requires every active state to have a claimant", () => {
    for (const state of [
      "working",
      "input-required",
      "auth-required",
    ]) {
      expect(Result.isFailure(decode(state))).toBe(true);
      expect(Result.isSuccess(decode(state, seatId))).toBe(true);
    }
  });

  it("allows terminal history with or without its former claimant", () => {
    for (const state of [
      "completed",
      "canceled",
      "failed",
      "rejected",
      "archived",
    ]) {
      expect(Result.isSuccess(decode(state))).toBe(true);
      expect(Result.isSuccess(decode(state, seatId))).toBe(true);
    }
  });

  it("rejects the retired metadata claimant for every state", () => {
    expect(
      Result.isFailure(decode("submitted", undefined, { claimedBy: seatId })),
    ).toBe(true);
  });
});
