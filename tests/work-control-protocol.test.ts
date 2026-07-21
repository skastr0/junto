import { describe, expect, it } from "vitest";
import { Either, Schema } from "effect";
import {
  TasksClaimArgs,
  WorkOpName,
  WorkRequestEnvelope,
  decodeWorkRequest,
  decodeWorkResponse,
  validateNodeRefString,
  workErr,
  workOk,
  WORK_PROTOCOL_VERSION,
} from "../src/shared/work-control";
import {
  areConnected,
  connectedCapabilities,
  kindAllowsOp,
  regionCoMemberIds,
  scopeError,
  visibilityOf,
} from "../src/main/vellum/work/authz";
import type { CanvasDoc } from "../src/shared/canvas";

const doc = (nodes: CanvasDoc["nodes"], edges: CanvasDoc["edges"] = []): CanvasDoc => ({
  nodes,
  edges,
});

describe("work-control wire schemas", () => {
  it("decodes a valid request envelope", () => {
    const raw = {
      token: "abc",
      nodeRef: "vellum://canvas/demo?node=agent-1",
      op: "tasks.claim",
      args: { target: "tasks", task: "t1" },
    };
    const decoded = decodeWorkRequest(raw);
    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isRight(decoded)) {
      expect(decoded.right.op).toBe("tasks.claim");
      expect(decoded.right.token).toBe("abc");
    }
  });

  it("rejects unknown ops", () => {
    const decoded = decodeWorkRequest({
      token: "t",
      nodeRef: "vellum://canvas/demo?node=a",
      op: "tasks.create",
    });
    expect(Either.isLeft(decoded)).toBe(true);
  });

  it("round-trips response ok/err", () => {
    const ok = workOk("ping", { pong: true }, "r1");
    const err = workErr("AuthError", "bad token", { retryable: false }, "ping", "r2");
    expect(Either.isRight(decodeWorkResponse(ok))).toBe(true);
    expect(Either.isRight(decodeWorkResponse(err))).toBe(true);
    expect(ok.protocol_version).toBe(WORK_PROTOCOL_VERSION);
    expect(err.error.type).toBe("AuthError");
  });

  it("validates TasksClaimArgs and node refs", () => {
    const good = Schema.decodeUnknownEither(TasksClaimArgs)({
      target: "n7",
      task: "t1",
      node: "vellum://canvas/demo?node=agent-1",
    });
    expect(Either.isRight(good)).toBe(true);

    const ref = validateNodeRefString("vellum://canvas/demo?node=agent-1");
    expect(ref.ok).toBe(true);
    if (ref.ok) {
      expect(ref.value.canvasName).toBe("demo");
      expect(ref.value.nodeId).toBe("agent-1");
    }

    const bad = validateNodeRefString("not-a-ref");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.type).toBe("StaleNodeRef");
  });

  it("enumerates every WorkOpName", () => {
    const ops = Schema.decodeUnknownEither(Schema.Array(WorkOpName))([
      "ping",
      "doctor",
      "capabilities",
      "onboard",
      "tasks.list",
      "tasks.claim",
      "tasks.update",
      "msg.list",
      "msg.send",
      "request.create",
      "artifact.publish",
    ]);
    expect(Either.isRight(ops)).toBe(true);
  });
});

describe("work authz — edges as capability", () => {
  const board = doc(
    [
      {
        id: "agent",
        type: "text",
        x: 0,
        y: 0,
        width: 100,
        height: 40,
        text: "agent",
        ether: { entity: { kind: "agent", name: "local:agent" } },
      },
      {
        id: "tasks",
        type: "text",
        x: 200,
        y: 0,
        width: 100,
        height: 40,
        text: "tasks",
        ether: { entity: { kind: "task" }, tasks: { items: [] } },
      },
      {
        id: "req",
        type: "text",
        x: 400,
        y: 0,
        width: 100,
        height: 40,
        text: "requests",
        ether: { entity: { kind: "requests" }, requests: { items: [] } },
      },
      {
        id: "stranger",
        type: "text",
        x: 600,
        y: 200,
        width: 100,
        height: 40,
        text: "elsewhere",
        ether: { entity: { kind: "project", name: "x" } },
      },
      {
        id: "region",
        type: "group",
        x: -20,
        y: -20,
        width: 500,
        height: 120,
        label: "Forge",
        ether: { region: { hold: false, instruction: "ship work" } },
      },
    ],
    [{ id: "e1", fromNode: "agent", toNode: "tasks" }],
  );

  it("detects undirected edges", () => {
    expect(areConnected(board, "agent", "tasks")).toBe(true);
    expect(areConnected(board, "tasks", "agent")).toBe(true);
    expect(areConnected(board, "agent", "req")).toBe(false);
    expect(areConnected(board, "agent", "agent")).toBe(true);
  });

  it("classifies region co-members vs invisible", () => {
    // agent, tasks, req centers are inside the group; stranger is not
    expect(regionCoMemberIds(board, "agent")).toEqual(
      expect.arrayContaining(["tasks", "req"]),
    );
    expect(visibilityOf(board, "agent", "tasks")).toBe("connected");
    expect(visibilityOf(board, "agent", "req")).toBe("region");
    expect(visibilityOf(board, "agent", "stranger")).toBe("none");
  });

  it("kindAllowsOp gates by entity kind", () => {
    expect(kindAllowsOp("task", "tasks.claim")).toBe(true);
    expect(kindAllowsOp("task", "artifact.publish")).toBe(false);
    expect(kindAllowsOp("artifacts", "artifact.publish")).toBe(true);
    expect(kindAllowsOp("agent", "msg.send")).toBe(true);
  });

  it("connectedCapabilities lists ops on edge targets only", () => {
    const caps = connectedCapabilities(board, "agent");
    expect(caps).toHaveLength(1);
    expect(caps[0]?.id).toBe("tasks");
    expect(caps[0]?.ops).toContain("tasks.claim");
  });

  it("scopeError names the missing edge", () => {
    const err = scopeError("agent", "req", "not_connected");
    expect(err.type).toBe("ScopeError");
    expect(err.message).toContain("missing edge");
    expect(err.details?.next_step).toMatch(/edge/i);
  });
});
