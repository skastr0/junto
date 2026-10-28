/**
 * The closed `seat.control` / `seat.control.settled` row pair (0.11, 05 S4):
 * its wire shape refuses every field a control does not carry, its actor
 * rules bind the automation and the seat to their own identities, and the
 * seat's machine's own-copy verdict decides act, refuse or wait.
 */
import { Effect, Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  SEAT_CONTROL_PENDING_MAX_MS,
  SEAT_CONTROL_RATE_LIMIT,
  SeatControlResult,
  SeatControlSettledResult,
  isSeatControlBody,
  judgeSeatControl,
  seatControlEntitled,
  seatControlSettledEntitled,
} from "../src/shared/seat-control-row";
import { AUTOMATION_SEAT_ID } from "../src/shared/mail-author";
import { ActorSeatId } from "../src/shared/actor-seat";
import type { InstallationId } from "../src/shared/installation-id";
import { ItemId } from "../src/shared/work-ids";
import { AutomationNodeId } from "../src/shared/mail-author";
import { asNodeId } from "../src/shared/model";
import { runSeatControl } from "../src/main/junto/work/exchange/seat-controls";
import { automations, canvasOf, region, seat } from "./support/model-nodes";

const decodeControl = Schema.decodeUnknownResult(SeatControlResult, { onExcessProperty: "error" });
const decodeSettled = Schema.decodeUnknownResult(SeatControlSettledResult, { onExcessProperty: "error" });

const seatId = (char: string) => Schema.decodeUnknownSync(ActorSeatId)(`seat_${char.repeat(64)}`);
const SEAT = seatId("1");
const AUTOMATION_NODE = Schema.decodeUnknownSync(AutomationNodeId)("automations-1");
const AUTOMATION = ItemId.make("01M5ESZPWMZZM3TZ88P6FVVK33");
const FIRING = ItemId.make("01M5ESZPWMZZM3TZ88P6FVVK34");
const MINI = "mini" as InstallationId;
const MACBOOK = "macbook" as InstallationId;

const controlBody = {
  operation: "seat.control" as const,
  seat: "worker",
  automationNode: AUTOMATION_NODE,
  automationId: AUTOMATION,
  firingId: FIRING,
  actionIndex: 0,
  op: "start" as const,
  actor: {
    seatId: AUTOMATION_SEAT_ID,
    canvasName: "factory",
    nodeId: AUTOMATION_NODE,
    automationId: AUTOMATION,
  },
};

const settledBody = {
  ...controlBody,
  operation: "seat.control.settled" as const,
  actor: { seatId: SEAT, canvasName: "factory", nodeId: "worker" },
  result: "applied" as const,
};

describe("seat.control", () => {
  it("decodes a well-formed control", () => {
    expect(Result.getOrThrow(decodeControl(controlBody))).toEqual(controlBody);
  });

  it("refuses an actor that is not the automation itself", () => {
    for (const actor of [
      { seatId: SEAT, canvasName: "factory", nodeId: "worker" },
      { seatId: AUTOMATION_SEAT_ID, canvasName: "factory", nodeId: "other-node", automationId: AUTOMATION },
      { seatId: AUTOMATION_SEAT_ID, canvasName: "factory", nodeId: AUTOMATION_NODE },
      { seatId: AUTOMATION_SEAT_ID, canvasName: "factory", nodeId: AUTOMATION_NODE, automationId: ItemId.make("01M5ESZPWMZZM3TZ88P6FVVK35") },
    ]) {
      expect(decodeControl({ ...controlBody, actor })._tag).toBe("Failure");
    }
  });

  it("refuses an op outside start and stop, and a step out of bounds", () => {
    expect(decodeControl({ ...controlBody, op: "restart" })._tag).toBe("Failure");
    expect(decodeControl({ ...controlBody, op: "eval" })._tag).toBe("Failure");
    expect(decodeControl({ ...controlBody, actionIndex: 16 })._tag).toBe("Failure");
  });
});

