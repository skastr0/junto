/**
 * Needs projected onto occupancy, the region rollup, the operator feed and
 * desktop notifications. Each scenario folds real signals into a seat
 * snapshot, projects its needs, and compares with what today's surface code
 * shows for the same seat. Where they differ the difference must be listed:
 * an order disagreement from `ladderDisagreements`, or a `SURFACE_CHANGES`
 * entry.
 */
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  deriveNeeds,
  initialSnapshot,
  NEED_CAUSES,
  reduceSeatSignals,
  type NeedCause,
  type SeatSignal,
  type SignalEnvelope,
  type SignalSource,
} from "../src/shared/harness-domain";
import { BindingId } from "../src/shared/terminal-session-domain";
import {
  FEED_FROM_NEED,
  ladderDisagreements,
  NOTIFY_FROM_NEED,
  OCCUPANCY_FROM_NEED,
  projectNeeds,
  notifyNeed,
  ROLLUP_FROM_NEED,
  SURFACE_CHANGES,
  SURFACE_ORDER,
  type NeedProjection,
  type NeedSurface,
} from "../src/shared/need-surfaces";
import { DEFAULT_STALL_AFTER_MS, deriveOccupancy, OccupancySpectrum } from "../src/shared/occupancy/derive";
import { deriveRegionRollups } from "../src/shared/region-rollup";
import { buildOperatorFeed, feedSeatsFromCanvas } from "../src/shared/operator-feed";
import { FeedItemKind } from "../src/shared/wire/operator-feed";
import { levelOfFeedItem, rankOf } from "../src/shared/wire/urgency";
import { NOTIFY_CATEGORIES } from "../src/shared/desktop-notifications";
import type { AgentSeatState } from "../src/shared/agent-seat-state";
import type { AgentSignal } from "../src/shared/agent-signals";
import type { ThreadHealthReading } from "../src/shared/thread-health";
import type { BindingId as ModelBindingId } from "../src/shared/model";
import { clueFromAgentSeat, workSurfaceFromSeat } from "../src/renderer/lib/agent-seat-state";
import { seatSubjects, subjectsFromFeed } from "../src/renderer/lib/desktop-notify";
import { canvasOf, region, seat as seatNode } from "./support/model-nodes";

const NOW = 50_000_000;
const seatId = Schema.decodeSync(BindingId)("b-a");

let clock = 1_000;
const at = (source: SignalSource, signal: SeatSignal): SignalEnvelope => ({
  seat: seatId,
  at: (clock += 10),
  source,
  fidelity: source === "screen" ? "screen" : "native",
  signal,
});

const awareness = (value: "waiting_on_operator"): SignalEnvelope =>
  at("awareness", {
    _tag: "AwarenessAssessed",
    questionId: `health.${value}`,
    answer: { axis: "health", value },
    present: true,
    probability: 0.95,
    evidenceHash: "h",
    packVersion: "awareness-pack/2",
  });

const report = (kind: AgentSignal["kind"]): SignalEnvelope =>
  at("seat", { _tag: "SeatReported", kind, signalId: `s-${kind}`, state: "open" });

/** One seat, and what today's sources say about it. */
type Scenario = {
  readonly name: string;
  readonly signals: readonly SignalEnvelope[];
  readonly seatState: AgentSeatState;
  readonly needsLook?: boolean;
  readonly stalled?: boolean;
  readonly failedExit?: boolean;
  readonly attention?: boolean;
  readonly declared?: AgentSignal["kind"];
  readonly waitingReading?: boolean;
};

