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
import {
  answeredIn,
  headSignalOf,
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