describe("seat.control.settled", () => {
  it("decodes applied and refused", () => {
    expect(Result.getOrThrow(decodeSettled(settledBody))).toEqual(settledBody);
    const refused = { ...settledBody, result: "refused" as const, reason: "not_permitted" as const };
    expect(Result.getOrThrow(decodeSettled(refused))).toEqual(refused);
  });

  it("refuses a settlement that is not the seat's own", () => {
    for (const actor of [
      controlBody.actor,
      { seatId: SEAT, canvasName: "factory", nodeId: "other-seat" },
      { seatId: SEAT, canvasName: "factory", nodeId: "worker", automationId: AUTOMATION },
    ]) {
      expect(decodeSettled({ ...settledBody, actor })._tag).toBe("Failure");
    }
  });

  it("requires a closed reason exactly when refused", () => {
    expect(decodeSettled({ ...settledBody, reason: "paused" })._tag).toBe("Failure");
    expect(decodeSettled({ ...settledBody, result: "refused" })._tag).toBe("Failure");
    // The closed set only: no command-domain word, no free text.
    expect(decodeSettled({ ...settledBody, result: "refused", reason: "not_in_reach" })._tag).toBe("Failure");
    expect(decodeSettled({ ...settledBody, result: "refused", reason: "harness failed to spawn" })._tag).toBe("Failure");
  });
});

describe("isSeatControlBody", () => {
  it("knows the pair and nothing else", () => {
    expect(isSeatControlBody({ operation: "seat.control" })).toBe(true);
    expect(isSeatControlBody({ operation: "seat.control.settled" })).toBe(true);
    expect(isSeatControlBody({ operation: "command.queued" })).toBe(false);
  });
});

describe("entitlement", () => {
  const placement = {
    seatOf: (nodeId: string) => (nodeId === "worker" ? { seatId: SEAT, machine: MINI } : undefined),
    automationOf: (nodeId: string, automationId: string) =>
      nodeId === AUTOMATION_NODE && automationId === AUTOMATION ? MACBOOK : undefined,
  };

  it("a control is for the seat's machine alone", () => {
    expect(seatControlEntitled(MINI, controlBody as SeatControlResult, placement)).toBe(true);
    expect(seatControlEntitled(MACBOOK, controlBody as SeatControlResult, placement)).toBe(false);
  });

  it("a settled row is for the automation's machine alone", () => {
    expect(seatControlSettledEntitled(MACBOOK, settledBody as SeatControlSettledResult, placement)).toBe(true);
    expect(seatControlSettledEntitled(MINI, settledBody as SeatControlSettledResult, placement)).toBe(false);
  });
});

// The judge's shared inputs; each case varies one field of them.
const automationNode = automations("automations-1", { x: 0, y: 0, width: 200, height: 100 });
const workerSeat = seat("worker", { x: 10, y: 10, width: 100, height: 50 });
const room = region("room", { x: 0, y: 0, width: 500, height: 500 });
const CANVAS = canvasOf([automationNode, room, workerSeat]);
const CONTROL = { seat: "worker", automationNode: AUTOMATION_NODE, automationId: AUTOMATION };
const AUTOMATION_FOLDED = { nodeId: asNodeId("automations-1"), author: { kind: "operator" as const }, archived: false };
const NOW = 1_700_000_000_000;

type JudgeCase = {
  readonly name: string;
  readonly canvas?: typeof CANVAS;
  readonly automation?: typeof AUTOMATION_FOLDED;
  readonly playing?: boolean;
  readonly recentForSeat?: number;
  readonly originAtEpochMs?: number;
  readonly firstSeenEpochMs?: number;
  readonly want: { readonly kind: string; readonly reason?: string };
};

