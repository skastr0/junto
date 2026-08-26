import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  composeBoardInjectEnvelope,
  edgeNotifyOn,
  resolveBoardWakeSet,
} from "../src/shared/board-wake";
import { deliverBoardWakeSeats } from "../src/main/vellum/work/board-delivery";

const doc = (partial: Partial<CanvasDoc> & Pick<CanvasDoc, "nodes" | "edges">): CanvasDoc => ({
  nodes: partial.nodes,
  edges: partial.edges,
});

describe("board wake set", () => {
  it("includes connected agents by default; explicit notify:false opts out", () => {
    const canvas = doc({
      nodes: [
        {
          id: "board-1",
          type: "text",
          text: "board",
          x: 0,
          y: 0,
          width: 100,
          height: 80,
          ether: { entity: { kind: "board" } },
        },
        {
          id: "agent-a",
          type: "text",
          text: "a",
          x: 0,
          y: 0,
          width: 100,
          height: 80,
          ether: {
            entity: { kind: "agent", name: "local:a" },
            terminal: { bindingId: "bind-a", harness: "claude" },
          },
        },
        {
          id: "agent-b",
          type: "text",
          text: "b",
          x: 0,
          y: 0,
          width: 100,
          height: 80,
          ether: {
            entity: { kind: "agent", name: "local:b" },
            terminal: { bindingId: "bind-b", harness: "claude" },
          },
        },
        {
          id: "agent-c",
          type: "text",
          text: "c",
          x: 0,
          y: 0,
          width: 100,
          height: 80,
          ether: {
            entity: { kind: "agent", name: "local:c" },
            terminal: { bindingId: "bind-c", harness: "claude" },
          },
        },
      ],
      edges: [
        // participates joins the megaphone; messages is the opted-out half.
        { id: "e1", fromNode: "agent-a", toNode: "board-1", ether: { verb: "participates" } },
        { id: "e2", fromNode: "agent-b", toNode: "board-1", ether: { verb: "messages" } },
        { id: "e3", fromNode: "agent-c", toNode: "board-1", ether: { verb: "participates" } },
      ],
    });

    expect(edgeNotifyOn(canvas, "board-1", "agent-a")).toBe(true);
    expect(edgeNotifyOn(canvas, "board-1", "agent-b")).toBe(false);
    expect(edgeNotifyOn(canvas, "board-1", "agent-c")).toBe(true);
    const seats = resolveBoardWakeSet(canvas, "board-1");
    expect(seats.map((s) => s.nodeId).sort()).toEqual(["agent-a", "agent-c"]);
    expect(seats.find((s) => s.nodeId === "agent-a")?.target.bindingId).toBe(
      "bind-a",
    );
  });

  it("composes optional non-compulsion envelope", () => {
    const line = composeBoardInjectEnvelope({
      wakeEventId: "w1",
      canvasName: "main",
      boardNodeId: "board-1",
      kind: "operator.topic.notify",
      topicTitle: "deploy window",
      excerptSource: "hold prod",
      createdAt: 1,
    });
    expect(line).toContain("[board - deploy window]");
    expect(line).toContain("mark_read or post optional");
    expect(line).not.toMatch(/must reply|required/i);
  });

  it("wakes a lazy seat before queueing a board prompt", async () => {
    const wakes: Array<{ readonly canvas: string; readonly nodeId: string }> = [];
    const calls: Array<{
      readonly bindingId: string;
      readonly text: string;
      readonly ready: boolean | undefined;
    }> = [];
    const sent = await deliverBoardWakeSeats({
      canvas: "main",
      wake: {
        wakeEventId: "wake-cold-seat",
        canvasName: "main",
        boardNodeId: "board-1",
        kind: "operator.notify.all",
        excerptSource: "hello",
        createdAt: 1,
      },
      payload: "[board - notify-all - board] hello",
      seats: [{ nodeId: "agent-a", target: { bindingId: "bind-a" } }],
      transport: {
        wakeManagedSeat: async (canvas, nodeId) => {
          wakes.push({ canvas, nodeId });
          return true;
        },
        sendManagedTerminalPrompt: async (bindingId, text, options) => {
          calls.push({ bindingId, text, ready: options?.ready });
          return true;
        },
      },
    });

    expect(sent).toBe(1);
    expect(wakes).toEqual([{ canvas: "main", nodeId: "agent-a" }]);
    expect(calls).toEqual([
      {
        bindingId: "bind-a",
        text: "[board - notify-all - board] hello",
        ready: true,
      },
    ]);
  });

  it("does not consume a board wake when the lazy seat cannot start", async () => {
    let sends = 0;
    const sent = await deliverBoardWakeSeats({
      canvas: "main",
      wake: {
        wakeEventId: "wake-cold-seat-refused",
        canvasName: "main",
        boardNodeId: "board-1",
        kind: "operator.notify.all",
        excerptSource: "hello",
        createdAt: 1,
      },
      payload: "[board - notify-all - board] hello",
      seats: [{ nodeId: "agent-a", target: { bindingId: "bind-a" } }],
      transport: {
        wakeManagedSeat: async () => false,
        sendManagedTerminalPrompt: async () => {
          sends += 1;
          return true;
        },
      },
    });

    expect(sent).toBe(0);
    expect(sends).toBe(0);
  });
});
