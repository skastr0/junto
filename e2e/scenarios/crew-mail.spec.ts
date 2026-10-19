import { commandModel } from "../harness/model";
import { modelFixture, modelMessagesWire, modelSeat } from "../harness/model";
import { readSeatMailbox } from "../harness/work-mail";
/**
 * Mail — every message typed into the recipient seat at once, over a
 * messages edge [fake-tui].
 *
 * Two fake-tui seats on one generated canvas, one real messages edge
 * between them. Sends ride the real work-control socket from inside the
 * admitted seat process; delivery rides the real drive onto the seat's
 * PTY. msg.send types the notice whole under one header,
 * `mail from <sender>, id <id> — reply: junto msg reply '...'`, marks it
 * read, and answers { messageId, delivery }: "delivered" once it is on the seat,
 * "waiting" when the seat is not up yet. Evidence comes from the op's
 * `delivery` field, the app's projected mailbox and `deliveredAt` receipt,
 * and the fake's own stdin log (one bracketed paste of the exact payload).
 *
 * Laws covered:
 *   1. a sent message is delivered at once: the op answers delivered, the
 *      projected receipt carries deliveredAt, and the seat's input took
 *      exactly one paste of the notice payload;
 *   2. msg.sent reports the sender's own receipts without marking the
 *      recipient mailbox read; read and reply state stay truthful across
 *      the pair;
 *   3. the edge grant is authorization: masking msg.send off the edge
 *      refuses the send with ScopeError, and removing the edge closes
 *      further sends.
 *
 * Seats are fake-tui: deterministic screen control, labelled honestly.
 */
import type { Page } from "@playwright/test";
import type { Message } from "../../src/shared/work-model";
import { readMailExtension } from "../../src/shared/crew";
import { composeMailBatch, composeMessageDeliveryPayload, MAIL_ONBOARD_POINTER } from "../../src/shared/message-delivery";
import { expect, launchJunto, test } from "../harness/launch";
import { crewMessageCount, crewReceipts, crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness, type CrewSeat, type WorkEnvelope } from "../harness/crew-fixture";

const CANVAS = "crew-mail";
const A = "seat-a";
const B = "seat-b";

const seatA = modelSeat({ id: A, x: 40, y: 40 });
const seatB = modelSeat({ id: B, x: 360, y: 40 });
const mailDoc = modelFixture(
  [seatA, seatB],
  [modelMessagesWire("e-ab", A, B, [seatA, seatB])],
);

const opData = (env: WorkEnvelope): Record<string, unknown> => {
  expect(env.ok, JSON.stringify(env)).toBe(true);
  if (!env.ok) throw new Error("unreachable");
  return (env.data ?? {}) as Record<string, unknown>;
};

const launch = () =>
  launchJunto({
    seedModels: { [CANVAS]: mailDoc },
    afterSeed: installCrewSeatHarness,
    extraEnv: { JUNTO_PTY_TRACE: "1" },
  });

/** [delivery] lines from the sandbox app's own main log. */
const mainLogOf = (junto: Awaited<ReturnType<typeof launchJunto>>): (() => string) => {
  const lines: string[] = [];
  const proc = junto.app.process();
  proc.stdout?.on("data", (chunk: Buffer) => lines.push(String(chunk)));
  proc.stderr?.on("data", (chunk: Buffer) => lines.push(String(chunk)));
  return () =>
    lines
      .join("")
      .split("\n")
      .filter((line) => line.includes("[delivery]"))
      .join("\n");
};

/** B's live seat state, as A reads it over the edge. */
const seatStateOf = async (from: CrewSeat): Promise<string> => {
  const read = await from.op("seat.read", { target: B, lines: 10 });
  if (!read.ok) return "unreadable";
  const state = (read.data as { state?: unknown } | undefined)?.state;
  return typeof state === "string" ? state : "unknown";
};

