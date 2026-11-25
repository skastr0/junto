/**
 * Signals as a thread reads them (src/core/work/thread-signals.ts), on the
 * pairing remote-security set: a seat's mail is a signal only when the signal
 * and the row name each other, the row is in that seat's own mailbox and the
 * seat wrote it, and no automation raised it. The operator's answer names
 * its signal; the head signal is the one whose answer is the thread's root;
 * a thread's open signal is its earliest open paired one.
 */
import { describe, expect, it } from "vitest";
import type { AgentSignal } from "../src/shared/wire/agent-signals";
import type { MailThreadMessage } from "../src/shared/wire/mail-threads";
import type { Message } from "../src/shared/work-model";
import { OPERATOR_SEAT_ID } from "../src/shared/work-reference";
import {
  answeredIn,
  heldIn,
  headSignalOf,
  pairedIn,
  settled,
  waits,
  openSignalOf,
  raisedIn,
  signalIdsOf,
  withSignals,
  type RowOf,
  type ThreadSignals,
} from "../src/core/work/thread-signals";

const SEAT = "seat-a";
const OTHER = "seat-b";
const THREAD = "01M8560000000000000000THRD";

const signal = (signalId: string, more: Partial<AgentSignal> = {}): AgentSignal => ({
  signalId,
  canvasName: "c",
  nodeId: SEAT,
  kind: "escalate",
  text: `signal ${signalId}`,
  createdAt: Number(signalId.slice(-2)),
  state: "open",
  threadId: THREAD,
  ...more,
});

const signalsOf = (...held: AgentSignal[]): ThreadSignals => ({
  signalOf: (signalId) => held.find((one) => one.signalId === signalId),
  openIn: (threadId) =>
    held.filter((one) => one.state === "open" && one.threadId === threadId).sort((a, b) => a.createdAt - b.createdAt),
});

/** The rows each mailbox holds. */
const rows = (boxes: Record<string, Message[]>): RowOf => (nodeId, messageId) => boxes[nodeId]?.find((row) => row.messageId === messageId);

const seatRow = (messageId: string, metadata: Record<string, unknown>, role: Message["role"] = "agent"): Message =>
  ({ messageId, role, parts: [], metadata: { factoryMail: true, threadId: THREAD, senderNodeId: SEAT, ...metadata } }) as unknown as Message;
const operatorRow = (messageId: string, metadata: Record<string, unknown>): Message =>
  ({ messageId, role: "user", parts: [], metadata: { factoryMail: true, ...metadata } }) as unknown as Message;

const seatEntry = (messageId: string, from = SEAT): MailThreadMessage => ({
  messageId,
  threadId: THREAD,
  from: { kind: "seat", nodeId: from, name: from },
  to: [{ kind: "operator" }],
  mine: false,
  text: "words",
  at: 1,
});
const operatorEntry = (messageId: string, to = SEAT): MailThreadMessage => ({
  messageId,
  threadId: THREAD,
  from: { kind: "operator" },
  to: [{ kind: "seat", nodeId: to, name: to }],
  mine: true,
  text: "answer",
  at: 1,
});

