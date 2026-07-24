import { describe, expect, it } from "vitest";
import { Either } from "effect";
import {
  decodeCanvasDoc,
  sanitizeWorkStores,
  type CanvasDoc,
} from "../src/shared/canvas";
import { taskItem } from "./helpers/task-fixtures";

describe("task schema + graceful drop", () => {
  it("decodes valid tasks/requests/artifacts/messages stores", () => {
    const raw = {
      nodes: [
        {
          id: "t",
          type: "text",
          text: "ship",
          x: 0,
          y: 0,
          width: 100,
          height: 50,
          ether: {
            entity: { kind: "task" },
            tasks: { items: [taskItem("i1", "ship", "working")] },
          },
        },
        {
          id: "r",
          type: "text",
          text: "1 pending",
          x: 0,
          y: 100,
          width: 100,
          height: 50,
          ether: {
            entity: { kind: "requests" },
            requests: { items: [taskItem("q1", "approve?", "input-required")] },
          },
        },
        {
          id: "a",
          type: "text",
          text: "artifacts",
          x: 0,
          y: 200,
          width: 100,
          height: 50,
          ether: {
            entity: { kind: "artifacts" },
            artifacts: {
              items: [
                {
                  artifactId: "art-1",
                  name: "report",
                  parts: [{ kind: "text", text: "body" }],
                  taskId: "i1",
                },
              ],
            },
          },
        },
        {
          id: "ag",
          type: "text",
          text: "mira",
          x: 0,
          y: 300,
          width: 100,
          height: 50,
          ether: {
            entity: { kind: "agent", name: "local:mira" },
            messages: {
              items: [
                {
                  messageId: "m1",
                  role: "user",
                  parts: [{ kind: "text", text: "hi" }],
                  contextId: "canvas",
                },
              ],
            },
          },
        },
      ],
      edges: [],
    };
    const decoded = decodeCanvasDoc(raw);
    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isRight(decoded)) {
      const doc = decoded.right as CanvasDoc;
      expect(doc.nodes[0]?.ether?.tasks?.items[0]?.state).toBe("working");
      expect(doc.nodes[1]?.ether?.requests?.items[0]?.state).toBe("input-required");
      expect(doc.nodes[2]?.ether?.artifacts?.items[0]?.artifactId).toBe("art-1");
      expect(doc.nodes[3]?.ether?.messages?.items[0]?.role).toBe("user");
    }
  });

  it("drops legacy checklist ether.tasks on read — never maps", () => {
    const raw = {
      nodes: [
        {
          id: "t",
          type: "text",
          text: "legacy",
          x: 0,
          y: 0,
          width: 100,
          height: 50,
          ether: {
            entity: { kind: "task" },
            tasks: { items: [{ id: "i1", text: "ship", done: false }] },
            flags: ["attention"],
          },
        },
      ],
      edges: [],
    };
    const sanitized = sanitizeWorkStores(raw) as {
      nodes: Array<{ ether?: { tasks?: unknown; flags?: unknown; entity?: unknown } }>;
    };
    expect(sanitized.nodes[0]?.ether?.tasks).toBeUndefined();
    expect(sanitized.nodes[0]?.ether?.entity).toEqual({ kind: "task" });
    expect(sanitized.nodes[0]?.ether?.flags).toEqual(["attention"]);

    const decoded = decodeCanvasDoc(raw);
    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isRight(decoded)) {
      expect(decoded.right.nodes[0]?.ether?.tasks).toBeUndefined();
      expect(decoded.right.nodes[0]?.ether?.flags).toEqual(["attention"]);
    }
  });

  it("stripped ether remains valid JSON Canvas", () => {
    const raw = {
      nodes: [
        {
          id: "t",
          type: "text",
          text: "ship\ncut",
          x: 0,
          y: 0,
          width: 100,
          height: 50,
        },
      ],
      edges: [],
    };
    expect(Either.isRight(decodeCanvasDoc(raw))).toBe(true);
  });
});