const SCENARIOS: readonly Scenario[] = [
  {
    name: "a permission prompt on the screen",
    signals: [at("screen", { _tag: "PermissionRequested" })],
    seatState: "attention",
    attention: true,
  },
  { name: "working", signals: [at("screen", { _tag: "TurnStarted" })], seatState: "working" },
  { name: "idle", signals: [at("screen", { _tag: "ActivityObserved", activity: "idle" })], seatState: "idle" },
  {
    name: "a finished turn nobody has read",
    signals: [at("screen", { _tag: "TurnStarted" }), at("screen", { _tag: "TurnEnded", outcome: "completed" })],
    seatState: "idle",
    needsLook: true,
  },
  {
    name: "working, then the heartbeat stalls",
    signals: [at("screen", { _tag: "TurnStarted" }), at("system", { _tag: "HeartbeatStalled", lastSeenAt: 1_000 })],
    seatState: "working",
    stalled: true,
  },
  {
    name: "a seat that declared itself blocked while working",
    signals: [at("screen", { _tag: "TurnStarted" }), report("blocked")],
    seatState: "working",
    declared: "blocked",
  },
  {
    name: "a seat that escalated while working",
    signals: [at("screen", { _tag: "TurnStarted" }), report("escalate")],
    seatState: "working",
    declared: "escalate",
  },
  {
    name: "an idle seat that posted feedback",
    signals: [at("screen", { _tag: "ActivityObserved", activity: "idle" }), report("feedback")],
    seatState: "idle",
    declared: "feedback",
  },
  {
    name: "an idle seat the AI reads as waiting on the operator",
    signals: [at("screen", { _tag: "ActivityObserved", activity: "idle" }), awareness("waiting_on_operator")],
    seatState: "idle",
    waitingReading: true,
  },
  {
    name: "an expected exit",
    signals: [at("process", { _tag: "ProcessExited", code: 0, expected: true })],
    seatState: "gone",
  },
  {
    name: "a failure exit",
    signals: [at("process", { _tag: "ProcessExited", code: 1, expected: false })],
    seatState: "gone",
    failedExit: true,
  },
];

// ── Today's surfaces, run for real ─────────────────────────────────────────

const event = (scenario: Scenario) => ({
  bindingId: "b-a",
  epoch: "e1",
  state: scenario.seatState,
  reason: "test",
  confidence: "high" as const,
  at: scenario.stalled ? NOW - DEFAULT_STALL_AFTER_MS - 1 : NOW,
});

const todayOccupancy = (scenario: Scenario): string => {
  const clue = clueFromAgentSeat(event(scenario), scenario.needsLook ?? false)!;
  return deriveOccupancy({ ...clue, nowMs: NOW });
};

const maple = seatNode("a", { x: 10, y: 10, width: 100, height: 40, label: "Maple", bindingId: "b-a" as ModelBindingId });
const canvas = canvasOf([region("r", { x: 0, y: 0, width: 500, height: 500 }, { label: "ops" }), maple]);

const todayRollup = (scenario: Scenario): string | undefined => {
  const surface = workSurfaceFromSeat(event(scenario), scenario.needsLook ?? false);
  const [rollup] = deriveRegionRollups({
    canvas,
    canvasName: "main",
    itemsOf: () => [],
    resolveActorRef: () => undefined,
    ...(surface ? { terminalStatusByNodeId: new Map([["a", surface]]) } : {}),
  });
  return rollup?.members.find((member) => member.nodeId === "a")?.severity;
};

const reading = (): ThreadHealthReading => ({
  bindingId: "b-a",
  value: "waiting_on_operator",
  confidence: 0.95,
  observedAt: NOW,
  provenance: { source: "jev", assessmentId: "as1", questionId: "health.waiting_on_operator", packVersion: "awareness-pack/2" },
  signals: [],
});

const snapshotOf = (scenario: Scenario) => reduceSeatSignals(initialSnapshot(seatId, 0), scenario.signals);