describe("a seat's mail that is a signal", () => {
  it("reads as the signal when both name each other in the seat's own mailbox", () => {
    const raised = signal("S01", { messageId: "M01", form: { kind: "proof" } });
    const rowOf = rows({ [SEAT]: [seatRow("M01", { raisedSignalId: "S01" })] });
    const [read] = withSignals([seatEntry("M01")], signalsOf(raised), rowOf);
    expect(read?.signal).toEqual({ signalId: "S01", kind: "escalate", state: "open", text: "signal S01", asks: "proof" });
  });

  it("is a plain reply until both are here, or when either names another", () => {
    const rowOf = rows({ [SEAT]: [seatRow("M01", { raisedSignalId: "S01" })] });
    // The signal is not here yet.
    expect(raisedIn(seatEntry("M01"), signalsOf(), rowOf)).toBeUndefined();
    // The signal names another mail.
    expect(raisedIn(seatEntry("M01"), signalsOf(signal("S01", { messageId: "M99" })), rowOf)).toBeUndefined();
    // The row names no signal.
    expect(raisedIn(seatEntry("M01"), signalsOf(signal("S01", { messageId: "M01" })), rows({ [SEAT]: [seatRow("M01", {})] }))).toBeUndefined();
  });

  it("is never another seat's signal, an automation's, or a row the seat did not write", () => {
    const rowOf = rows({ [SEAT]: [seatRow("M01", { raisedSignalId: "S01" })], [OTHER]: [seatRow("M02", { raisedSignalId: "S02", senderNodeId: OTHER })] });
    // Another seat's signal, named from this seat's mail.
    expect(raisedIn(seatEntry("M01"), signalsOf(signal("S01", { messageId: "M01", nodeId: OTHER })), rowOf)).toBeUndefined();
    // An automation raised it.
    expect(raisedIn(seatEntry("M01"), signalsOf(signal("S01", { messageId: "M01", source: { kind: "automation" } as never })), rowOf)).toBeUndefined();
    // A row in the seat's mailbox it did not write (the operator's, naming a raise).
    const forged = rows({ [SEAT]: [seatRow("M01", { raisedSignalId: "S01" }, "user")] });
    expect(raisedIn(seatEntry("M01"), signalsOf(signal("S01", { messageId: "M01" })), forged)).toBeUndefined();
    // A row an automation wrote, though in the seat's mailbox under its name.
    const automated = rows({ [SEAT]: [seatRow("M01", { raisedSignalId: "S01", senderAutomationId: "auto-1" })] });
    expect(raisedIn(seatEntry("M01"), signalsOf(signal("S01", { messageId: "M01" })), automated)).toBeUndefined();
    expect(openSignalOf(THREAD, signalsOf(signal("S01", { messageId: "M01" })), automated)).toBeUndefined();
    // A row that says another seat wrote it.
    const other = rows({ [SEAT]: [seatRow("M01", { raisedSignalId: "S01", senderNodeId: OTHER })] });
    expect(raisedIn(seatEntry("M01"), signalsOf(signal("S01", { messageId: "M01" })), other)).toBeUndefined();
  });
});

describe("an answer and a withdrawal that crossed", () => {
  it("reads as crossed whichever closing landed first, and not otherwise", () => {
    const rowOf = rows({ [SEAT]: [seatRow("M01", { raisedSignalId: "S01" })] });
    const read = (held: AgentSignal) => withSignals([seatEntry("M01")], signalsOf(held), rowOf)[0]?.signal;
    const answer = { text: "go", at: 5 };
    expect(read(signal("S01", { messageId: "M01", state: "withdrawn", response: answer }))).toMatchObject({ state: "withdrawn", crossed: true });
    expect(read(signal("S01", { messageId: "M01", state: "answered", response: answer, withdrawnAt: 6 } as never))).toMatchObject({ state: "answered", crossed: true });
    expect(read(signal("S01", { messageId: "M01", state: "answered", response: answer }))?.crossed).toBeUndefined();
    expect(read(signal("S01", { messageId: "M01", state: "withdrawn" }))?.crossed).toBeUndefined();
  });
});

describe("an answer whose signal crossed a withdrawal", () => {
  it("waits for nothing: it is held, never typed, so the thread never says it arrives", () => {
    const rowOf = rows({ [SEAT]: [operatorRow("M05", { agentSignalId: "S01" })] });
    const sent = { ...operatorEntry("M05"), waiting: true as const };
    const crossedHere = signal("S01", { state: "withdrawn", response: { text: "go", at: 5 } });
    const crossedThere = signal("S01", { state: "answered", response: { text: "go", at: 5 }, withdrawnAt: 6 } as never);
    for (const crossed of [crossedHere, crossedThere]) {
      expect(waits(sent, signalsOf(crossed), rowOf)).toBe(false);
      expect(settled(sent, signalsOf(crossed), rowOf).waiting).toBeUndefined();
      expect(withSignals([sent], signalsOf(crossed), rowOf)[0]?.waiting).toBeUndefined();
    }
    // An answer to an open or plainly answered signal still waits for its seat.
    const answered = signal("S01", { state: "answered", response: { text: "go", at: 5 } });
    expect(waits(sent, signalsOf(answered), rowOf)).toBe(true);
    expect(withSignals([sent], signalsOf(answered), rowOf)[0]?.waiting).toBe(true);
    // Mail that answers nothing waits as it always did.
    expect(waits({ ...sent, messageId: "M09" }, signalsOf(crossedHere), rowOf)).toBe(true);
  });
});

