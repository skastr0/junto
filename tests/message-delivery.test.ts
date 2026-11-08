import { note, seat, terminal } from "./support/model-nodes";
import { describe, expect, it } from "vitest";
import { ulid } from "ulid";
import type { Message } from "../src/shared/work-model";
import { AUTOMATION_SEAT_ID, NOTICE_SEAT_ID } from "../src/shared/mail-author";
import {
  composeMailBatch,
  composeMessageDeliveryPayload,
  composeImmediatePromptPayload,
  composeMessageDeliverySummary,
  deliveryTargetOf,
  isFactoryMailMessage,
  isForeignMessage,
  isMessageDelivered,
  isPendingDelivery,
  MAIL_BATCH_BODY_MAX,
  MAIL_BATCH_POINTER_MAX,
  MAIL_ONBOARD_POINTER,
  MAIL_TYPED_BODY_MAX,
  mailTypedWhole,
  messageBriefText,
  messageSenderLabel,
  MESSAGE_PTY_FULL_BODY_MAX,
  shouldSummarizeMessageForPty,
  sortMessagesNewestFirst,
} from "../src/shared/message-delivery";

const userMsg = (over: Partial<Message> = {}): Message => ({
  messageId: "m1",
  role: "user",
  parts: [{ kind: "text", text: "ping the lane" }],
  ...over,
});