/** The stored message as the app projects it on B's mailbox. */
const projectedMessage = async (page: Page, messageId: string): Promise<Message> => {
  const message = (await readSeatMailbox(page, CANVAS, B)).find((item) => item.messageId === messageId);
  if (message === undefined) throw new Error(`Missing projected message ${messageId}`);
  return message;
};

/** Bracketed pastes of exactly this payload in the seat's raw PTY input. */
const pastesOf = (stdin: string, payload: string): number =>
  stdin.split(`\x1b[200~${payload}\x1b[201~`).length - 1;

const deliveredAtOf = async (page: Page, messageId: string): Promise<number | undefined> =>
  (await crewReceipts(page, CANVAS, B)).find((row) => row.messageId === messageId)
    ?.deliveredAt;

/** Occupy both seats and wait until B's seat reads idle. */
const boot = async (junto: Awaited<ReturnType<typeof launch>>) => {
  const { page, sandbox } = junto;
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await crewPlayFactory(page);
  const seatAHandle = crewSeat(sandbox, CANVAS, A);
  const seatBHandle = crewSeat(sandbox, CANVAS, B);
  await crewOccupySeat(page, CANVAS, seatA, seatAHandle);
  await crewOccupySeat(page, CANVAS, seatB, seatBHandle);
  await expect
    .poll(() => seatStateOf(seatAHandle), { timeout: 30_000 })
    .toBe("idle");
  return { page, sandbox, seatAHandle, seatBHandle };
};

test("mail [fake-tui]: sent mail is delivered at once with one PTY paste", async () => {
  test.setTimeout(240_000);
  const junto = await launch();
  const deliveryLog = mainLogOf(junto);
  try {
    const { page, seatAHandle, seatBHandle } = await boot(junto);

    const send = await seatAHandle.op("msg.send", {
      target: B,
      text: "peer mail: checksum 42",
    });
    const data = opData(send);
    const messageId = data.messageId as string;
    expect(typeof messageId).toBe("string");
    expect(data.delivery).toBe("delivered");

    await expect
      .poll(() => crewMessageCount(page, CANVAS, B), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);

    // The receipt is the delivery fact, read through the app.
    await expect
      .poll(() => deliveredAtOf(page, messageId), {
        timeout: 60_000,
        intervals: [250, 500, 1_000],
      })
      .toBeDefined()
      .catch(async (cause: unknown) => {
        const sources = ["seat.read B", "events B", "stdin B", "receipts B"];
        const evidence = await Promise.allSettled([
          seatAHandle.op("seat.read", { target: B, lines: 30 }),
          seatBHandle.events(),
          seatBHandle.stdinLog(),
          crewReceipts(page, CANVAS, B),
        ]);
        const diagnostics = evidence.map((result, index) => ({
          source: sources[index],
          ...(result.status === "fulfilled"
            ? { status: result.status, value: result.value }
            : { status: result.status, error: String(result.reason) }),
        }));
        throw new Error(
          `message never delivered.\n[delivery log]\n${deliveryLog()}\n` +
            `[diagnostics]\n${JSON.stringify(diagnostics, null, 2)}`,
          { cause },
        );
      });

    // The notice, whole under one header: sender, id, the reply that answers
    // it, and, because seat B has never run `junto onboard`, the pointer to that.
    const message = await projectedMessage(page, messageId);
    expect(readMailExtension(message.metadata)?.mailKind).toBe("notice");
    const payload = composeMessageDeliveryPayload(message, { onboarded: false });
    expect(payload).toBe(
      `mail from ${A}, id ${messageId} — reply: junto msg reply '${JSON.stringify({ target: A, inReplyTo: messageId, text: "..." })}' — ${MAIL_ONBOARD_POINTER}\npeer mail: checksum 42`,
    );

    // Physical truth: the fake's input took exactly one paste of that line.
    // B has never run `junto onboard`, so its mail carries the pointer.
    const typed = composeMessageDeliveryPayload(message, { onboarded: false });
    await expect
      .poll(async () => pastesOf(await seatBHandle.stdinLog(), typed), {
        timeout: 10_000,
      })
      .toBe(1);

    // Typed whole, so B has read it: the read receipt lands with the delivery.
    const beforeSent = (await crewReceipts(page, CANVAS, B)).find((row) => row.messageId === messageId);
    expect(beforeSent?.deliveredAt).toBeDefined();
    expect(beforeSent?.readAt).toBeDefined();
    const sent = await seatAHandle.op("msg.sent", {});
    const sentData = opData(sent);
    const items = (sentData.items ?? []) as ReadonlyArray<{
      messageId: string;
      toNodeId: string;
    }>;
    expect(items.some((m) => m.messageId === messageId && m.toNodeId === B))
      .toBe(true);
    // msg.sent reads sender receipts only; it changes none of them.
    const afterSent = (await crewReceipts(page, CANVAS, B)).find((row) => row.messageId === messageId);
    expect(afterSent).toBeDefined();
    expect(afterSent?.readAt).toBe(beforeSent?.readAt);
  } finally {
    await junto.close();
  }
});