describe("an answer held from its seat", () => {
  /** The operator's answer as the seat's mailbox holds it: stamped with the operator's own seat, no receipt. */
  const heldRow = (metadata: Record<string, unknown> = {}) => operatorRow("M05", { fromSeat: OPERATOR_SEAT_ID, agentSignalId: "S01", ...metadata });
  const sent = { ...operatorEntry("M05"), waiting: true as const };
  const withdrawn = signal("S01", { state: "withdrawn" });

  it("is named held, with no waiting mark, by the one rule delivery runs, when its signal is withdrawn", () => {
    const rowOf = rows({ [SEAT]: [heldRow()] });
    expect(heldIn(sent, signalsOf(withdrawn), rowOf)).toBe(true);
    const [read] = withSignals([sent], signalsOf(withdrawn), rowOf);
    expect(read).toMatchObject({ held: true, answers: { signalId: "S01" } });
    expect(read?.waiting).toBeUndefined();
    expect(waits(sent, signalsOf(withdrawn), rowOf)).toBe(false);
  });

  it("says it once: a crossed signal says the crossing on the signal, so its held answer carries no second mark, on either machine", () => {
    const rowOf = rows({ [SEAT]: [heldRow()] });
    // The seat's machine: withdrawn, holding the late answer. The editing machine: answered, with the withdrawal kept beside it.
    const faces = [
      signal("S01", { state: "withdrawn", response: { text: "go", at: 5 } }),
      signal("S01", { state: "answered", response: { text: "go", at: 5 }, withdrawnAt: 6 }),
    ];
    for (const face of faces) {
      // The rule still holds the mail (delivery), and the signal reads crossed.
      expect(heldIn(sent, signalsOf(face), rowOf)).toBe(true);
      const [read] = withSignals([sent], signalsOf(face), rowOf);
      expect(read?.held).toBeUndefined();
      expect(read?.waiting).toBeUndefined();
      expect(read?.answers).toMatchObject({ signalId: "S01" });
    }
  });

  it("is never held for an open signal, another seat's signal, an automation's, a mail with a receipt, or a mail that is not the operator's", () => {
    const rowOf = rows({ [SEAT]: [heldRow()] });
    expect(heldIn(sent, signalsOf(signal("S01", { state: "open" })), rowOf)).toBe(false);
    expect(heldIn(sent, signalsOf(signal("S01", { state: "withdrawn", nodeId: OTHER })), rowOf)).toBe(false);
    expect(heldIn(sent, signalsOf(signal("S01", { state: "withdrawn", source: { kind: "automation" } as never })), rowOf)).toBe(false);
    expect(heldIn(sent, signalsOf(withdrawn), rows({ [SEAT]: [heldRow({ deliveredAt: 7 })] }))).toBe(false);
    expect(heldIn(sent, signalsOf(withdrawn), rows({ [SEAT]: [heldRow({ readAt: 7 })] }))).toBe(false);
    // Stamped by another seat: no seat may silence mail by naming a signal.
    expect(heldIn(sent, signalsOf(withdrawn), rows({ [SEAT]: [heldRow({ fromSeat: `seat_${"d".repeat(64)}` })] }))).toBe(false);
    // A seat's own mail is never an answer.
    expect(heldIn(seatEntry("M01"), signalsOf(withdrawn), rows({ [SEAT]: [seatRow("M01", { agentSignalId: "S01" })] }))).toBe(false);
  });
});