const todayFeed = (scenario: Scenario) =>
  buildOperatorFeed({
    canvasName: "main",
    nowMs: NOW,
    seats: feedSeatsFromCanvas(canvas, {
      attentionByNodeId: new Map(scenario.attention ? [["a", { reason: "permission dialog", at: NOW }]] : []),
      snapshotByNodeId: new Map([["a", snapshotOf(scenario)]]),
      healthByNodeId: new Map(scenario.waitingReading ? [["a", { reading: reading(), fresh: true }]] : []),
    }),
    signals: scenario.declared
      ? [
          {
            signalId: "s1",
            canvasName: "main",
            nodeId: "a",
            kind: scenario.declared,
            text: "said so",
            state: "open",
            createdAt: NOW,
          } as AgentSignal,
        ]
      : [],
  });

const worst = <V extends string>(values: readonly V[], rank: (value: V) => number): V | undefined =>
  [...values].sort((a, b) => rank(b) - rank(a))[0];

const todayFeedKind = (scenario: Scenario) =>
  worst(
    todayFeed(scenario).sections.flatMap((section) => section.items.map((item) => item.kind)),
    (kind) => rankOf(levelOfFeedItem(kind)),
  );

const todayNotify = (scenario: Scenario) =>
  worst(
    [
      ...subjectsFromFeed(todayFeed(scenario)),
      ...seatSubjects({
        canvasName: "main",
        seats: [maple],
        seatState: () => ({ state: scenario.seatState, at: NOW }),
        needsLook: () => scenario.needsLook ?? false,
        failure: () => (scenario.failedExit ? { epoch: "e1", code: 1 } : undefined),
        exitMessage: () => undefined,
        lastSaid: () => undefined,
      }),
    ].map((subject) => subject.category),
    (category) => NOTIFY_CATEGORIES.length - NOTIFY_CATEGORIES.indexOf(category),
  );

const TODAY: Readonly<Record<NeedSurface, (scenario: Scenario) => string | undefined>> = {
  occupancy: todayOccupancy,
  rollup: todayRollup,
  feed: todayFeedKind,
  notify: todayNotify,
};

const PROJECTION: Readonly<Record<NeedSurface, NeedProjection<string>>> = {
  occupancy: OCCUPANCY_FROM_NEED,
  rollup: ROLLUP_FROM_NEED,
  feed: FEED_FROM_NEED,
  notify: NOTIFY_FROM_NEED,
};

const SURFACES = ["occupancy", "rollup", "feed", "notify"] as const;

const needsOf = (scenario: Scenario) => deriveNeeds(snapshotOf(scenario));

const listedChange = (surface: NeedSurface, causes: readonly NeedCause[]): boolean =>
  SURFACE_CHANGES.some((change) => change.surface === surface && causes.some((cause) => change.causes.includes(cause)));

// ── Tests ──────────────────────────────────────────────────────────────────

describe("need surfaces: today's seats project to today's surfaces", () => {
  for (const scenario of SCENARIOS) {
    for (const surface of SURFACES) {
      it(`${surface}: ${scenario.name}`, () => {
        const needs = needsOf(scenario);
        const projected = projectNeeds(needs, PROJECTION[surface]);
        const today = TODAY[surface](scenario);
        if (projected === today) return;
        // A difference is allowed only where it is written down.
        expect(listedChange(surface, needs.map((need) => need.cause)), `${surface} shows ${today} today, ${projected} projected`).toBe(true);
      });
    }
  }

  it("agrees on every scenario wherever no change is listed", () => {
    const agreed = SCENARIOS.flatMap((scenario) =>
      SURFACES.filter((surface) => projectNeeds(needsOf(scenario), PROJECTION[surface]) === TODAY[surface](scenario)).map(
        (surface) => `${surface}: ${scenario.name}`,
      ),
    );
    // 11 scenarios x 4 surfaces, less the rollup rows it now shows: three
    // declared signals, a failure exit and the AI's waiting reading.
    expect(agreed).toHaveLength(SCENARIOS.length * SURFACES.length - 5);
  });
});

