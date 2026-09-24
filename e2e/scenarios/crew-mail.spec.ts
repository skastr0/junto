/**
 * Mail — every message typed into the recipient seat at once, over a
 * messages edge [fake-tui].
 *
 * Two fake-tui seats on one generated canvas, one real messages edge
 * between them. Sends ride the real work-control socket from inside the
 * admitted seat process; delivery rides the real drive onto the seat's
 * PTY. msg.send types one short notice line,
 * `mail from <sender> — <preview> — junto msg read <id>`, and answers
 * { messageId, delivery }: "delivered" once the line is on the seat,
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
import type { Message } from "../../src/shared/canvas";
import { readMailExtension } from "../../src/shared/crew";
import { composeMessageDeliveryPayload } from "../../src/shared/message-delivery";
import { expect, launchJunto, test } from "../harness/launch";
import {
  crewMessageCount,
  crewReceipts,
  crewMutateCanvas,
  crewOccupySeat,
  crewPlayFactory,
  crewSeat,
  crewSeatNode,
  crewDoc,
  crewMessagesEdge,
  installCrewSeatHarness,
  type CrewSeat,
  type WorkEnvelope,
} from "../harness/crew-fixture";

const CANVAS = "crew-mail";
const A = "seat-a";
const B = "seat-b";

const seatA = crewSeatNode({ id: A, x: 40, y: 40 });
const seatB = crewSeatNode({ id: B, x: 360, y: 40 });
const mailDoc = crewDoc(
  [seatA, seatB],
  [crewMessagesEdge("e-ab", A, B, [seatA, seatB])],
);

const opData = (env: WorkEnvelope): Record<string, unknown> => {
  expect(env.ok, JSON.stringify(env)).toBe(true);
  if (!env.ok) throw new Error("unreachable");
  return (env.data ?? {}) as Record<string, unknown>;
};

const launch = () =>
  launchJunto({
    seedCanvases: { [CANVAS]: mailDoc },
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
  const doc = await page.evaluate(
    async (name) => (await window.junto!.readCanvas(name)).doc,
    CANVAS,
  );
  const message = doc.nodes
    .find((node) => node.id === B)
    ?.ether?.messages?.items.find((item) => item.messageId === messageId);
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

    // The notice line: sender, preview, and the pointer to the full body.
    const message = await projectedMessage(page, messageId);
    expect(readMailExtension(message.metadata)?.mailKind).toBe("notice");
    const payload = composeMessageDeliveryPayload(message);
    expect(payload.startsWith(`mail from ${A}`)).toBe(true);
    expect(payload).toContain("peer mail: checksum 42");
    expect(payload.endsWith(`junto msg read ${messageId}`)).toBe(true);

    // Physical truth: the fake's input took exactly one paste of that line.
    await expect
      .poll(async () => pastesOf(await seatBHandle.stdinLog(), payload), {
        timeout: 10_000,
      })
      .toBe(1);

    // msg.sent reads sender receipts only; B's mailbox stays unread until
    // B itself lists or marks it.
    const beforeSent = (await crewReceipts(page, CANVAS, B)).find((row) => row.messageId === messageId);
    expect(beforeSent?.deliveredAt).toBeDefined();
    expect(beforeSent?.readAt).toBeUndefined();
    const sent = await seatAHandle.op("msg.sent", {});
    const sentData = opData(sent);
    const items = (sentData.items ?? []) as ReadonlyArray<{
      messageId: string;
      toNodeId: string;
    }>;
    expect(items.some((m) => m.messageId === messageId && m.toNodeId === B))
      .toBe(true);
    const afterSent = (await crewReceipts(page, CANVAS, B)).find((row) => row.messageId === messageId);
    expect(afterSent).toBeDefined();
    expect(afterSent?.readAt).toBeUndefined();
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

    // B marks it read; the sender's msg.sent then reports the read receipt.
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
    seedCanvases: {
      [CANVAS]: crewDoc(
        [seatA, seatB],
        // Observe stays granted; the send port is masked off.
        [
          crewMessagesEdge("e-ab", A, B, [seatA, seatB], [
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
    await crewMutateCanvas(page, CANVAS, (doc) => ({
      ...doc,
      edges: doc.edges.filter((edge) => edge.id !== "e-ab"),
    }));

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
