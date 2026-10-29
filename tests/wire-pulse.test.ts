import { describe, expect, it } from "vitest";
import type { Message } from "../src/shared/work-model";
import { mailExtensionMetadata, type MailExtension } from "../src/shared/crew";
import {
  WIRE_TRAFFIC_PREVIEW_MAX,
  wireTrafficOfMail,
  wireTrafficPreview,
} from "../src/shared/wire-traffic";
import {
  WIRE_PULSE_DASH,
  WIRE_PULSE_MAX_ACTIVE,
  WIRE_PULSE_MS,
  WIRE_PULSE_WIDTH,
  WirePulseScheduler,
  pickPulseEdge,
  pulseMover,
  pulseOnScreen,
  pulsePlan,
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
    const edges = [edge("e0", "a", "b", "navigates"), edge("e1", "b", "a", "navigates"), edge("e2", "a", "b", "messages")];
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

describe("the dash's legs", () => {
  const HALF = WIRE_PULSE_WIDTH / 2;
  /** A point `s` along a leg's straight line, from its origin. */
  const along = (leg: { x: number; y: number; angle: number; at: number }, s: number) => {
    const rad = (leg.angle * Math.PI) / 180;
    return { x: leg.x + Math.cos(rad) * (s - leg.at), y: leg.y + Math.sin(rad) * (s - leg.at) };
  };

  it("lays a straight wire as one leg, end to end", () => {
    const plan = pulsePlan("M10,20 L210,20");
    expect(plan.length).toBeCloseTo(200);
    expect(plan.legs).toEqual([{ x: 10, y: 20, length: 200, angle: 0, at: 0 }]);
  });

  it("runs each leg to the sharp corner, half the weight past it, and places the dash as the wire does", () => {
    // A smooth-step wire: right 92, a rounded corner of 8, down 92.
    const plan = pulsePlan("M0,0 L92,0 Q100,0 100,8 L100,100");
    expect(plan.legs).toHaveLength(2);
    const [first, second] = plan.legs as [NonNullable<(typeof plan.legs)[0]>, NonNullable<(typeof plan.legs)[0]>];
    expect(first).toMatchObject({ x: 0, y: 0, angle: 0, at: 0 });
    expect(first.length).toBeCloseTo(100 + HALF);
    expect(second.angle).toBeCloseTo(90);
    expect(second.x).toBeCloseTo(100);
    expect(second.y).toBeCloseTo(-HALF);
    expect(second.length).toBeCloseTo(100 + HALF);
    // The corner is a curve: the wire is shorter than its two legs.
    const curve = plan.length - 184;
    expect(curve).toBeGreaterThan(8 * Math.SQRT2);
    expect(curve).toBeLessThan(16);
    // On either straight part a leg puts a point where the wire has it.
    expect(along(first, 50)).toEqual({ x: 50, y: 0 });
    const p = along(second, 92 + curve + 10);
    expect(p.x).toBeCloseTo(100);
    expect(p.y).toBeCloseTo(18);
  });

  it("parses React Flow's spaced smooth step the same", () => {
    const tight = pulsePlan("M0,0 L92,0 Q100,0 100,8 L100,100");
    const spaced = pulsePlan("M 0,0L 92,0Q 100,0 100,8L 100,100");
    expect(spaced).toEqual(tight);
  });

  it("splits a turn with no rounding at the sharp corner", () => {
    const plan = pulsePlan("M0,0 L50,0 L50,50");
    expect(plan.legs.map((leg) => [leg.length, Math.round(leg.angle), leg.at])).toEqual([
      [50 + HALF, 0, 0],
      [50 + HALF, 90, 50 - HALF],
    ]);
  });

  it("carries the dash from just before the start to just past the end, either way", () => {
    const plan = pulsePlan("M0,0 L92,0 Q100,0 100,8 L100,100");
    const dash = WIRE_PULSE_DASH * plan.length;
    for (const leg of plan.legs) {
      const forward = pulseMover(plan, leg, false);
      expect(forward.travel).toBeCloseTo(plan.length + dash);
      expect(forward.dash).toBeCloseTo(dash + WIRE_PULSE_WIDTH);
      // The dash's own start (inside its cap) at the start and end of travel.
      expect(forward.left + HALF + leg.at).toBeCloseTo(-dash);
      expect(forward.left + forward.travel + HALF + leg.at).toBeCloseTo(plan.length);
      const reverse = pulseMover(plan, leg, true);
      expect(reverse.left + HALF + leg.at).toBeCloseTo(plan.length);
      expect(reverse.left - reverse.travel + HALF + leg.at).toBeCloseTo(-dash);
    }
  });
});
