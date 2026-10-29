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
import { mentionLink } from "../src/shared/mention";
import { asNodeId } from "../src/shared/physics/schema";
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
    expect(companionThreadMessages({ messages: [long, worstMessage(2)] }).messages.map((message) => message.messageId)).toEqual([ULID(2)]);
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
      owned: false,
      unread: 0,
    }));
    const threads = companionThreads({ threads: summaries });
    expect(threads.cut).toBe(true);
    expect(threads.threads[0]!.threadId).toBe(ULID(0));
    // Cut, the next page resumes after the last thread sent.
    const lastSent = summaries[threads.threads.length - 1]!;
    expect(threads.next).toBe(`${lastSent.lastAt}.${lastSent.threadId}`);
    const listFrame = companionOk("t1", "threads.list", threads);
    expect(listFrame.ok).toBe(true);
    expect(bytes(listFrame)).toBeLessThan(COMPANION_MAX_OUTBOUND_BYTES);

    const messages = companionThreadMessages({ messages: Array.from({ length: 500 }, (_, n) => worstMessage(n)) });
    expect(messages.cut).toBe(true);
    expect(messages.messages.at(-1)!.messageId).toBe(ULID(499));
    const firstSent = 500 - messages.messages.length;
    expect(messages.older).toBe(`${firstSent}.${ULID(firstSent)}`);
    const getFrame = companionOk("t2", "thread.get", messages);
    expect(getFrame.ok).toBe(true);
    expect(bytes(getFrame)).toBeLessThan(COMPANION_MAX_OUTBOUND_BYTES);
  });

  it("carries a thread's subject on its messages and its summary", () => {
    const subject = { kind: "task" as const, nodeId: asNodeId("board"), taskId: "01KAZ3Q8X4V6W2N5R7T9000042" as never };
    const message = { ...worstMessage(1), text: "x", from: { kind: "operator" as const }, to: [], subject };
    expect(companionThreadMessage(message)!.subject).toEqual(subject);
    const listed = companionThreads({
      threads: [{ threadId: ULID(1), title: "#42", participants: [], startedAt: 1, lastAt: 1, last: message, messageCount: 1, canReply: true, owned: true, unread: 0, subject }],
    });
    expect(listed.threads[0]).toMatchObject({ owned: true, subject, last: { subject } });
    expect(companionOk("s", "threads.list", listed).ok).toBe(true);
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
      result: { cut: false, messages: [{ messageId: root.messageId }, { messageId: atlasReply.messageId, to: [{ kind: "operator" }] }, {}] },
    });
    expect(await host.call(frame("thread.get", { canvasName: DEMO_CANVAS, nodeId: "quill", threadId: root.threadId }))).toMatchObject({
      ok: false,
      error: { code: "not-found" },
    });
    const seat = await host.call(frame("seat.get", { canvasName: DEMO_CANVAS, nodeId: "atlas" }));
    expect(seat).toMatchObject({ ok: true, result: { seat: { connected: [{ nodeId: "relay", name: "Relay" }] } } });
  });

  it("pages a seat's threads and a thread's messages by the cursors it hands out, and refuses an open arg", async () => {
    const host = makeDemoHost({ appVersion: "test", machineName: "test-mac" });
    const whole = await host.call(frame("threads.list", { canvasName: DEMO_CANVAS, nodeId: "atlas" }));
    const one = await host.call(frame("threads.list", { canvasName: DEMO_CANVAS, nodeId: "atlas", limit: 1 }));
    expect(whole).toMatchObject({ ok: true, result: { threads: [{ owned: true }] } });
    expect(one).toMatchObject({ ok: true, result: { cut: false, threads: { length: 1 } } });
    const newest = await host.call(frame("thread.get", { canvasName: DEMO_CANVAS, nodeId: "atlas", threadId: root.threadId, limit: 1 }));
    if (!newest.ok) throw new Error("thread.get failed");
    const page = newest.result as { messages: Array<{ messageId: string }>; older?: string };
    expect(page.messages).toHaveLength(1);
    expect(page.older).toBeDefined();
    const above = await host.call(frame("thread.get", { canvasName: DEMO_CANVAS, nodeId: "atlas", threadId: root.threadId, limit: 2, before: page.older }));
    expect(above).toMatchObject({ ok: true, result: { messages: [{ messageId: root.messageId }, { messageId: atlasReply.messageId }] } });
    expect((above as { result: { older?: string } }).result.older).toBeUndefined();
    for (const args of [{ limit: 0 }, { limit: 201 }, { after: "" }, { after: "x".repeat(257) }]) {
      expect(Result.isFailure(decodeCompanionRequestLine(demoRequest("t", "threads.list", { canvasName: DEMO_CANVAS, nodeId: "atlas", ...args })))).toBe(true);
    }
  });

  it("replies in a thread to the browsed seat alone, a mention as a link in the text, and starts a new one", async () => {
    const host = makeDemoHost({ appVersion: "test", machineName: "test-mac" });
    const text = `Go ahead, ${mentionLink({ kind: "seat", nodeId: asNodeId("relay") }, "Relay", DEMO_CANVAS)}.`;
    const reply = await host.call(
      // A list beside the text from an older phone is read and kept nowhere.
      frame("mail.send", { canvasName: DEMO_CANVAS, nodeId: "atlas", text, inReplyTo: atlasReply.messageId, mentions: ["relay"] }),
    );
    expect(reply).toMatchObject({ ok: true, result: { message: { nodeId: "atlas", threadId: root.threadId, inReplyTo: atlasReply.messageId } } });
    const thread = await host.call(frame("thread.get", { canvasName: DEMO_CANVAS, nodeId: "atlas", threadId: root.threadId }));
    expect(thread.ok && "messages" in thread.result && thread.result.messages.at(-1)).toMatchObject({
      text,
      to: [{ kind: "seat", nodeId: "atlas" }],
    });
    expect(thread.ok && "messages" in thread.result && thread.result.messages.at(-1)).not.toHaveProperty("mentions");

    const fresh = await host.call(frame("mail.send", { canvasName: DEMO_CANVAS, nodeId: "quill", text: "New topic." }));
    const sent = fresh.ok && "message" in fresh.result ? fresh.result.message : undefined;
    expect(sent?.threadId).toBe(sent?.messageId);
    expect(await host.call(frame("thread.get", { canvasName: DEMO_CANVAS, nodeId: "quill", threadId: sent!.threadId! }))).toMatchObject({
      ok: true,
      result: { messages: [{ text: "New topic." }] },
    });
  });

  it("reads a thread through its newest mail or a named one, forward only, and counts what came after, under every seat in it", async () => {
    const host = makeDemoHost({ appVersion: "test", machineName: "test-mac" });
    const summary = async (nodeId = "atlas") => {
      const list = await host.call(frame("threads.list", { canvasName: DEMO_CANVAS, nodeId }));
      if (!list.ok || !("threads" in list.result)) throw new Error("threads.list failed");
      return (list.result.threads as ReadonlyArray<{ threadId: string; unread?: number; readAt?: number }>).find((thread) => thread.threadId === root.threadId)!;
    };
    const never = await summary();
    expect(never.readAt).toBeUndefined();
    const theirs = DEMO_THREAD_MAIL.filter((mail) => mail.threadId === root.threadId && !mail.mine).length;
    expect(theirs).toBe(2);
    expect(never.unread).toBe(theirs);

    const first = await host.call(frame("threads.read", { canvasName: DEMO_CANVAS, nodeId: "atlas", threadId: root.threadId, through: atlasReply.messageId }));
    expect(first).toMatchObject({ ok: true, result: { thread: { threadId: root.threadId, unread: theirs - 1 } } });
    const all = await host.call(frame("threads.read", { canvasName: DEMO_CANVAS, nodeId: "atlas", threadId: root.threadId }));
    expect(all).toMatchObject({ ok: true, result: { thread: { unread: 0, readAt: expect.any(Number) } } });
    // An older mail does not move the point back; the same read twice answers the same.
    const back = await host.call(frame("threads.read", { canvasName: DEMO_CANVAS, nodeId: "atlas", threadId: root.threadId, through: root.messageId }));
    expect(back).toEqual({ ...all, id: back.id });
    expect(await summary()).toMatchObject({ unread: 0 });
    // The thread is between Atlas and Relay: one read point, read under either.
    expect(await summary("relay")).toMatchObject({ unread: 0, readAt: (all as { result: { thread: { readAt: number } } }).result.thread.readAt });

    expect(await host.call(frame("threads.read", { canvasName: DEMO_CANVAS, nodeId: "quill", threadId: root.threadId }))).toMatchObject({
      ok: false,
      error: { code: "not-found" },
    });
    expect(await host.call(frame("threads.read", { canvasName: DEMO_CANVAS, nodeId: "atlas", threadId: root.threadId, through: ULID(1) }))).toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
    expect(Result.isFailure(decodeCompanionRequestLine(demoRequest("t", "threads.read", { canvasName: DEMO_CANVAS, nodeId: "atlas", threadId: root.threadId, extra: 1 })))).toBe(true);
    expect(Result.isFailure(decodeCompanionRequestLine(demoRequest("t", "threads.read", { canvasName: DEMO_CANVAS, nodeId: "atlas", threadId: "nope" })))).toBe(true);
  });

  it("refuses a mention of a seat not wired here, and mail into another seat's thread, in fixed words", async () => {
    const host = makeDemoHost({ appVersion: "test", machineName: "test-mac" });
    expect(await host.call(frame("mail.send", { canvasName: DEMO_CANVAS, nodeId: "atlas", text: `Hi ${mentionLink({ kind: "seat", nodeId: asNodeId("quill") }, "Quill", DEMO_CANVAS)}` }))).toMatchObject({
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