describe("need surfaces: tables", () => {
  it("cover every need cause on every surface", () => {
    const causes = Object.keys(NEED_CAUSES).sort();
    for (const projection of Object.values(PROJECTION)) expect(Object.keys(projection).sort()).toEqual(causes);
  });

  it("keep occupancy's values in step with its spectrum", () => {
    for (const value of Object.values(OCCUPANCY_FROM_NEED)) if (value !== null) expect(OccupancySpectrum.literals).toContain(value);
  });

  it("never ping on the AI's advisory reading, and rank it no higher than escalated", () => {
    const advisory = (Object.keys(NEED_CAUSES) as NeedCause[]).filter((cause) => cause.startsWith("awareness_"));
    for (const cause of advisory) {
      expect(NOTIFY_FROM_NEED[cause]).toBeNull();
      expect([null, "escalated"]).toContain(ROLLUP_FROM_NEED[cause]);
      expect(OCCUPANCY_FROM_NEED[cause]).toBeNull();
      expect([null, "health"]).toContain(FEED_FROM_NEED[cause]);
    }
  });
});

describe("need surfaces: where each surface's order disagrees with the ladder", () => {
  const summary = (surface: NeedSurface) =>
    ladderDisagreements(surface).map((entry) => `${entry.kind} ${entry.above} > ${entry.below}`);

  it("occupancy", () => {
    expect(summary("occupancy")).toEqual(["merged working > working", "merged idle > idle"]);
  });

  it("region rollup", () => {
    expect(summary("rollup")).toEqual([
      "merged blocked > blocked",
      "merged ready > ready",
      "merged working > working",
      "merged idle > idle",
    ]);
  });

  it("operator feed", () => {
    expect(summary("feed")).toEqual([]);
  });

  it("operator feed kind is each cause's level on the urgency ladder", () => {
    for (const kind of FeedItemKind.literals) {
      const causes = (Object.keys(NEED_CAUSES) as NeedCause[]).filter((cause) => FEED_FROM_NEED[cause] === kind);
      expect(causes.length, kind).toBeGreaterThan(0);
      for (const cause of causes) expect(levelOfFeedItem(kind), `${kind} from ${cause}`).toBe(NEED_CAUSES[cause].level);
    }
  });

  it("desktop notifications", () => {
    expect(summary("notify")).toEqual([]);
  });

  it("leaves only accepted disagreements on a surface that follows the ladder", () => {
    for (const surface of SURFACES) {
      const { order, accepted } = SURFACE_ORDER[surface];
      if (order !== "ladder") continue;
      expect(summary(surface), surface).toEqual(accepted.map((entry) => entry.disagreement));
    }
  });
});

describe("need surfaces: decisions", () => {
  it("orders notifications by ladder level, inside needsYou and across categories", () => {
    const rank = (cause: NeedCause) => rankOf(notifyNeed(cause)!.level);
    expect(notifyNeed("dialog")?.category).toBe("needsYou");
    expect(notifyNeed("seat_escalated")?.category).toBe("needsYou");
    expect(notifyNeed("seat_feedback")?.category).toBe("needsYou");
    expect(rank("dialog")).toBeGreaterThan(rank("seat_escalated"));
    expect(rank("seat_escalated")).toBeGreaterThan(rank("seat_feedback"));
    expect(rank("crash")).toBeGreaterThan(rank("dialog"));
    expect(rank("seat_blocked")).toBeGreaterThan(rank("crash"));
    expect(rank("seat_blocked")).toBeGreaterThan(rank("permission"));
    expect(notifyNeed("awareness_waiting")).toBeUndefined();
  });

  it("keeps a change open only where the surface's owner has not decided", () => {
    for (const change of SURFACE_CHANGES) {
      const order = SURFACE_ORDER[change.surface].order;
      expect(change.status, `${change.surface} ${change.causes.join(",")}`).toBe(order === "ladder" ? "decided" : "open");
      expect(change.decided !== undefined).toBe(change.status === "decided");
    }
  });
});
