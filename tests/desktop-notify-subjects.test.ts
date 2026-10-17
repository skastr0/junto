import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  initialSnapshot,
  reduceSeatSignals,
  type SeatSignal,
  type SeatSnapshot,
} from "../src/shared/harness-domain";
import { BindingId as SeatBindingId } from "../src/shared/terminal-session-domain";
import { buildOperatorFeed, feedSeatsFromCanvas } from "../src/shared/operator-feed";
import type { AgentSignal } from "../src/shared/agent-signals";
import type { BindingId } from "../src/shared/model";
import { seatSubjects, subjectsFromFeed } from "../src/renderer/lib/desktop-notify";
import { canvasOf, seat } from "./support/model-nodes";

const canvas = canvasOf([seat("a1", { label: "Maple" }), seat("a2", { label: "Pip" }), seat("a3", { label: "Clove" })]);

const signal = (nodeId: string, kind: AgentSignal["kind"], text: string): AgentSignal =>
  ({
    signalId: `s-${nodeId}`,
    canvasName: "main",
    nodeId,
    kind,
    text,
    state: "open",
    createdAt: 1,
  }) as AgentSignal;

describe("desktop notification subjects", () => {
  it("maps feed items to categories and ladder levels, and leaves out the AI's reading", () => {
    const feed = buildOperatorFeed({
      canvasName: "main",
      nowMs: 10,
      seats: feedSeatsFromCanvas(canvas, {
        attentionByNodeId: new Map([["a3", { reason: "permission dialog", at: 5 }]]),
        healthByNodeId: new Map(),
      }),
      signals: [signal("a1", "blocked", "cannot reach the database"), signal("a2", "escalate", "which region?")],
    });
    expect(
      subjectsFromFeed(feed).map((subject) => [subject.seatName, subject.category, subject.level, subject.text]),
    ).toEqual([
      ["Maple", "blocked", "waiting", "cannot reach the database"],
      ["Clove", "needsYou", "waiting", "wants your input"],
      ["Pip", "needsYou", "escalated", "which region?"],
    ]);
  });

  const base = {
    canvasName: "main",
    seats: [["a1", "Maple"], ["a2", "Pip"], ["a3", "Clove"]].map(([id, label]) =>
      seat(id!, { label: label!, bindingId: `b-${id}` as BindingId }),
    ),
    seatState: () => ({ state: "idle", at: 42 }),
    needsLook: () => false,
    failure: () => undefined,
    exitMessage: () => undefined,
    lastSaid: () => undefined,
  };

  it("names a finished, unread seat with its own last words", () => {
    const subjects = seatSubjects({
      ...base,
      needsLook: (bindingId) => bindingId === "b-a1",
      lastSaid: (nodeId) => (nodeId === "a1" ? "migrations are in, tests pass" : undefined),
    });
    expect(subjects).toEqual([
      {
        key: "done:a1:42",
        category: "done",
        level: "ready",
        canvasName: "main",
        nodeId: "a1",
        seatName: "Maple",
        text: "migrations are in, tests pass",
      },
    ]);
  });

  it("reports a failed seat by its exit, before anything else about it", () => {
    const subjects = seatSubjects({
      ...base,
      needsLook: () => true,
      failure: (bindingId) => (bindingId === "b-a2" ? { epoch: "e7", code: 1 } : undefined),
      exitMessage: (bindingId) => (bindingId === "b-a2" ? "claude exited: rate limited" : undefined),
    });
    const pip = subjects.filter((subject) => subject.nodeId === "a2");
    expect(pip).toEqual([expect.objectContaining({ key: "failed:a2:e7", category: "failed", level: "stopped", text: "claude exited: rate limited" })]);
  });

  it("says nothing for a resting seat", () => {
    expect(seatSubjects(base)).toEqual([]);
  });

  describe("a seat whose status stopped", () => {
    const seatId = Schema.decodeSync(SeatBindingId)("b-a1");
    const fold = (...signals: SeatSignal[]): SeatSnapshot =>
      reduceSeatSignals(
        initialSnapshot(seatId, 0),
        signals.map((signal, index) => ({ seat: seatId, at: 1_000 + index * 10, source: "transcript", fidelity: "native", signal })),
      );
    const stoppedBy = (snapshot: SeatSnapshot, now = 2_000) =>
      seatSubjects({ ...base, needsLook: () => true, status: (bindingId) => (bindingId === "b-a1" ? snapshot : undefined), now }).filter(
        (subject) => subject.nodeId === "a1",
      );
    const resetsAt = new Date(2026, 9, 17, 15, 0).getTime();

    it("posts a usage limit nothing wakes as failed, at the stopped rung, before its finished turn", () => {
      const snapshot = fold(
        { _tag: "TurnStarted" },
        { _tag: "UsageLimitHit", scope: "weekly", resetsAt, message: "You've hit your weekly limit" },
      );
      expect(stoppedBy(snapshot, new Date(2026, 9, 17, 9, 0).getTime())).toEqual([
        {
          key: `stopped:a1:${snapshot.since}`,
          category: "failed",
          level: "stopped",
          canvasName: "main",
          nodeId: "a1",
          seatName: "Maple",
          text: "hit a usage limit, resets 15:00",
        },
      ]);
    });

    it("posts a sign-in error and a crash in the feed's words", () => {
      const auth = fold({ _tag: "ErrorRaised", kind: "auth", message: "Invalid API key, run /login" });
      const crash = fold({ _tag: "ErrorRaised", kind: "crash", message: "  " });
      expect(stoppedBy(auth).map((subject) => [subject.category, subject.level, subject.text])).toEqual([
        ["failed", "stopped", "stopped on a sign-in error"],
      ]);
      expect(stoppedBy(crash).map((subject) => [subject.category, subject.level, subject.text])).toEqual([
        ["failed", "stopped", "stopped on an error"],
      ]);
    });

    it("stays quiet for a limit Junto wakes at its reset, and for a retry", () => {
      const waking = fold(
        { _tag: "UsageLimitHit", scope: "5h", resetsAt, message: "limit" },
        { _tag: "WakeScheduled", at: resetsAt },
      );
      const retrying = fold({ _tag: "TurnStarted" }, { _tag: "Retrying", cause: "rate" });
      for (const snapshot of [waking, retrying]) {
        expect(stoppedBy(snapshot).filter((subject) => subject.category === "failed")).toEqual([]);
      }
    });
  });
});
