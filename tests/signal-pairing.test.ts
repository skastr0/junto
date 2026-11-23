/**
 * The paired mark the core serves on a signal (src/core/work/signal-pairing.ts):
 * set once the seat's mail that is the signal is here too and each names the
 * other, checked again when mail lands after its signal, and kept once set.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSignal } from "../src/shared/wire/agent-signals";
import type { Message } from "../src/shared/work-model";
import { forgetPaired, markPaired, servedSignal } from "../src/core/work/signal-pairing";
import type { RowOf } from "../src/core/work/thread-signals";

const THREAD = "01M8560000000000000000THRD";
const signal = (signalId: string, more: Partial<AgentSignal> = {}): AgentSignal => ({
  signalId,
  canvasName: "c",
  nodeId: "seat-a",
  kind: "blocked",
  text: signalId,
  createdAt: 1,
  state: "open",
  threadId: THREAD,
  messageId: `M-${signalId}`,
  ...more,
});
const row = (messageId: string, raisedSignalId: string): Message =>
  ({ messageId, role: "agent", parts: [], metadata: { factoryMail: true, threadId: THREAD, senderNodeId: "seat-a", raisedSignalId } }) as unknown as Message;
const rowsOf = (...held: Message[]): RowOf => (nodeId, messageId) =>
  nodeId === "seat-a" ? held.find((one) => one.messageId === messageId) : undefined;

afterEach(() => forgetPaired());

describe("the paired mark on a served signal", () => {
  it("is absent until the mail is here, set when it lands, and kept on later changes", () => {
    const raised = signal("S1");
    expect(markPaired("c", [raised], rowsOf())).toEqual([]);
    expect(servedSignal(raised).paired).toBeUndefined();
    // The mail lands after the signal: the check pairs it, once.
    expect(markPaired("c", [raised], rowsOf(row("M-S1", "S1")))).toEqual([raised]);
    expect(markPaired("c", [raised], rowsOf(row("M-S1", "S1")))).toEqual([]);
    expect(servedSignal(raised).paired).toBe(true);
    // A later change to the signal is served still marked.
    expect(servedSignal({ ...raised, text: "edited" }).paired).toBe(true);
  });

  it("is never set for a row that names another signal, another canvas's signal, or one closed", () => {
    expect(markPaired("c", [signal("S1")], rowsOf(row("M-S1", "S2")))).toEqual([]);
    expect(markPaired("c", [signal("S1", { canvasName: "d" })], rowsOf(row("M-S1", "S1")))).toEqual([]);
    expect(markPaired("c", [signal("S1", { state: "withdrawn" })], rowsOf(row("M-S1", "S1")))).toEqual([]);
    expect(servedSignal(signal("S1")).paired).toBeUndefined();
  });
});
