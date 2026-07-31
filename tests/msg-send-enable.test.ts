import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasEdge, CanvasNode } from "../src/shared/canvas";
import {
  composeMsgSendEnableMailboxText,
  listMsgSendGrants,
  planMsgSendEnableNotices,
} from "../src/shared/msg-send-enable";

const agent = (id: string, title: string): CanvasNode =>
  ({
    id,
    type: "text",
    x: 0,
    y: 0,
    width: 160,
    height: 80,
    text: title,
    ether: {
      entity: { kind: "agent", name: `local:${title}` },
    },
  }) as CanvasNode;

const edge = (
  id: string,
  from: string,
  to: string,
  ports?: ReadonlyArray<"msg.list" | "msg.send">,
): CanvasEdge => ({
  id,
  fromNode: from,
  toNode: to,
  ...(ports ? { ether: { ports: [...ports] } } : {}),
});

const doc = (
  nodes: ReadonlyArray<CanvasNode>,
  edges: ReadonlyArray<CanvasEdge>,
): CanvasDoc => ({
  nodes: [...nodes],
  edges: [...edges],
});

describe("msg-send enable notices", () => {
  it("lists default grants for unmasked agent edges", () => {
    const canvas = doc(
      [agent("a1", "Alpha"), agent("a2", "Beta")],
      [edge("e1", "a1", "a2")],
    );
    const grants = listMsgSendGrants(canvas);
    expect(grants.size).toBe(2);
    expect(grants.get("a1\0a2")).toEqual({ peerId: "a2", peerTitle: "Beta" });
    expect(grants.get("a2\0a1")).toEqual({ peerId: "a1", peerTitle: "Alpha" });
  });

  it("lists directed grants when ports include msg.send", () => {
    const canvas = doc(
      [agent("a1", "Alpha"), agent("a2", "Beta")],
      [edge("e1", "a1", "a2", ["msg.send"])],
    );
    const grants = listMsgSendGrants(canvas);
    expect(grants.size).toBe(2);
    expect(grants.get("a1\0a2")).toEqual({ peerId: "a2", peerTitle: "Beta" });
    expect(grants.get("a2\0a1")).toEqual({ peerId: "a1", peerTitle: "Alpha" });
  });

  it("plans rising-edge notices only (not already-enabled pairs)", () => {
    const a1 = agent("a1", "Alpha");
    const a2 = agent("a2", "Beta");
    const a3 = agent("a3", "Gamma");
    const previous = doc([a1, a2, a3], [edge("e1", "a1", "a2", ["msg.send"])]);
    const next = doc(
      [a1, a2, a3],
      [
        edge("e1", "a1", "a2", ["msg.send"]),
        edge("e2", "a1", "a3", ["msg.send"]),
      ],
    );
    const notices = planMsgSendEnableNotices(previous, next);
    expect(notices).toEqual([
      { recipientId: "a1", peerId: "a3", peerTitle: "Gamma" },
      { recipientId: "a3", peerId: "a1", peerTitle: "Alpha" },
    ]);
  });

  it("plans both directions when a fresh msg.send edge appears", () => {
    const a1 = agent("a1", "Alpha");
    const a2 = agent("a2", "Beta");
    const previous = doc([a1, a2], []);
    const next = doc([a1, a2], [edge("e1", "a1", "a2", ["msg.send"])]);
    expect(planMsgSendEnableNotices(previous, next)).toEqual([
      { recipientId: "a1", peerId: "a2", peerTitle: "Beta" },
      { recipientId: "a2", peerId: "a1", peerTitle: "Alpha" },
    ]);
  });

  it("treats a masked port upgrade to msg.send as enable", () => {
    const a1 = agent("a1", "Alpha");
    const a2 = agent("a2", "Beta");
    const previous = doc([a1, a2], [edge("e1", "a1", "a2", ["msg.list"])]);
    const next = doc([a1, a2], [edge("e1", "a1", "a2", ["msg.send"])]);
    expect(planMsgSendEnableNotices(previous, next)).toHaveLength(2);
  });

  it("emits no notices when topology is unchanged", () => {
    const a1 = agent("a1", "Alpha");
    const a2 = agent("a2", "Beta");
    const canvas = doc([a1, a2], [edge("e1", "a1", "a2", ["msg.send"])]);
    expect(planMsgSendEnableNotices(canvas, canvas)).toEqual([]);
  });

  it("composes actionable mailbox copy", () => {
    const text = composeMsgSendEnableMailboxText({
      recipientId: "a1",
      peerId: "a2",
      peerTitle: "Beta",
    });
    expect(text).toContain("msg.send is now enabled");
    expect(text).toContain("`a2`");
    expect(text).toContain("vellum msg send");
    expect(text).toContain("vellum onboard");
  });
});