const JUDGE_CASES: ReadonlyArray<JudgeCase> = [
  { name: "waits for the automation's fold", automation: undefined, want: { kind: "pending" } },
  { name: "acts in reach, playing, uncounted", want: { kind: "act" } },
  { name: "refuses an archived automation", automation: { ...AUTOMATION_FOLDED, archived: true }, want: { kind: "refused", reason: "not_permitted" } },
  {
    name: "refuses an automation moved off the row's node",
    automation: { ...AUTOMATION_FOLDED, nodeId: asNodeId("automations-2") },
    want: { kind: "refused", reason: "not_permitted" },
  },
  {
    name: "refuses a seat outside reach",
    canvas: canvasOf([
      automations("automations-1", { x: 10, y: 10, width: 50, height: 50 }),
      region("inner", { x: 0, y: 0, width: 150, height: 150 }),
      region("outer", { x: 300, y: 300, width: 500, height: 500 }),
      seat("worker", { x: 350, y: 350, width: 100, height: 50 }),
    ]),
    want: { kind: "refused", reason: "not_permitted" },
  },
  { name: "refuses a seat that is gone", canvas: canvasOf([automationNode, room]), want: { kind: "refused", reason: "not_found" } },
  {
    name: "refuses a node that is no seat",
    canvas: canvasOf([automationNode, room, { ...workerSeat, kind: "terminal" as const }]),
    want: { kind: "refused", reason: "not_permitted" },
  },
  { name: "refuses at once while paused, never held", playing: false, want: { kind: "refused", reason: "paused" } },
  {
    name: "refuses past the seat's settle bound",
    recentForSeat: SEAT_CONTROL_RATE_LIMIT,
    want: { kind: "refused", reason: "rate" },
  },
  {
    name: "refuses a control a day old on its own clock",
    originAtEpochMs: NOW - SEAT_CONTROL_PENDING_MAX_MS - 1,
    want: { kind: "refused", reason: "stale" },
  },
  {
    name: "refuses a control a day old on the machine's first sight",
    firstSeenEpochMs: NOW - SEAT_CONTROL_PENDING_MAX_MS - 1,
    want: { kind: "refused", reason: "stale" },
  },
  { name: "an unparseable origin is ancient", originAtEpochMs: Number.NaN, want: { kind: "refused", reason: "stale" } },
  { name: "a doomed control spends no rate", playing: false, recentForSeat: 0, want: { kind: "refused", reason: "paused" } },
];

describe("judgeSeatControl", () => {
  for (const test of JUDGE_CASES) {
    it(test.name, () => {
      expect(
        judgeSeatControl({
          canvas: test.canvas ?? CANVAS,
          control: CONTROL,
          automation: "automation" in test ? test.automation : AUTOMATION_FOLDED,
          playing: test.playing ?? true,
          recentForSeat: test.recentForSeat ?? 0,
          originAtEpochMs: test.originAtEpochMs ?? NOW,
          firstSeenEpochMs: test.firstSeenEpochMs ?? NOW,
          nowEpochMs: NOW,
        }),
      ).toEqual(test.want);
    });
  }
});

/**
 * Security review, condition 1: one table drives the same-machine path and
 * the admitted-row path. Only the transport differs — the local commit
 * records alone, the remote one settles — the verdict is identical.
 */
describe("one judge, both paths", () => {
  for (const test of JUDGE_CASES) {
    it(test.name, async () => {
      const judge = {
        canvas: test.canvas ?? CANVAS,
        automation: "automation" in test ? test.automation : AUTOMATION_FOLDED,
        playing: test.playing ?? true,
        recentForSeat: test.recentForSeat ?? 0,
        recordedOutcome: undefined,
        originAtEpochMs: test.originAtEpochMs ?? NOW,
        firstSeenEpochMs: test.firstSeenEpochMs ?? NOW,
        nowEpochMs: NOW,
      };
      const run = (commit: "record" | "settle") =>
        Effect.runPromise(
          runSeatControl({
            judge,
            control: CONTROL,
            act: Effect.void,
            commit: () => Effect.void,
          }),
        );
      const local = await run("record");
      const remote = await run("settle");
      expect(local).toEqual(remote);
      if (test.want.kind === "pending") expect(local).toBe("pending");
      else expect(local).toEqual({ outcome: test.want.kind === "act" ? "applied" : "refused", ...(test.want.reason === undefined ? {} : { reason: test.want.reason }) });
    });
  }

  it("a recorded outcome speaks first, on either path", async () => {
    const outcome = { outcome: "refused" as const, reason: "paused" as const };
    const result = await Effect.runPromise(
      runSeatControl({
        judge: {
          canvas: CANVAS,
          automation: AUTOMATION_FOLDED,
          playing: true,
          recentForSeat: 0,
          recordedOutcome: outcome,
          originAtEpochMs: NOW,
          firstSeenEpochMs: NOW,
          nowEpochMs: NOW,
        },
        control: CONTROL,
        act: Effect.void,
        commit: () => Effect.fail(new Error("a second settle is impossible")),
      }),
    );
    expect(result).toEqual(outcome);
  });
});