describe("message-delivery pure helpers", () => {
  it("strips recognized current envelopes without dropping other sender-like prose", () => {
    const message = userMsg({
      metadata: { factoryMail: true, fromSeat: "seat-a", senderName: "Peer Reviewer" },
      parts: [{ kind: "text", text: "mail from Peer Reviewer\nReview the patch" }],
    });
    expect(composeMessageDeliveryPayload(message)).toBe("mail from Peer Reviewer, id m1\nReview the patch");
    expect(composeImmediatePromptPayload(message)).toBe("mail from Peer Reviewer, id m1\nReview the patch");
    expect(composeImmediatePromptPayload({ ...message, parts: [{ kind: "text", text: "mail from someone else should be checked" }] }))
      .toContain("mail from someone else should be checked");
  });
  it("preserves a prompt body and attributes it to the server-stamped sender", () => {
    const message = userMsg({
      metadata: { factoryMail: true, mailKind: "prompt", fromSeat: "seat_hash", senderName: "Reviewer" },
      parts: [{ kind: "text", text: "Read the patch.\nCheck the failing case." }],
    });
    expect(composeImmediatePromptPayload(message)).toBe(
      "mail from Reviewer, id m1\nRead the patch.\nCheck the failing case.",
    );
  });

  it("types operator thread mail with its id, its thread, and the reply to the operator", () => {
    const root = userMsg({
      messageId: "01M5BKZ0000000000000000000",
      metadata: { factoryMail: true, mailKind: "prompt", senderNodeId: "operator", senderName: "operator" },
      parts: [{ kind: "text", text: "Keep backfill progress in this thread." }],
    });
    expect(composeImmediatePromptPayload(root)).toBe(
      `mail from operator, id 01M5BKZ0000000000000000000 — reply: junto msg reply '{"target":"operator","inReplyTo":"01M5BKZ0000000000000000000","text":"..."}'\nKeep backfill progress in this thread.`,
    );
    const reply = userMsg({
      messageId: "01M5BKZ1111111111111111111",
      metadata: { ...root.metadata, threadId: "01M5BKZ0000000000000000000" },
      parts: [{ kind: "text", text: "Did you get a thread id?" }],
    });
    expect(composeImmediatePromptPayload(reply)).toBe(
      `mail from operator, id 01M5BKZ1111111111111111111, thread 01M5BKZ0000000000000000000 — reply: junto msg reply '{"target":"operator","inReplyTo":"01M5BKZ1111111111111111111","text":"..."}'\nDid you get a thread id?`,
    );
  });

  it("types a notice whole under one header: who sent it, its id, and the reply that answers it", () => {
    const notice = userMsg({
      messageId: "01KZSM4A84ASFRTZ77YAQ09CVH",
      metadata: { factoryMail: true, fromSeat: "seat_hash", senderNodeId: "agent-a", senderName: "Reviewer" },
      parts: [{ kind: "text", text: "Please review the contract.\n\n1. The cap\n2. The read stamp" }],
    });
    expect(composeMessageDeliveryPayload(notice)).toBe(
      "mail from Reviewer, id 01KZSM4A84ASFRTZ77YAQ09CVH — reply: junto msg reply " +
        `'{"target":"agent-a","inReplyTo":"01KZSM4A84ASFRTZ77YAQ09CVH","text":"..."}'` +
        "\nPlease review the contract.\n\n1. The cap\n2. The read stamp",
    );
    // The canvas names the sender at delivery, regions and all.
    expect(composeMessageDeliveryPayload(notice, { sender: { kind: "seat", label: "cli-lead (Junto / CLI)", replyTarget: "agent-a" } }))
      .toMatch(/^mail from cli-lead \(Junto \/ CLI\), id 01KZSM4A84ASFRTZ77YAQ09CVH — reply: /u);
    expect(mailTypedWhole(notice)).toBe(true);
  });

  it("names the thread when the notice is a reply in one, and never for a thread's own root", () => {
    const reply = userMsg({
      messageId: "01KZSM4A84ASFRTZ77YAQ09CVJ",
      metadata: { factoryMail: true, senderNodeId: "agent-a", senderName: "Reviewer", threadId: "01KZSM4A84ASFRTZ77YAQ09CVH" },
      parts: [{ kind: "text", text: "Done." }],
    });
    expect(composeMessageDeliveryPayload(reply).split("\n")[0]).toBe(
      "mail from Reviewer, id 01KZSM4A84ASFRTZ77YAQ09CVJ, thread 01KZSM4A84ASFRTZ77YAQ09CVH — reply: junto msg reply " +
        `'{"target":"agent-a","inReplyTo":"01KZSM4A84ASFRTZ77YAQ09CVJ","text":"..."}'`,
    );
    const root = { ...reply, metadata: { ...reply.metadata, threadId: reply.messageId } };
    expect(composeMessageDeliveryPayload(root)).not.toContain("thread");
  });

  it("names a subject thread's subject and replies to the subject, not the sender", () => {
    const comment = userMsg({
      messageId: "01KZSM4A84ASFRTZ77YAQ09CVJ",
      metadata: {
        factoryMail: true,
        senderNodeId: "agent-a",
        senderName: "Reviewer",
        threadId: "01KZSM4A84ASFRTZ77YAQ09CVH",
        subjectNotice: "mention",
        threadSubject: { kind: "task", nodeId: "task-board", taskId: "01KZSM4A84ASFRTZ77YAQ09CVK" },
      },
      parts: [{ kind: "text", text: "Can you take this?" }],
    });
    expect(composeMessageDeliveryPayload(comment, { sender: { kind: "seat", label: "pty-a (Junto)", replyTarget: "agent-a" } })).toBe(
      "mail from pty-a (Junto), id 01KZSM4A84ASFRTZ77YAQ09CVJ, thread 01KZSM4A84ASFRTZ77YAQ09CVH, " +
        "on task 01KZSM4A84ASFRTZ77YAQ09CVK at task-board — reply: junto msg reply " +
        `'{"target":"task-board","inReplyTo":"01KZSM4A84ASFRTZ77YAQ09CVJ","text":"..."}'` +
        "\nCan you take this?",
    );
    const refusal = { ...comment, metadata: { ...comment.metadata, senderName: "Tasks", senderNodeId: "task-board", subjectNotice: "refusal" } };
    expect(composeMessageDeliveryPayload(refusal, { sender: { kind: "notice", label: "Tasks" } }).split("\n")[0]).toBe(
      "mail from Tasks, id 01KZSM4A84ASFRTZ77YAQ09CVJ, thread 01KZSM4A84ASFRTZ77YAQ09CVH, on task 01KZSM4A84ASFRTZ77YAQ09CVK at task-board",
    );
  });

  it("gives a resource's notice and an automation's mail no reply command, outside a subject thread too", () => {
    const refusal = userMsg({
      messageId: "01KZSM4A84ASFRTZ77YAQ09CVM",
      metadata: { factoryMail: true, fromSeat: NOTICE_SEAT_ID, senderNodeId: "task-board", senderName: "Tasks", subjectNotice: "refusal" },
      parts: [{ kind: "text", text: "Refused: the task moved on." }],
    });
    // Off the canvas, a notice is never named by the words its writer stamped.
    expect(composeMessageDeliveryPayload(refusal).split("\n")[0]).toBe("mail from a removed resource, id 01KZSM4A84ASFRTZ77YAQ09CVM");
    const automation = userMsg({
      messageId: "01KZSM4A84ASFRTZ77YAQ09CVN",
      metadata: { factoryMail: true, fromSeat: AUTOMATION_SEAT_ID, senderNodeId: "nightly", senderName: "nightly" },
      parts: [{ kind: "text", text: "Nightly build failed." }],
    });
    expect(composeMessageDeliveryPayload(automation).split("\n")[0]).toBe("mail from nightly, id 01KZSM4A84ASFRTZ77YAQ09CVN");
  });

  it("cuts a notice past the cap, points at the rest, and leaves it unread", () => {
    const head = "y".repeat(MAIL_TYPED_BODY_MAX);
    const long = userMsg({
      messageId: "01KZSM4A84ASFRTZ77YAQ09CVH",
      metadata: { factoryMail: true, senderNodeId: "agent-a", senderName: "Reviewer" },
      parts: [{ kind: "text", text: `${head}TAIL` }],
    });
    const [, body, pointer, ...rest] = composeMessageDeliveryPayload(long).split("\n");
    expect(body).toBe(head);
    expect(pointer).toBe(`(cut at ${String(MAIL_TYPED_BODY_MAX)} characters; the rest: junto msg read 01KZSM4A84ASFRTZ77YAQ09CVH)`);
    expect(rest).toEqual([]);
    expect(mailTypedWhole(long)).toBe(false);
    const exact = userMsg({ ...long, parts: [{ kind: "text", text: head }] });
    expect(composeMessageDeliveryPayload(exact)).not.toContain("junto msg read");
    expect(mailTypedWhole(exact)).toBe(true);
    // Counted in characters, never cut inside one.
    const wide = userMsg({ ...long, parts: [{ kind: "text", text: "😀".repeat(MAIL_TYPED_BODY_MAX) }] });
    expect(mailTypedWhole(wide)).toBe(true);
  });

  it("strips terminal controls from a typed body and keeps its lines", () => {
    const notice = userMsg({
      metadata: { factoryMail: true, senderNodeId: "agent-a", senderName: "Reviewer" },
      parts: [{ kind: "text", text: "line one\r\n\u001b[201~line\u0007 two\ttab" }],
    });
    expect(composeMessageDeliveryPayload(notice).split("\n").slice(1)).toEqual(["line one", "[201~line two\ttab"]);
  });

  it("carries the onboard pointer on the mail line only for a seat that has not onboarded", () => {
    const notice = userMsg({
      messageId: "01KZSM4A84ASFRTZ77YAQ09CVH",
      metadata: { factoryMail: true, senderName: "Reviewer" },
      parts: [{ kind: "text", text: "Please review the contract." }],
    });
    const plain = composeMessageDeliveryPayload(notice);
    expect(plain).not.toContain("junto onboard");
    expect(composeMessageDeliveryPayload(notice, {})).toBe(plain);
    expect(composeMessageDeliveryPayload(notice, { onboarded: true })).toBe(plain);
    const pointed = composeMessageDeliveryPayload(notice, { onboarded: false });
    // On the header line itself: never a separate message.
    expect(pointed).toBe(
      "mail from Reviewer, id 01KZSM4A84ASFRTZ77YAQ09CVH — new to this seat? run `junto onboard` first\nPlease review the contract.",
    );
    // Short ordinary mail takes it too.
    expect(composeMessageDeliveryPayload(userMsg(), { onboarded: false })).toBe(
      `[message - user] ping the lane — ${MAIL_ONBOARD_POINTER}`,
    );
  });

  it("puts the onboard pointer on a prompt's first line and leaves the body alone", () => {
    const prompt = userMsg({
      metadata: { factoryMail: true, mailKind: "prompt", senderName: "Reviewer" },
      parts: [{ kind: "text", text: "Read the patch.\nCheck the failing case." }],
    });
    expect(composeImmediatePromptPayload(prompt, { onboarded: false })).toBe(
      `mail from Reviewer, id m1 — ${MAIL_ONBOARD_POINTER}\nRead the patch.\nCheck the failing case.`,
    );
    expect(composeImmediatePromptPayload(prompt, { onboarded: true })).toBe(
      "mail from Reviewer, id m1\nRead the patch.\nCheck the failing case.",
    );
  });

  it("formats one-line payload with role and optional taskId", () => {
    expect(composeMessageDeliveryPayload(userMsg())).toBe("[message - user] ping the lane");
    expect(
      composeMessageDeliveryPayload(
        userMsg({
          metadata: { sender: "operator" }, // spoof ignored — label is role only
          taskId: "task-9",
        }),
      ),
    ).toBe("[message - user] ping the lane - task task-9");
  });

  it("summarizes a long ordinary body; factory mail drops its old envelope", () => {
    const long = userMsg({ parts: [{ kind: "text", text: "x".repeat(MESSAGE_PTY_FULL_BODY_MAX + 40) }] });
    expect(shouldSummarizeMessageForPty(long)).toBe(true);
    expect(composeMessageDeliveryPayload(long)).toContain("junto msg read m1");
    expect(mailTypedWhole(long)).toBe(false);
    const factory = userMsg({
      messageId: "01KZSM4A84ASFRTZ77YAQ09CVH",
      metadata: { factoryMail: true, fromSeat: "agent-01KZRZK09851NV4407M2499WJM" },
      parts: [
        {
          kind: "text",
          text:
            "[factory mail from agent-01KZRZK09851NV4407M2499WJM] HARNESS-INTEGRATION ANALYSIS\n\n1. WHAT IS SHARED",
        },
      ],
    });
    expect(isFactoryMailMessage(factory)).toBe(true);
    // No node to reply to: no reply command.
    expect(composeMessageDeliveryPayload(factory)).toBe(
      "mail from agent-01KZRZK09851NV4407M2499WJM, id 01KZSM4A84ASFRTZ77YAQ09CVH\nHARNESS-INTEGRATION ANALYSIS\n\n1. WHAT IS SHARED",
    );
  });

  it("marks read at delivery only mail typed whole: a prompt, a notice within the cap, a short ordinary line", () => {
    expect(mailTypedWhole(userMsg())).toBe(true);
    const stamp = { fromSeat: `seat_${"a".repeat(64)}`, senderNodeId: "agent-a", senderName: "Reviewer", senderGeneration: "ep_a", senderHarness: "claude" };
    const prompt = userMsg({
      metadata: { factoryMail: true, mailKind: "prompt", ...stamp },
      parts: [{ kind: "text", text: "z".repeat(MAIL_TYPED_BODY_MAX * 2) }],
    });
    expect(mailTypedWhole(prompt)).toBe(true);
    // The same text as a notice is cut, so it stays unread.
    expect(mailTypedWhole({ ...prompt, metadata: { ...prompt.metadata, mailKind: "notice" } })).toBe(false);
  });

  it("batches multiple unread into one newest-first list line", () => {
    const t0 = 1_700_000_000_000;
    const oldest = ulid(t0);
    const middle = ulid(t0 + 1_000);
    const newest = ulid(t0 + 2_000);
    const extra1 = ulid(t0 + 3_000);
    const extra2 = ulid(t0 + 4_000);
    const batch = composeMessageDeliverySummary([
      userMsg({ messageId: oldest, parts: [{ kind: "text", text: "one" }] }),
      userMsg({
        messageId: middle,
        metadata: { factoryMail: true },
        parts: [{ kind: "text", text: "two essay" }],
      }),
      userMsg({ messageId: newest, parts: [{ kind: "text", text: "three" }] }),
    ]);
    expect(batch).toContain("3 unread");
    expect(batch).not.toContain("factory mail");
    expect(batch).toContain("junto msg list");
    expect(batch.includes("\n")).toBe(false);
    const newestIdx = batch.indexOf(newest.slice(0, 12));
    const middleIdx = batch.indexOf(middle.slice(0, 12));
    const oldestIdx = batch.indexOf(oldest.slice(0, 12));
    expect(newestIdx).toBeGreaterThan(-1);
    expect(middleIdx).toBeGreaterThan(newestIdx);
    expect(oldestIdx).toBeGreaterThan(middleIdx);

    const burst = composeMessageDeliverySummary([
      userMsg({ messageId: oldest, parts: [{ kind: "text", text: "a" }] }),
      userMsg({ messageId: middle, parts: [{ kind: "text", text: "b" }] }),
      userMsg({ messageId: newest, parts: [{ kind: "text", text: "c" }] }),
      userMsg({ messageId: extra1, parts: [{ kind: "text", text: "d" }] }),
      userMsg({ messageId: extra2, parts: [{ kind: "text", text: "e" }] }),
    ]);
    expect(burst).toContain("5 unread");
    expect(burst).toContain("+2");
    expect(burst).toContain(extra2.slice(0, 12));
    expect(burst).not.toContain(oldest.slice(0, 12));
  });

  it("sorts mail newest-first so a lone unread is the latest", () => {
    const t0 = 1_700_000_000_000;
    const older = userMsg({ messageId: ulid(t0), parts: [{ kind: "text", text: "old" }] });
    const latest = userMsg({
      messageId: ulid(t0 + 5_000),
      parts: [{ kind: "text", text: "new ping" }],
    });
    expect(sortMessagesNewestFirst([older, latest]).map((m) => m.messageId)).toEqual([
      latest.messageId,
      older.messageId,
    ]);
    expect(composeMessageDeliverySummary([older, latest])).toContain("2 unread");
    expect(composeMessageDeliveryPayload(latest)).toBe("[message - user] new ping");
  });


  it("sender is role only; brief strips controls and collapses whitespace", () => {
    expect(messageSenderLabel(userMsg({ metadata: { sender: "operator" } }))).toBe("user");
    expect(
      messageBriefText(
        userMsg({
          parts: [
            { kind: "text", text: "  a\n  b  " },
            { kind: "text", text: "c\u001b[31mx" },
          ],
        }),
      ),
    ).toBe("a b c [31mx");
  });

  it("own-echo: agent role is never pending; user role is", () => {
    expect(isForeignMessage(userMsg())).toBe(true);
    expect(isForeignMessage(userMsg({ role: "agent" }))).toBe(false);
    expect(isPendingDelivery(userMsg())).toBe(true);
    expect(isPendingDelivery(userMsg({ role: "agent" }))).toBe(false);
    expect(
      isPendingDelivery(userMsg({ metadata: { deliveredAt: 1_700_000_000_000 } })),
    ).toBe(false);
    expect(
      isPendingDelivery(userMsg({ metadata: { readAt: 1_700_000_000_000 } })),
    ).toBe(false);
  });

  it("resolves the agent seat; a raw terminal and a note are unreachable", () => {
    expect(deliveryTargetOf(seat("agent", { bindingId: "bind-profile-13" as never }))).toEqual({
      bindingId: "bind-profile-13",
    });
    // A raw user terminal holds no inbox, and neither does furniture.
    expect(deliveryTargetOf(terminal("terminal"))).toBeUndefined();
    expect(deliveryTargetOf(note("x"))).toBeUndefined();
  });
});

