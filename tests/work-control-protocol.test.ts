import { describe, expect, it } from "vitest";
import { Result, Schema } from "effect";
import {
  MsgPromptArgs,
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
} from "../src/main/junto/work/authz";
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
      op: "msg.send",
      args: { target: "peer", text: "hello" },
    };
    const decoded = decodeWorkRequest(raw);
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) {
      expect(decoded.success.op).toBe("msg.send");
      expect(decoded.success.token).toBe("abc");
    }
  });

  it("rejects unknown ops", () => {
    const decoded = decodeWorkRequest({
      token: "t",
      op: "msg.delete",
    });
    expect(Result.isFailure(decoded)).toBe(true);
  });

  it("rejects the retired client nodeRef field", () => {
    const decoded = decodeWorkRequest({
      token: "t",
      nodeRef: "junto://canvas/demo?node=agent-1",
      op: "ping",
    });
    expect(Result.isFailure(decoded)).toBe(true);
    if (Result.isFailure(decoded)) {
      expect(decoded.failure.message).toContain("nodeRef");
      expect(decoded.failure.message).toMatch(/no excess property/i);
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

  it("refuses client-supplied identity on msg.prompt args", () => {
    const good = Schema.decodeUnknownResult(MsgPromptArgs)({
      target: "n7",
      text: "t1",
    });
    const clientIdentity = Schema.decodeUnknownResult(MsgPromptArgs)({
      target: "n7",
      text: "t1",
      actor: "agent",
    });
    expect(Result.isSuccess(good)).toBe(true);
    expect(Result.isFailure(clientIdentity)).toBe(true);
  });

  it("enumerates the seat ops", () => {
    const ops = Schema.decodeUnknownResult(Schema.Array(WorkOpName))([
      "ping",
      "doctor",
      "capabilities",
      "onboard",
      "offboard",
      "preamble",
      "msg.list",
      "msg.send",
      "msg.prompt",
      "msg.sent",
      "msg.read",
      "msg.reply",
      "msg.react",
      "seat.wait",
      "seat.read",
      "signal.raise",
      "signal.clear",
      "signal.list",
    ]);
    expect(Result.isSuccess(ops)).toBe(true);
    expect(
      Result.isFailure(Schema.decodeUnknownResult(WorkOpName)("request.create")),
    ).toBe(true);
  });
});

describe("work authz — edges as capability", () => {
  const agent = (id: string, x: number, y = 0): CanvasDoc["nodes"][number] => ({
    id,
    type: "text",
    x,
    y,
    width: 100,
    height: 40,
    text: id,
    ether: { entity: { kind: "agent", name: `local:${id}` } },
  });
  const board = doc(
    [
      agent("agent", 0),
      agent("peer", 200),
      agent("neighbor", 400),
      agent("stranger", 600, 200),
      {
        id: "region",
        type: "group",
        x: -20,
        y: -20,
        // Wide/tall enough to FULLY contain agent/peer/neighbor (I9:
        // membership is full-rect containment, not center-point) while
        // leaving stranger (x:600-700) outside.
        width: 520,
        height: 120,
        label: "Forge",
        ether: { region: { hold: false, instruction: "ship work" } },
      },
    ],
    [{ id: "e1", fromNode: "agent", toNode: "peer", ether: { verb: "messages" } }],
  );

  it("detects undirected edges", () => {
    expect(areConnected(board, "agent", "peer")).toBe(true);
    expect(areConnected(board, "peer", "agent")).toBe(true);
    expect(areConnected(board, "agent", "neighbor")).toBe(false);
    expect(areConnected(board, "agent", "agent")).toBe(true);
  });

  it("classifies region co-members vs invisible", () => {
    // agent, peer, neighbor are fully inside the group rect; stranger is not
    expect(regionCoMemberIds(board, "agent")).toEqual(
      expect.arrayContaining(["peer", "neighbor"]),
    );
    expect(visibilityOf(board, "agent", "peer")).toBe("connected");
    expect(visibilityOf(board, "agent", "neighbor")).toBe("region");
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
    expect(kindAllowsOp("agent", "msg.send")).toBe(true);
    expect(kindAllowsOp("agent", "msg.react")).toBe(true);
    expect(kindAllowsOp("agent", "onboard")).toBe(false);
  });

  it("connectedCapabilities lists the mail grants on edge targets only", () => {
    const caps = connectedCapabilities(board, "agent");
    expect(caps).toHaveLength(1);
    expect(caps[0]?.id).toBe("peer");
    expect(caps[0]?.role).toBe("actor");
    expect(caps[0]?.grants).toEqual(
      expect.arrayContaining(["msg.list", "msg.send", "msg.prompt"]),
    );
    expect(caps[0]?.grants).not.toContain("browser.automate");
  });

  it("admitWorkTarget uses physics for edge + port", () => {
    const ok = admitWorkTarget(board, "agent", "peer", "msg.send");
    expect(Result.isSuccess(ok)).toBe(true);

    const regionOnly = admitWorkTarget(board, "agent", "neighbor", "msg.send");
    expect(Result.isFailure(regionOnly)).toBe(true);
    if (Result.isFailure(regionOnly)) {
      expect(regionOnly.failure.type).toBe("ScopeError");
      expect(regionOnly.failure.message).toContain("missing edge");
    }

    const invisible = admitWorkTarget(board, "agent", "stranger", "msg.send");
    expect(Result.isFailure(invisible)).toBe(true);
    if (Result.isFailure(invisible)) {
      expect(invisible.failure.type).toBe("ScopeError");
      expect(invisible.failure.message).toMatch(/not visible/);
    }
  });

  it("scopeDenialToWorkError keeps wire-compatible ScopeError bodies", () => {
    const notConnected = scopeDenialToWorkError(
      new ScopeDenial({
        reason: "not_connected",
        caller: "agent",
        target: "neighbor",
        message: "physics msg",
        port: "msg.send",
      }),
    );
    expect(notConnected.type).toBe("ScopeError");
    expect(notConnected.message).toBe(
      'missing edge between "agent" and "neighbor"',
    );
  });

  it("factoryRoleOfNode derives actor for agent seats", () => {
    const seat = board.nodes.find((n) => n.id === "agent")!;
    expect(factoryRoleOfNode(seat)).toBe("actor");
  });

  it("scopeError names the missing edge", () => {
    const err = scopeError("agent", "neighbor", "not_connected");
    expect(err.type).toBe("ScopeError");
    expect(err.message).toContain("missing edge");
    expect(err.details?.next_step).toMatch(/edge/i);
  });
});
