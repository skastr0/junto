/**
 * Mail threads on the phone: the desktop's derivation cut to the wire's
 * bounds and fitted to one frame, the demo's round trip, and the closed
 * args (remote-security's route terms: bounded, closed args with ULID ids;
 * bodies and names unscrubbed; refusals fixed; fit by bytes).
 */
import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  clipText,
  companionSendRefusal,
  companionThreadMessage,
  companionThreadMessages,
  companionThreads,
} from "../src/shared/companion-threads";
import { demoRequest, makeDemoHost } from "../src/shared/companion-demo";
import {
  COMPANION_MAX_OUTBOUND_BYTES,
  COMPANION_THREAD_PREVIEW_MAX,
  COMPANION_THREAD_TEXT_MAX,
  companionOk,
  decodeCompanionRequestLine,
  type CompanionRequestFrame,
} from "../src/shared/companion-protocol";
import { DEMO_CANVAS, DEMO_THREAD_MAIL } from "../src/shared/wire/companion-demo-fixture";
import type { MailThreadMessage, MailThreadSummary } from "../src/shared/wire/mail-threads";

const ULID = (n: number) => `01KAZ3Q8X4V6W2N5R7T9${String(n).padStart(6, "0")}`;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** Every field at, or past, the most the store could hold. */
const worstSeat = (n: number) => ({ kind: "seat" as const, nodeId: `${"\u0001".repeat(250)}${String(n).padStart(6, "0")}`, name: "\u0001".repeat(5_000) });
const worstMessage = (n: number): MailThreadMessage => ({
  messageId: ULID(n),
  threadId: ULID(n),
  inReplyTo: ULID(n + 1),
  from: worstSeat(n),
  to: Array.from({ length: 40 }, (_, i) => worstSeat(i)),
  mine: false,
  text: "\u0001".repeat(200_000),
  at: n,
  mentions: Array.from({ length: 40 }, (_, i) => worstSeat(i)),
});

describe("the phone's cut of a thread", () => {
  it("cuts at a character boundary and says so", () => {
    expect(clipText("abc", 3)).toEqual({ text: "abc", cut: false });
    expect(clipText("ab\u{1F600}", 3)).toEqual({ text: "ab", cut: true });
    const preview = companionThreadMessage({ ...worstMessage(1), text: "x".repeat(1_000) }, COMPANION_THREAD_PREVIEW_MAX)!;
    expect(preview.text).toHaveLength(COMPANION_THREAD_PREVIEW_MAX);
    expect(preview.textCut).toBe(true);
    expect(companionThreadMessage(worstMessage(1))!.text).toHaveLength(COMPANION_THREAD_TEXT_MAX);
  });

  it("passes bodies and names through unscrubbed", () => {
    const message = companionThreadMessage({ ...worstMessage(1), text: "\u001b[31mred‮", from: { kind: "seat", nodeId: "a", name: "‮A" } })!;
    expect(message.text).toBe("\u001b[31mred‮");
    expect(message.from).toEqual({ kind: "seat", nodeId: "a", name: "‮A" });
  });

  it("leaves out a mail whose ids do not fit the wire, not the whole answer", () => {
    const long = { ...worstMessage(1), messageId: "m".repeat(200) };
    expect(companionThreadMessage(long)).toBeUndefined();
    expect(companionThreadMessages([long, worstMessage(2)]).messages.map((message) => message.messageId)).toEqual([ULID(2)]);
  });

  it("fits a worst-case threads.list and thread.get in one frame, newest kept", () => {
    const summaries: MailThreadSummary[] = Array.from({ length: 500 }, (_, n) => ({
      threadId: ULID(n),
      title: "\u0001".repeat(10_000),
      participants: Array.from({ length: 100 }, (_, i) => worstSeat(i)),
      startedAt: n,
      lastAt: n,
      last: worstMessage(n),
      messageCount: 1_000,
      canReply: true,
    }));
    const threads = companionThreads(summaries);
    expect(threads.cut).toBe(true);
    expect(threads.threads[0]!.threadId).toBe(ULID(0));
    const listFrame = companionOk("t1", "threads.list", threads);
    expect(listFrame.ok).toBe(true);
    expect(bytes(listFrame)).toBeLessThan(COMPANION_MAX_OUTBOUND_BYTES);

    const messages = companionThreadMessages(Array.from({ length: 500 }, (_, n) => worstMessage(n)));
    expect(messages.cut).toBe(true);
    expect(messages.messages.at(-1)!.messageId).toBe(ULID(499));
    const getFrame = companionOk("t2", "thread.get", messages);
    expect(getFrame.ok).toBe(true);
    expect(bytes(getFrame)).toBeLessThan(COMPANION_MAX_OUTBOUND_BYTES);
  });

  it("answers a send's refusal in fixed words, never a seat's name or the store's", () => {
    expect(companionSendRefusal("invalid", "Relay is not connected to Atlas, so it cannot be mentioned here.")).toBe(
      "A mentioned seat is not connected to this one.",
    );
    expect(companionSendRefusal("failed", "SQLITE_FULL: the body was ...")).toBe("The mail could not be sent.");
    expect(companionSendRefusal("not-found", "That thread is not one of this seat's.")).toBe("That thread is not one of this seat's.");
  });
});

