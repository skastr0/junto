/**
 * A seat's harness-domain status rides the seat-state plane: every published
 * event carries its encoded snapshot and top need, a remote hop and the
 * renderer keep it only when it decodes, and `junto seat read` shows it in
 * one line.
 */
import { describe, expect, it } from "vitest";
import { SeatStateMachine } from "../src/main/junto/term/agent-state";
import { reviveTermHostEvent } from "../src/main/junto/term/control-client";
import { decodeAgentSeatStateEvent } from "../src/renderer/lib/agent-seat-state";
import { agentSeatStatusOf } from "../src/shared/agent-seat-state";
import type { BindingId, SeatSnapshot, SeatStatus } from "../src/shared/harness-domain";
import { describeSeatStatus, seatStatusTime } from "../src/shared/seat-status-text";

const NOW = new Date(2026, 9, 16, 9, 0).getTime();
const at = (hour: number, minute = 0, day = 16): number => new Date(2026, 9, day, hour, minute).getTime();

const snapshotWith = (status: SeatStatus, extra: Partial<SeatSnapshot> = {}): SeatSnapshot => ({
  seat: "b1" as BindingId,
  status,
  since: NOW,
  statusSource: "screen",
  statusFidelity: "screen",
  channels: ["screen"],
  reports: [],
  awareness: [],
  updatedAt: NOW,
  ...extra,
});

const limited = (): ReturnType<SeatStateMachine["force"]> => {
  const m = new SeatStateMachine({ now: () => NOW });
  m.bind("b1", { harness: "codex", epoch: "e1" });
  return m.force("b1", "attention", "rule:usage_limit", "high", {
    signal: { _tag: "UsageLimitHit", scope: "weekly", resetsAt: at(15), message: "weekly limit" },
    source: "screen",
    fidelity: "screen",
  });
};

describe("every published event carries its status", () => {
  it("the snapshot the state projects, and its most urgent need", () => {
    const status = agentSeatStatusOf(limited());
    expect(status?.snapshot.status).toEqual({
      _tag: "Blocked",
      reason: { _tag: "UsageLimit", scope: "weekly", resetsAt: at(15) },
    });
    expect(status?.need).toMatchObject({ cause: "usage_limit", level: "stopped", urgency: 5 });
  });

  it("a gone event carries the exit", () => {
    const m = new SeatStateMachine({ now: () => NOW });
    m.bind("b1", { harness: "codex", epoch: "e1" });
    const gone = m.unbind("b1", { epoch: "e1", reason: "generation_exited" });
    expect(agentSeatStatusOf(gone ?? undefined)?.snapshot.status).toEqual({ _tag: "Exited" });
  });
});

describe("a status crosses a hop only when it decodes", () => {
  const hop = (event: unknown) =>
    reviveTermHostEvent({ type: "seat-state", bindingId: "b1", epoch: "e1", event });

  it("a remote seat keeps its status", () => {
    const revived = hop(limited());
    expect(revived?.type).toBe("seat-state");
    const event = revived?.type === "seat-state" ? revived.event : undefined;
    expect(agentSeatStatusOf(event)?.need.cause).toBe("usage_limit");
  });

  it("a status that does not read is dropped, the state is not", () => {
    const revived = hop({ ...limited(), status: { snapshot: { status: "blocked" } } });
    const event = revived?.type === "seat-state" ? revived.event : undefined;
    expect(event?.state).toBe("attention");
    expect(event?.status).toBeUndefined();
  });

  it("the renderer keeps a status that reads and drops one that does not", () => {
    expect(agentSeatStatusOf(decodeAgentSeatStateEvent(limited()))?.need.cause).toBe("usage_limit");
    const junk = decodeAgentSeatStateEvent({ ...limited(), status: 7 });
    expect(junk?.state).toBe("attention");
    expect(junk?.status).toBeUndefined();
  });
});

describe("the status in one line", () => {
  it("names the status, then why", () => {
    const line = (status: SeatStatus, extra?: Partial<SeatSnapshot>): string =>
      describeSeatStatus(snapshotWith(status, extra), NOW);
    expect(line({ _tag: "Blocked", reason: { _tag: "UsageLimit", scope: "weekly", resetsAt: at(15) } })).toBe(
      "Blocked UsageLimit weekly, resets 15:00",
    );
    expect(line({ _tag: "Blocked", reason: { _tag: "UsageLimit", scope: "5h" } })).toBe("Blocked UsageLimit 5h");
    expect(line({ _tag: "Blocked", reason: { _tag: "Permission", tool: "Bash" } })).toBe("Blocked Permission Bash");
    expect(line({ _tag: "Blocked", reason: { _tag: "Dialog", kind: "trust" } })).toBe("Blocked Dialog trust");
    expect(line({ _tag: "Blocked", reason: { _tag: "Error", kind: "auth", message: "not logged in" } })).toBe(
      "Blocked Error auth",
    );
    expect(line({ _tag: "Working", phase: "thinking" })).toBe("Working");
    expect(line({ _tag: "Working", phase: "retrying" })).toBe("Working retrying");
    expect(line({ _tag: "Working", phase: "thinking" }, { stalledSince: at(8, 55) })).toBe(
      "Working, stalled since 08:55",
    );
    expect(line({ _tag: "Exited", code: 1, expected: false })).toBe("Exited, code 1, unexpected");
    expect(line({ _tag: "Exited" })).toBe("Exited");
    expect(line({ _tag: "Idle" })).toBe("Idle");
  });

  it("a time on another day carries its date", () => {
    expect(seatStatusTime(at(15), NOW)).toBe("15:00");
    expect(seatStatusTime(at(7, 5, 18), NOW)).toBe("Oct 18 07:05");
  });
});
