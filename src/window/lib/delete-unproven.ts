/**
 * The words of the Delete anyway question: a remote seat's machine could not
 * prove the stop, so the operator is told which machine and seat, and why.
 *
 * The copy is remote-design's, docs/plans/0.11/machines-attention-look.md
 * section 4. One pair of lines per machine and reason, in the table's order,
 * then by machine label: the reason, then what Delete anyway does there. The
 * open-signal and connected-edge lines from the first question follow the
 * pairs (mutations.ts adds them). A Boat machine asleep at the read says
 * asleep in place of unreachable or timeout. No line promises a later stop.
 */
import type { TerminalUnstoppedRemoteReason } from "@shared/ipc";

export type UnprovenStop = {
  /** The machine's label, never "this machine". */
  readonly machine: string;
  /** The seat's name on the canvas. */
  readonly seat: string;
  readonly reason: TerminalUnstoppedRemoteReason;
  /** This window's machine facts say the machine is asleep, not simply away. */
  readonly asleep: boolean;
};

type EffectiveReason = TerminalUnstoppedRemoteReason | "asleep";

const REASON_ORDER: ReadonlyArray<EffectiveReason> = [
  "epoch-changed",
  "refused",
  "timeout",
  "unreachable",
  "asleep",
];

/** Asleep is the window's own reason, in place of unreachable or timeout. */
const effectiveReason = (stop: UnprovenStop): EffectiveReason =>
  stop.asleep && (stop.reason === "unreachable" || stop.reason === "timeout")
    ? "asleep"
    : stop.reason;

/** Up to three seats by name; past three, the first two and the rest by count (never "and 1 more"). */
const seatList = (seats: ReadonlyArray<string>): string => {
  if (seats.length === 0) return "this seat";
  if (seats.length <= 3) {
    return seats.length === 1
      ? seats[0]!
      : `${seats.slice(0, -1).join(", ")} and ${seats[seats.length - 1]!}`;
  }
  return `${seats.slice(0, 2).join(", ")} and ${seats.length - 2} more`;
};

const reasonLine = (reason: EffectiveReason, machine: string, seats: ReadonlyArray<string>): string => {
  const list = seatList(seats);
  switch (reason) {
    case "epoch-changed":
      return `${list} restarted on ${machine} while Junto was stopping ${seats.length === 1 ? "it" : "them"}.`;
    case "refused":
      return `${machine} would not stop ${list}.`;
    case "timeout":
      return `${machine} did not answer in time, so Junto could not stop ${list} there.`;
    case "unreachable":
      return `Junto cannot reach ${machine}, so it could not stop ${list} there.`;
    case "asleep":
      return `${machine} is asleep, so Junto could not stop ${list} there.`;
  }
};

const consequenceLine = (machine: string, count: number): string =>
  count === 1
    ? `Delete anyway removes it here, and it may keep running on ${machine}.`
    : `Delete anyway removes them here, and they may keep running on ${machine}.`;

/** The reason and consequence pairs, grouped by machine and reason. */
export const unprovenStopLines = (stops: ReadonlyArray<UnprovenStop>): ReadonlyArray<string> => {
  const groups = new Map<string, { machine: string; reason: EffectiveReason; seats: string[] }>();
  for (const stop of stops) {
    const reason = effectiveReason(stop);
    const key = `${stop.machine}\0${reason}`;
    const group = groups.get(key) ?? { machine: stop.machine, reason, seats: [] };
    if (!group.seats.includes(stop.seat)) group.seats.push(stop.seat);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort(
      (left, right) =>
        REASON_ORDER.indexOf(left.reason) - REASON_ORDER.indexOf(right.reason) ||
        left.machine.localeCompare(right.machine),
    )
    .flatMap(({ machine, reason, seats }) => [reasonLine(reason, machine, seats), consequenceLine(machine, seats.length)]);
};