describe("threads against the demo", () => {
  const frame = (op: string, args: object): CompanionRequestFrame => {
    const decoded = decodeCompanionRequestLine(demoRequest("t", op as never, args));
    if (Result.isFailure(decoded)) throw new Error(`${op} did not decode`);
    return decoded.success;
  };
  const root = DEMO_THREAD_MAIL[0]!;
  const atlasReply = DEMO_THREAD_MAIL[1]!;

  it("lists a seat's threads and reads one, the seat's reply to the operator included", async () => {
    const host = makeDemoHost({ appVersion: "test", machineName: "test-mac" });
    const list = await host.call(frame("threads.list", { canvasName: DEMO_CANVAS, nodeId: "atlas" }));
    expect(list).toMatchObject({ ok: true, result: { cut: false, threads: [{ threadId: root.threadId, canReply: true, messageCount: 3 }] } });
    const thread = await host.call(frame("thread.get", { canvasName: DEMO_CANVAS, nodeId: "atlas", threadId: root.threadId }));
    expect(thread).toMatchObject({
      ok: true,
      result: { cut: false, messages: [{ messageId: root.messageId, mentions: [{ nodeId: "relay" }] }, { messageId: atlasReply.messageId, to: [{ kind: "operator" }] }, {}] },
    });
    expect(await host.call(frame("thread.get", { canvasName: DEMO_CANVAS, nodeId: "quill", threadId: root.threadId }))).toMatchObject({
      ok: false,
      error: { code: "not-found" },
    });
    const seat = await host.call(frame("seat.get", { canvasName: DEMO_CANVAS, nodeId: "atlas" }));
    expect(seat).toMatchObject({ ok: true, result: { seat: { connected: [{ nodeId: "relay", name: "Relay" }] } } });
  });

  it("replies in a thread to the browsed seat alone, mentions as references, and starts a new one", async () => {
    const host = makeDemoHost({ appVersion: "test", machineName: "test-mac" });
    const reply = await host.call(
      frame("mail.send", { canvasName: DEMO_CANVAS, nodeId: "atlas", text: "Go ahead.", inReplyTo: atlasReply.messageId, mentions: ["relay"] }),
    );
    expect(reply).toMatchObject({ ok: true, result: { message: { nodeId: "atlas", threadId: root.threadId, inReplyTo: atlasReply.messageId } } });
    const thread = await host.call(frame("thread.get", { canvasName: DEMO_CANVAS, nodeId: "atlas", threadId: root.threadId }));
    expect(thread.ok && "messages" in thread.result && thread.result.messages.at(-1)).toMatchObject({
      text: "Go ahead.",
      to: [{ kind: "seat", nodeId: "atlas" }],
      mentions: [{ nodeId: "relay" }],
    });

    const fresh = await host.call(frame("mail.send", { canvasName: DEMO_CANVAS, nodeId: "quill", text: "New topic." }));
    const sent = fresh.ok && "message" in fresh.result ? fresh.result.message : undefined;
    expect(sent?.threadId).toBe(sent?.messageId);
    expect(await host.call(frame("thread.get", { canvasName: DEMO_CANVAS, nodeId: "quill", threadId: sent!.threadId! }))).toMatchObject({
      ok: true,
      result: { messages: [{ text: "New topic." }] },
    });
  });

  it("refuses a mention of a seat not wired here, and mail into another seat's thread, in fixed words", async () => {
    const host = makeDemoHost({ appVersion: "test", machineName: "test-mac" });
    expect(await host.call(frame("mail.send", { canvasName: DEMO_CANVAS, nodeId: "atlas", text: "Hi", mentions: ["quill"] }))).toMatchObject({
      ok: false,
      error: { code: "invalid", message: "A mentioned seat is not connected to this one." },
    });
    expect(await host.call(frame("mail.send", { canvasName: DEMO_CANVAS, nodeId: "quill", text: "Hi", threadId: root.threadId }))).toMatchObject({
      ok: false,
      error: { code: "not-found", message: "That thread is not one of this seat's." },
    });
  });

  it("closes the thread args: an unknown field or a mail id that is not a ULID is refused", () => {
    const refused = (op: string, args: object) => Result.isFailure(decodeCompanionRequestLine(demoRequest("x", op as never, args)));
    expect(refused("thread.get", { canvasName: DEMO_CANVAS, nodeId: "atlas", threadId: "not-a-ulid" })).toBe(true);
    expect(refused("threads.list", { canvasName: DEMO_CANVAS, nodeId: "atlas", later: 1 })).toBe(true);
    expect(refused("mail.send", { canvasName: DEMO_CANVAS, nodeId: "atlas", text: "Hi", to: ["relay"] })).toBe(true);
    expect(refused("mail.send", { canvasName: DEMO_CANVAS, nodeId: "atlas", text: "Hi", mentions: Array(33).fill("relay") })).toBe(true);
  });
});