describe("a batch of mail for one seat", () => {
  const notice = (messageId: string, text: string, sender = "agent-a"): Message =>
    userMsg({
      messageId,
      metadata: { factoryMail: true, fromSeat: "seat_hash", senderNodeId: sender, senderName: sender },
      parts: [{ kind: "text", text }],
    });
  const header = (message: Message): string => composeMessageDeliveryPayload(message).split("\n")[0]!;

  it("types one mail exactly as it is alone, with no count line", () => {
    const only = notice("01A", "one thing");
    const sender = { kind: "seat", label: "cli-lead (Junto / CLI)", replyTarget: "agent-a" } as const;
    expect(composeMailBatch([{ message: only, sender }], { onboarded: false })).toEqual({
      text: composeMessageDeliveryPayload(only, { onboarded: false, sender }),
      whole: [true],
    });
  });

  it("opens more with a count line, then each mail whole under its own header, oldest first", () => {
    const first = notice("01A", "first\nwith a second line");
    const second = notice("01B", "second", "agent-c");
    const batch = composeMailBatch([{ message: first }, { message: second, sender: { kind: "seat", label: "Reviewer (Junto)", replyTarget: "agent-c" } }]);
    expect(batch.text).toBe(
      [
        "2 mails, oldest first",
        composeMessageDeliveryPayload(first),
        composeMessageDeliveryPayload(second, { sender: { kind: "seat", label: "Reviewer (Junto)", replyTarget: "agent-c" } }),
      ].join("\n\n"),
    );
    expect(batch.whole).toEqual([true, true]);
  });

  it("types each mail's files under its own body, one line each, kept to one line", () => {
    const first = notice("01A", "first");
    const second = notice("01B", "second");
    const files = ["Attached: a.png (image/png, 2 KB): /w/a.png", "Attached: b\nc.txt (text/plain, 3 bytes): /w/b c.txt"];
    const batch = composeMailBatch([{ message: first, attachmentLines: files }, { message: second }]);
    const [, one, two] = batch.text.split("\n\n");
    expect(one!.split("\n").slice(1)).toEqual(["first", files[0], "Attached: bc.txt (text/plain, 3 bytes): /w/b c.txt"]);
    expect(two).toBe(composeMessageDeliveryPayload(second));
  });

  it("carries the onboard pointer once, on the count line", () => {
    const batch = composeMailBatch([{ message: notice("01A", "a") }, { message: notice("01B", "b") }], { onboarded: false });
    expect(batch.text.split("\n")[0]).toBe(`2 mails, oldest first — ${MAIL_ONBOARD_POINTER}`);
    expect(batch.text.split(MAIL_ONBOARD_POINTER)).toHaveLength(2);
  });

  it("types bodies whole up to the cap; past it each further mail is one line with its id, unread", () => {
    const body = (fill: string): string => fill.repeat(MAIL_BATCH_BODY_MAX / 3);
    const mails = [notice("01A", body("a")), notice("01B", body("b")), notice("01C", body("c")), notice("01D", "short, but past the cap"), notice("01E", "e")];
    const batch = composeMailBatch(mails.map((message) => ({ message })));
    expect(batch.whole).toEqual([true, true, true, false, false]);
    const sections = batch.text.split("\n\n");
    expect(sections[0]).toBe("5 mails, oldest first; the last 2 are past the 6000-character cap, by id only");
    expect(sections.slice(1, 4)).toEqual(mails.slice(0, 3).map((message) => composeMessageDeliveryPayload(message)));
    expect(sections.slice(4)).toEqual([
      "mail from agent-a, id 01D — junto msg read 01D",
      "mail from agent-a, id 01E — junto msg read 01E",
    ]);
  });

  it("with thousands past the cap, names the first by id and counts the rest on one line that lists them, all unread", () => {
    const ids = Array.from({ length: 3_000 }, (_, index) => `01${String(index).padStart(5, "0")}`);
    // The first three fill the cap exactly.
    const filling = [MAIL_TYPED_BODY_MAX, MAIL_TYPED_BODY_MAX, MAIL_BATCH_BODY_MAX - 2 * MAIL_TYPED_BODY_MAX];
    const mails = ids.map((id, index) => notice(id, index < 3 ? "f".repeat(filling[index]!) : `waiting ${id}`));
    const batch = composeMailBatch(mails.map((message) => ({ message })));
    expect(batch.whole).toEqual(ids.map((_, index) => index < 3));
    const sections = batch.text.split("\n\n");
    const named = ids.slice(3, 3 + MAIL_BATCH_POINTER_MAX);
    const lastNamed = named[named.length - 1]!;
    const counted = ids.length - 3 - MAIL_BATCH_POINTER_MAX;
    expect(sections[0]).toBe(
      `3000 mails, oldest first; the last 2997 are past the 6000-character cap, the first ${String(MAIL_BATCH_POINTER_MAX)} by id and the rest counted`,
    );
    expect(sections.slice(4, -1)).toEqual(named.map((id) => `mail from agent-a, id ${id} — junto msg read ${id}`));
    expect(sections.at(-1)).toBe(`${String(counted)} more mails, unread — junto msg list '{"unread":true,"since":"${lastNamed}"}'`);
    expect(sections).toHaveLength(1 + 3 + MAIL_BATCH_POINTER_MAX + 1);
  });

  it("counts a cut mail at the cut, and keeps it unread", () => {
    // Counted whole, 01A's 3,400 characters would push 01C past the cap.
    const long = notice("01A", "x".repeat(MAIL_TYPED_BODY_MAX + 900));
    const rest = MAIL_BATCH_BODY_MAX - 2 * MAIL_TYPED_BODY_MAX;
    const batch = composeMailBatch([long, notice("01B", "y".repeat(MAIL_TYPED_BODY_MAX)), notice("01C", "z".repeat(rest))].map((message) => ({ message })));
    expect(batch.whole).toEqual([false, true, true]);
    expect(batch.text).toContain(`(cut at ${String(MAIL_TYPED_BODY_MAX)} characters; the rest: junto msg read 01A)`);
    expect(batch.text).not.toContain("by id only");
  });

  it("names the sender of a one-line mail as the canvas does", () => {
    const mails = [notice("01A", "z".repeat(MAIL_TYPED_BODY_MAX)), notice("01B", "w".repeat(MAIL_TYPED_BODY_MAX)), notice("01C", "v".repeat(MAIL_BATCH_BODY_MAX - 2 * MAIL_TYPED_BODY_MAX + 1))];
    const batch = composeMailBatch([{ message: mails[0]! }, { message: mails[1]! }, { message: mails[2]!, sender: { kind: "seat", label: "pty-lead (Junto / PTY)" } }]);
    expect(batch.whole).toEqual([true, true, false]);
    expect(batch.text.endsWith("\n\nmail from pty-lead (Junto / PTY), id 01C — junto msg read 01C")).toBe(true);
    expect(header(mails[0]!)).toBe("mail from agent-a, id 01A — reply: junto msg reply '{\"target\":\"agent-a\",\"inReplyTo\":\"01A\",\"text\":\"...\"}'");
  });
});
