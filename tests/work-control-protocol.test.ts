import { describe, expect, it } from "vitest";
import { Result, Schema } from "effect";
import {
  TasksClaimArgs,
  WorkOpName,
  decodeWorkRequest,
  decodeWorkResponse,
  workErr,
  workOk,
  WORK_PROTOCOL_VERSION,
} from "../src/shared/work-control";
import {
  admitWorkTarget,
  areConnected,
  connectedCapabilities,
  containingRegion,
  factoryRoleOfNode,
  kindAllowsOp,
  regionCoMemberIds,
  scopeDenialToWorkError,
  scopeError,
  visibilityOf,
} from "../src/main/vellum/work/authz";
import type { CanvasDoc } from "../src/shared/canvas";
import { ScopeDenial } from "../src/shared/physics";

const doc = (nodes: CanvasDoc["nodes"], edges: CanvasDoc["edges"] = []): CanvasDoc => ({
  nodes,
  edges,
});

describe("work-control wire schemas", () => {
  it("decodes a valid request envelope", () => {
    const raw = {
      token: "abc",
      op: "tasks.claim",
      args: { target: "tasks", task: "t1" },
    };
    const decoded = decodeWorkRequest(raw);
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) {
      expect(decoded.success.op).toBe("tasks.claim");
      expect(decoded.success.token).toBe("abc");
    }
  });

  it("rejects unknown ops", () => {
    const decoded = decodeWorkRequest({
      token: "t",
      op: "tasks.delete",
    });
    expect(Result.isFailure(decoded)).toBe(true);
  });

  it("rejects the retired client nodeRef field", () => {
    const decoded = decodeWorkRequest({
      token: "t",
      nodeRef: "vellum://canvas/demo?node=agent-1",
      op: "ping",
    });
    expect(Result.isFailure(decoded)).toBe(true);
    if (Result.isFailure(decoded)) {
      expect(decoded.failure.message).toContain("nodeRef");
      expect(decoded.failure.message).toMatch(/unexpected/i);
    }
  });

  it("round-trips response ok/err", () => {
    const ok = workOk("ping", { pong: true }, "r1");
    const err = workErr("AuthError", "bad token", { retryable: false }, "ping", "r2");
    expect(Result.isSuccess(decodeWorkResponse(ok))).toBe(true);
    expect(Result.isSuccess(decodeWorkResponse(err))).toBe(true);
    expect(ok.protocol_version).toBe(WORK_PROTOCOL_VERSION);
    expect(err.error.type).toBe("AuthError");
  });

  it("rejects excess response fields instead of pruning compatibility data", () => {
    expect(
      Result.isFailure(
        decodeWorkResponse({
          ...workOk("ping", { pong: true }, "strict-response"),
          legacyToken: "retired",
        }),
      ),
    ).toBe(true);
  });

  it("validates TasksClaimArgs", () => {
    const good = Schema.decodeUnknownResult(TasksClaimArgs)({
      target: "n7",
      task: "t1",
    });
    const clientIdentity = Schema.decodeUnknownResult(TasksClaimArgs)({
      target: "n7",
      task: "t1",
      actor: "agent",
    });
    expect(Result.isSuccess(good)).toBe(true);
    expect(Result.isFailure(clientIdentity)).toBe(true);
  });

  it("enumerates every WorkOpName", () => {
    const ops = Schema.decodeUnknownResult(Schema.Array(WorkOpName))([
      "ping",
      "doctor",
      "capabilities",
      "onboard",
      "preamble",
      "tasks.list",
      "tasks.create",
      "tasks.claim",
      "tasks.update",
      "msg.list",
      "msg.send",
      "msg.read",
      "msg.reply",
      "request.escalate",
      "artifact.publish",
      "relay.trigger",
    ]);
    expect(Result.isSuccess(ops)).toBe(true);
    expect(
      Result.isFailure(Schema.decodeUnknownResult(WorkOpName)("request.create")),
    ).toBe(true);
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
        // Wide/tall enough to FULLY contain agent/tasks/req (I9: membership
        // is full-rect containment, not center-point) while leaving stranger
        // (x:600-700) outside.
        width: 520,
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
    // agent, tasks, req are fully inside the group rect; stranger is not
    expect(regionCoMemberIds(board, "agent")).toEqual(
      expect.arrayContaining(["tasks", "req"]),
    );
    expect(visibilityOf(board, "agent", "tasks")).toBe("connected");
    expect(visibilityOf(board, "agent", "req")).toBe("region");
    expect(visibilityOf(board, "agent", "stranger")).toBe("none");
  });

  it("containingRegion returns onboard briefing instruction", () => {
    expect(containingRegion(board, "agent")).toEqual({
      id: "region",
      label: "Forge",
      instruction: "ship work",
    });
    expect(containingRegion(board, "stranger")).toBeUndefined();
  });

  it("kindAllowsOp gates by entity kind", () => {
    expect(kindAllowsOp("task", "tasks.claim")).toBe(true);
    expect(kindAllowsOp("task", "artifact.publish")).toBe(false);
    expect(kindAllowsOp("artifacts", "artifact.publish")).toBe(true);
    expect(kindAllowsOp("agent", "msg.send")).toBe(true);
  });

  it("connectedCapabilities lists held grants on edge targets only", () => {
    const caps = connectedCapabilities(board, "agent");
    expect(caps).toHaveLength(1);
    expect(caps[0]?.id).toBe("tasks");
    expect(caps[0]?.grants).toContain("tasks.claim");
  });

  it("connectedCapabilities includes role + held grants", () => {
    const caps = connectedCapabilities(board, "agent");
    expect(caps[0]?.role).toBe("sink");
    expect(caps[0]?.grants).toEqual(
      expect.arrayContaining([
        "tasks.list",
        "tasks.claim",
        "tasks.update",
        "msg.list",
        "msg.send",
      ]),
    );
    expect(caps[0]?.grants).not.toContain("browser.automate");
    expect(caps[0]?.grants).not.toContain("artifact.publish");
  });

  it("admitWorkTarget uses physics for edge + port", () => {
    const ok = admitWorkTarget(board, "agent", "tasks", "tasks.claim");
    expect(Result.isSuccess(ok)).toBe(true);

    const regionOnly = admitWorkTarget(
      board,
      "agent",
      "req",
      "request.escalate",
    );
    expect(Result.isFailure(regionOnly)).toBe(true);
    if (Result.isFailure(regionOnly)) {
      expect(regionOnly.failure.type).toBe("ScopeError");
      expect(regionOnly.failure.message).toContain("missing edge");
    }

    const invisible = admitWorkTarget(board, "agent", "stranger", "tasks.list");
    expect(Result.isFailure(invisible)).toBe(true);
    if (Result.isFailure(invisible)) {
      expect(invisible.failure.type).toBe("ScopeError");
      expect(invisible.failure.message).toMatch(/not visible/);
    }

    const wrongKind = admitWorkTarget(board, "agent", "tasks", "artifact.publish");
    expect(Result.isFailure(wrongKind)).toBe(true);
    if (Result.isFailure(wrongKind)) {
      expect(wrongKind.failure.type).toBe("ScopeError");
      expect(wrongKind.failure.message).toMatch(/does not support/);
    }
  });

  it("S8 attack: artifact.publish from unedged actor → ScopeError", () => {
    const noEdge = admitWorkTarget(board, "agent", "stranger", "artifact.publish");
    expect(Result.isFailure(noEdge)).toBe(true);
    if (Result.isFailure(noEdge)) {
      expect(noEdge.failure.type).toBe("ScopeError");
    }
    // Connected task sink does not offer artifact.publish.
    const wrongSink = admitWorkTarget(board, "agent", "tasks", "artifact.publish");
    expect(Result.isFailure(wrongSink)).toBe(true);
    if (Result.isFailure(wrongSink)) {
      expect(wrongSink.failure.type).toBe("ScopeError");
    }
  });

  it("scopeDenialToWorkError keeps wire-compatible ScopeError bodies", () => {
    const notConnected = scopeDenialToWorkError(
      new ScopeDenial({
        reason: "not_connected",
        caller: "agent",
        target: "req",
        message: "physics msg",
        port: "request.escalate",
      }),
    );
    expect(notConnected.type).toBe("ScopeError");
    expect(notConnected.message).toBe(
      'missing edge between "agent" and "req"',
    );

    const noPort = scopeDenialToWorkError(
      new ScopeDenial({
        reason: "no_port",
        caller: "agent",
        target: "tasks",
        message: "physics msg",
        port: "artifact.publish",
      }),
      { kind: "task", op: "artifact.publish" },
    );
    expect(noPort.message).toContain("does not support artifact.publish");
  });

  it("factoryRoleOfNode derives actor for agent seats", () => {
    const agent = board.nodes.find((n) => n.id === "agent")!;
    expect(factoryRoleOfNode(agent)).toBe("actor");
    const tasks = board.nodes.find((n) => n.id === "tasks")!;
    expect(factoryRoleOfNode(tasks)).toBe("sink");
  });

  it("scopeError names the missing edge", () => {
    const err = scopeError("agent", "req", "not_connected");
    expect(err.type).toBe("ScopeError");
    expect(err.message).toContain("missing edge");
    expect(err.details?.next_step).toMatch(/edge/i);
  });
});