test("crew mail [fake-tui]: mail sent together is typed as one turn, never one each", async () => {
  test.setTimeout(240_000);
  const junto = await launch();
  try {
    const { page, seatAHandle, seatBHandle } = await boot(junto);

    // Five sends at once, each its own op on A's socket, well inside the 2 s quiet.
    const texts = ["one", "two", "three", "four", "five"].map((word) => `peer mail: burst ${word}`);
    const sends = await Promise.all(texts.map((text) => seatAHandle.op("msg.send", { target: B, text })));
    expect(sends.map((send) => opData(send).delivery), JSON.stringify(sends)).toEqual(texts.map(() => "delivered"));
    const ids = sends.map((send) => opData(send).messageId as string).sort();

    // One paste: a count line, then each mail under its own header, oldest first.
    const messages = await Promise.all(ids.map((id) => projectedMessage(page, id)));
    const turn = composeMailBatch(messages.map((message) => ({ message })), { onboarded: false }).text;
    expect(turn.startsWith(`5 mails, oldest first — ${MAIL_ONBOARD_POINTER}\n\nmail from ${A}, id ${ids[0]!}`)).toBe(true);
    await expect.poll(async () => pastesOf(await seatBHandle.stdinLog(), turn), { timeout: 10_000 }).toBe(1);
    // No other paste carries any of them (the seat's onboard nudge is its own paste).
    const pastes = [...(await seatBHandle.stdinLog()).matchAll(/\x1b\[200~([^]*?)\x1b\[201~/gu)].map((match) => match[1]!);
    expect(pastes.filter((paste) => paste.includes("peer mail: burst")), JSON.stringify(pastes)).toEqual([turn]);

    // Typed whole, so each is delivered and read.
    const receipts = (await crewReceipts(page, CANVAS, B)).filter((row) => ids.includes(row.messageId));
    expect(receipts).toHaveLength(5);
    expect(receipts.every((row) => row.deliveredAt !== undefined && row.readAt !== undefined)).toBe(true);
  } finally {
    await junto.close();
  }
});

test("crew mail [fake-tui]: read and reply state stay truthful across the pair", async () => {
  test.setTimeout(240_000);
  const junto = await launch();
  try {
    const { page, seatAHandle, seatBHandle } = await boot(junto);

    const send = await seatAHandle.op("msg.send", {
      target: B,
      text: "peer mail: read me back",
    });
    const data = opData(send);
    const messageId = data.messageId as string;
    expect(data.delivery).toBe("delivered");
    await expect
      .poll(() => deliveredAtOf(page, messageId), { timeout: 60_000 })
      .toBeDefined();

    // B lists its own mailbox — the peer mail is there, addressed to B.
    const list = await seatBHandle.op("msg.list", {});
    const listData = opData(list);
    const listed = (listData.items ?? []) as ReadonlyArray<{
      messageId: string;
      metadata?: { fromSeat?: string; senderName?: string };
    }>;
    const found = listed.find((m) => m.messageId === messageId);
    expect(found).toBeDefined();
    // Server-stamped sender identity: the admitted process, not a client claim.
    expect(found?.metadata?.fromSeat).toBeTruthy();

    // Typed whole, it was read at delivery; B's own read keeps that receipt,
    // and the sender's msg.sent reports it.
    const read = await seatBHandle.op("msg.read", { messageId });
    expect(read.ok).toBe(true);
    const sent = await seatAHandle.op("msg.sent", { target: B });
    const sentData = opData(sent);
    const sentItems = (sentData.items ?? []) as ReadonlyArray<{
      messageId: string;
      metadata?: { readAt?: number; fromSeat?: string };
    }>;
    const sentMsg = sentItems.find((m) => m.messageId === messageId);
    expect(sentMsg?.metadata?.readAt).toBeTruthy();
    const receipt = (await crewReceipts(page, CANVAS, B)).find((row) => row.messageId === messageId);
    expect(receipt?.readAt).toBe(sentMsg?.metadata?.readAt);

    // B replies; A's own mailbox now holds the reply addressed to A.
    const reply = await seatBHandle.op("msg.reply", {
      target: A,
      text: "peer mail: replying",
      inReplyTo: messageId,
    });
    expect(reply.ok, JSON.stringify(reply)).toBe(true);
    await expect
      .poll(() => crewMessageCount(page, CANVAS, A), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);
    const aList = await seatAHandle.op("msg.list", {});
    const aItems = (opData(aList).items ?? []) as ReadonlyArray<{
      messageId: string;
      parts: ReadonlyArray<{ kind: string; text?: string }>;
    }>;
    const replyMsg = aItems.find((m) =>
      m.parts.some(
        (p) => p.kind === "text" && p.text?.includes("replying"),
      ),
    );
    expect(replyMsg).toBeDefined();
  } finally {
    await junto.close();
  }
});

test("crew mail [fake-tui]: masking msg.send off the edge refuses the send", async () => {
  test.setTimeout(180_000);
  const junto = await launchJunto({
    seedModels: {
      [CANVAS]: modelFixture(
        [seatA, seatB],
        // Observe stays granted; the send port is masked off.
        [
          modelMessagesWire("e-ab", A, B, [seatA, seatB], [
            "msg.list",
            "terminal.read",
          ]),
        ],
      ),
    },
    afterSeed: installCrewSeatHarness,
    extraEnv: { JUNTO_PTY_TRACE: "1" },
  });
  try {
    const { page, sandbox } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);

    const seatAHandle = crewSeat(sandbox, CANVAS, A);
    const seatBHandle = crewSeat(sandbox, CANVAS, B);
    await crewOccupySeat(page, CANVAS, seatA, seatAHandle);
    await crewOccupySeat(page, CANVAS, seatB, seatBHandle);

    const send = await seatAHandle.op("msg.send", {
      target: B,
      text: "peer mail: should never land",
    });
    expect(send.ok).toBe(false);
    if (send.ok) return;
    expect(send.error.type).toBe("ScopeError");
    // And nothing reached the durable mailbox.
    expect(await crewMessageCount(page, CANVAS, B)).toBe(0);
  } finally {
    await junto.close();
  }
});

test("crew mail [fake-tui]: removing the edge mid-flight closes further sends", async () => {
  test.setTimeout(240_000);
  const junto = await launch();
  try {
    const { page, seatAHandle } = await boot(junto);

    const first = await seatAHandle.op("msg.send", {
      target: B,
      text: "peer mail: before the cut",
    });
    expect(opData(first).delivery).toBe("delivered");

    // Operator removes the edge through the real authoring path.
    await commandModel(page, { _tag: "Remove", canvas: CANVAS, nodes: [], wires: ["e-ab"] });

    const second = await seatAHandle.op("msg.send", {
      target: B,
      text: "peer mail: after the cut",
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.type).toBe("ScopeError");
  } finally {
    await junto.close();
  }
});
