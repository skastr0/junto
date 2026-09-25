import { describe, expect, it } from "vitest";
import type { Message } from "../src/shared/canvas";
import { mailExtensionMetadata, type MailExtension } from "../src/shared/crew";
import {
  WIRE_TRAFFIC_PREVIEW_MAX,
  wireTrafficOfMail,
  wireTrafficPreview,
} from "../src/shared/wire-traffic";
import {
  WIRE_PULSE_MAX_ACTIVE,
  WIRE_PULSE_MS,
  WirePulseScheduler,
  pickPulseEdge,
  pulseOnScreen,
  type PulseEdge,
  type WirePulse,
} from "../src/renderer/lib/wire-pulse";

const SEAT = `seat_${"a".repeat(64)}` as MailExtension["fromSeat"];

const mail = (
  senderNodeId: string,
  text: string,
  mailKind: "notice" | "prompt" = "notice",
): Message => ({
  messageId: "01A",
  role: "user",
  parts: [{ kind: "text", text }],
  metadata: mailExtensionMetadata({
    mailKind,
    fromSeat: SEAT,
    senderNodeId,
    senderName: "planner",
    senderGeneration: "ep_a",
    senderHarness: "claude",
  }),
});

describe("wire traffic event", () => {
  it("names sender, receiver, kind, and a one-line preview", () => {
    const event = wireTrafficOfMail({
      canvasName: "crew",
      toNodeId: "b",
      message: mail("a", "\n  rebase   is done\nsecond line", "prompt"),
      at: 5,
    });
    expect(event).toEqual({
      canvasName: "crew",
      toNodeId: "b",
      fromNodeId: "a",
      fromName: "planner",
      kind: "prompt",
      messageId: "01A",
      preview: "rebase is done",
      at: 5,
    });
  });

  it("has no wire end for operator mail", () => {
    const event = wireTrafficOfMail({
      canvasName: "crew",
      toNodeId: "b",
      message: mail("operator", "Your connections changed."),
      at: 0,
    });
    expect(event.fromNodeId).toBeUndefined();
    expect(event.kind).toBe("notice");
  });

  it("bounds the preview", () => {
    const preview = wireTrafficPreview("x".repeat(500))!;
    expect(preview.length).toBe(WIRE_TRAFFIC_PREVIEW_MAX);
    expect(preview.endsWith("…")).toBe(true);
    expect(wireTrafficPreview("  \n \n")).toBeUndefined();
  });
});

const edge = (id: string, source: string, target: string, verb?: string): PulseEdge => ({
  id,
  source,
  target,
  ...(verb === undefined ? {} : { data: { verb } }),
});

describe("event to edge", () => {
  it("runs forward along an edge drawn sender to receiver", () => {
    expect(pickPulseEdge([edge("e1", "a", "b", "messages")], { fromNodeId: "a", toNodeId: "b" }))
      .toEqual({ edgeId: "e1", reverse: false });
  });

  it("runs reverse along an edge drawn receiver to sender", () => {
    expect(pickPulseEdge([edge("e1", "b", "a", "messages")], { fromNodeId: "a", toNodeId: "b" }))
      .toEqual({ edgeId: "e1", reverse: true });
  });

  it("prefers the messages wire over other verbs joining the same seats", () => {
    const edges = [edge("e0", "a", "b", "reads"), edge("e1", "b", "a", "reviews"), edge("e2", "a", "b", "messages")];
    expect(pickPulseEdge(edges, { fromNodeId: "a", toNodeId: "b" })?.edgeId).toBe("e2");
  });

  it("lights nothing without a sender or a joining wire", () => {
    const edges = [edge("e1", "a", "c", "messages")];
    expect(pickPulseEdge(edges, { toNodeId: "b" })).toBeUndefined();
    expect(pickPulseEdge(edges, { fromNodeId: "a", toNodeId: "b" })).toBeUndefined();
    expect(pickPulseEdge(edges, { fromNodeId: "b", toNodeId: "b" })).toBeUndefined();
  });

  it("skips wires whose ends are both off screen", () => {
    const viewport = { x: 0, y: 0, width: 1000, height: 800 };
    const box = (x: number, y: number) => ({ x, y, width: 100, height: 80 });
    expect(pulseOnScreen(box(10, 10), box(500, 500), viewport)).toBe(true);
    // Both ends off screen, but the wire between them crosses it.
    expect(pulseOnScreen(box(-500, 300), box(1600, 300), viewport)).toBe(true);
    expect(pulseOnScreen(box(2000, 0), box(2400, 900), viewport)).toBe(false);
  });
});

describe("burst coalescing", () => {
  const rig = () => {
    let now = 0;
    const painted = new Map<string, WirePulse>();
    const writes: string[] = [];
    const scheduler = new WirePulseScheduler(
      (edgeId, pulse) => {
        writes.push(edgeId);
        if (pulse === undefined) painted.delete(edgeId);
        else painted.set(edgeId, pulse);
      },
      () => now,
    );
    return {
      scheduler,
      painted,
      writes,
      advance: (ms: number) => {
        now += ms;
      },
    };
  };

  it("owes one follow-up for any number of mails landing mid-flight", () => {
    const { scheduler, painted } = rig();
    expect(scheduler.fire({ edgeId: "e1", reverse: false }, "notice")).toBe("started");
    for (let i = 0; i < 10; i += 1) {
      expect(scheduler.fire({ edgeId: "e1", reverse: true }, "prompt")).toBe("coalesced");
    }
    const first = painted.get("e1")!;
    scheduler.end("e1", first.seq);
    const second = painted.get("e1")!;
    expect(second).toMatchObject({ reverse: true, kind: "prompt" });
    expect(second.seq).toBeGreaterThan(first.seq);
    scheduler.end("e1", second.seq);
    expect(painted.has("e1")).toBe(false);
  });

  it("ignores the end of a pulse that was already replaced", () => {
    const { scheduler, painted } = rig();
    scheduler.fire({ edgeId: "e1", reverse: false }, "notice");
    const first = painted.get("e1")!;
    scheduler.fire({ edgeId: "e1", reverse: false }, "notice");
    scheduler.end("e1", first.seq);
    const second = painted.get("e1")!;
    scheduler.end("e1", first.seq);
    expect(painted.get("e1")).toBe(second);
  });

  it("drops traffic beyond the active cap instead of queueing it", () => {
    const { scheduler } = rig();
    for (let i = 0; i < WIRE_PULSE_MAX_ACTIVE; i += 1) {
      expect(scheduler.fire({ edgeId: `e${String(i)}`, reverse: false }, "notice")).toBe("started");
    }
    expect(scheduler.fire({ edgeId: "late", reverse: false }, "notice")).toBe("dropped");
    expect(scheduler.activeCount()).toBe(WIRE_PULSE_MAX_ACTIVE);
  });

  it("frees an edge whose animation never reported its end", () => {
    const { scheduler, painted, advance } = rig();
    scheduler.fire({ edgeId: "gone", reverse: false }, "notice");
    advance(WIRE_PULSE_MS * 3);
    expect(scheduler.fire({ edgeId: "other", reverse: false }, "notice")).toBe("started");
    expect(painted.has("gone")).toBe(false);
    expect(scheduler.activeCount()).toBe(1);
  });

  it("writes nothing when no traffic arrives", () => {
    const { writes, advance } = rig();
    advance(60_000);
    expect(writes).toEqual([]);
  });
});