describe("a signal paired with its mail, seen from the signal", () => {
  it("is paired only with its own row in its thread, naming it back", () => {
    const raised = signal("S01", { messageId: "M01" });
    expect(pairedIn(raised, rows({ [SEAT]: [seatRow("M01", { raisedSignalId: "S01" })] }))).toBe(true);
    expect(pairedIn(raised, rows({}))).toBe(false);
    expect(pairedIn(raised, rows({ [SEAT]: [seatRow("M01", { raisedSignalId: "S99" })] }))).toBe(false);
    expect(pairedIn(raised, rows({ [SEAT]: [seatRow("M01", { raisedSignalId: "S01", threadId: "01M8560000000000000000ELSE" })] }))).toBe(false);
    expect(pairedIn(raised, rows({ [SEAT]: [seatRow("M01", { raisedSignalId: "S01", senderAutomationId: "a" })] }))).toBe(false);
    expect(pairedIn({ ...raised, threadId: undefined } as AgentSignal, rows({ [SEAT]: [seatRow("M01", { raisedSignalId: "S01" })] }))).toBe(false);
  });
});

describe("the operator's answer and the head signal", () => {
  it("names the signal it answered, with its words, for a signal of the seat it went to", () => {
    const answered = signal("S01", { state: "answered" });
    const rowOf = rows({ [SEAT]: [operatorRow("M05", { agentSignalId: "S01" })] });
    const [read] = withSignals([operatorEntry("M05")], signalsOf(answered), rowOf);
    expect(read?.answers).toEqual({ signalId: "S01", kind: "escalate", text: "signal S01" });
    // Mail to another seat that names this seat's signal answers nothing.
    const elsewhere = rows({ [OTHER]: [operatorRow("M05", { agentSignalId: "S01" })] });
    expect(answeredIn(operatorEntry("M05", OTHER), signalsOf(answered), elsewhere)).toBeUndefined();
  });

  it("gives the signal whose answer is the thread's root as its head, at the signal's time", () => {
    const answered = signal("S07", { state: "answered" });
    const root = { ...operatorEntry(THREAD), messageId: THREAD };
    const rowOf = rows({ [SEAT]: [operatorRow(THREAD, { agentSignalId: "S07" })] });
    expect(headSignalOf(THREAD, [root], signalsOf(answered), rowOf)).toEqual({ signalId: "S07", kind: "escalate", state: "answered", text: "signal S07", at: 7 });
    // A root that answers nothing, or a thread whose root is not held, has no head.
    expect(headSignalOf(THREAD, [root], signalsOf(), rowOf)).toBeUndefined();
    expect(headSignalOf(THREAD, [operatorEntry("M05")], signalsOf(answered), rowOf)).toBeUndefined();
  });

  it("asks the store for every id the rows name", () => {
    const rowOf = rows({ [SEAT]: [seatRow("M01", { raisedSignalId: "S01" }), operatorRow("M05", { agentSignalId: "S02" })] });
    expect(signalIdsOf([seatEntry("M01"), operatorEntry("M05"), seatEntry("M09")], rowOf)).toEqual(["S01", "S02"]);
  });
});

describe("a thread's open signal", () => {
  it("is the earliest open one paired with its mail in that thread", () => {
    const rowOf = rows({
      [SEAT]: [seatRow("M02", { raisedSignalId: "S02" }), seatRow("M03", { raisedSignalId: "S03" })],
    });
    // S01 has no mail here yet; S02 is the earliest paired; S03 comes after.
    const held = signalsOf(signal("S01", { messageId: "M01" }), signal("S02", { messageId: "M02", kind: "blocked" }), signal("S03", { messageId: "M03" }));
    expect(openSignalOf(THREAD, held, rowOf)).toEqual({ signalId: "S02", kind: "blocked", text: "signal S02" });
    // Closed, none is open.
    expect(openSignalOf(THREAD, signalsOf(signal("S02", { messageId: "M02", state: "withdrawn" })), rowOf)).toBeUndefined();
  });

  it("is not a signal whose mail sits in another thread", () => {
    const rowOf = rows({ [SEAT]: [seatRow("M02", { raisedSignalId: "S02", threadId: "01M8560000000000000000ELSE" })] });
    expect(openSignalOf(THREAD, signalsOf(signal("S02", { messageId: "M02" })), rowOf)).toBeUndefined();
  });
});
