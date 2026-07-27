import { Either, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  WorkSnapshot,
  type WorkSnapshot as WorkSnapshotType,
} from "../src/shared/work-model";
import {
  WorkSnapshot as CanvasWorkSnapshot,
  type WorkSnapshot as CanvasWorkSnapshotType,
} from "../src/shared/canvas";
import { taskItem } from "./helpers/task-fixtures";

const snapshotInput = {
  canvasName: "factory",
  nodeId: "task-sink",
  tasks: {
    items: [taskItem("task-1", "Ship the release", "working")],
  },
  requests: {
    items: [taskItem("request-1", "Approve release?", "input-required")],
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
        taskId: "task-1",
      },
    ],
  },
};

describe("WorkSnapshot", () => {
  it("round-trips an explicit canvas/node work read model", () => {
    const decoded = Schema.decodeUnknownEither(WorkSnapshot)(snapshotInput);
    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isLeft(decoded)) return;

    expect(decoded.right.canvasName).toBe("factory");
    expect(decoded.right.nodeId).toBe("task-sink");
    expect(decoded.right.tasks.items[0]?.state).toBe("working");
    expect(decoded.right.requests.items[0]?.state).toBe("input-required");
    expect(decoded.right.messages.items[0]?.messageId).toBe("message-1");
    expect(decoded.right.artifacts.items[0]?.artifactId).toBe("artifact-1");

    const encoded = Schema.encodeEither(WorkSnapshot)(decoded.right);
    expect(Either.isRight(encoded)).toBe(true);
    if (Either.isRight(encoded)) expect(encoded.right).toEqual(snapshotInput);
  });

  it("rejects a lane whose hydrated rows have the wrong domain shape", () => {
    const decoded = Schema.decodeUnknownEither(WorkSnapshot)({
      ...snapshotInput,
      tasks: {
        items: [{ id: "task-1", state: "unknown", history: [] }],
      },
    });

    expect(Either.isLeft(decoded)).toBe(true);
  });

  it("keeps the canvas export as the same schema and derived type", () => {
    expect(CanvasWorkSnapshot).toBe(WorkSnapshot);
    expectTypeOf<CanvasWorkSnapshotType>().toEqualTypeOf<WorkSnapshotType>();
  });
});
