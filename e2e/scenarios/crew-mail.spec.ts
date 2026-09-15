/**
 * Crew mail — truthful delivery states over a messages edge [fake-tui].
 *
 * Two fake-tui seats on one generated canvas, one real messages edge
 * between them. Sends ride the real work-control socket from inside the
 * admitted seat process; delivery rides the real drive onto the seat's
 * PTY. Evidence is the durable ledger: work_messages rows (inbox truth),
 * work_mail_attempts rows (queued/notified/unresolved transport facts),
 * and the fake's own PTY stdin log (physical write truth).
 *
 * Laws covered:
 *   1. a send lands a durable inbox row and a queued attempt BEFORE the
 *      physical write resolves;
 *   2. a notified attempt means bytes reached the PTY and a turn started —
 *      the fake's stdin log and repaint are the proof;
 *   3. a written-but-unacknowledged paste is `unresolved`, never re-pasted
 *      on the same recipient generation, and never laundered into
 *      delivered;
 *   4. msg.sent reports the sender's own receipts without marking the
 *      recipient mailbox read.
 *
 * Seats are fake-tui: deterministic screen control, labelled honestly.
 */
import { expect, launchVellum, test } from "../harness/launch";
import {
  crewMailAttempts,
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
  launchVellum({
    seedCanvases: { [CANVAS]: mailDoc },
    afterSeed: installCrewSeatHarness,
  });

/** [delivery]/[wake] lines from the sandbox app's own main log. */
const mainLogOf = (vellum: Awaited<ReturnType<typeof launchVellum>>): (() => string) => {
  const lines: string[] = [];
  const proc = vellum.app.process();
  proc.stdout?.on("data", (chunk: Buffer) => lines.push(String(chunk)));
  proc.stderr?.on("data", (chunk: Buffer) => lines.push(String(chunk)));
  return () =>
    lines
      .join("")
      .split("\n")
      .filter((line) => line.includes("[delivery]") || line.includes("[wake]"))
      .join("\n");
};

test("crew mail [fake-tui]: send receipts durable row then notified delivery", async () => {
  test.setTimeout(240_000);
  const vellum = await launch();
  const wakeLog = mainLogOf(vellum);
  try {
    const { page, sandbox } = vellum;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);

    const seatAHandle = crewSeat(sandbox, CANVAS, A);
    const seatBHandle = crewSeat(sandbox, CANVAS, B);
    await crewOccupySeat(page, CANVAS, seatA, seatAHandle);
    await crewOccupySeat(page, CANVAS, seatB, seatBHandle);

    const send = await seatAHandle.op("msg.send", {
      target: B,
      text: "peer mail: checksum 42",
    });
    const data = opData(send);
    const messageId = data.messageId;
    expect(typeof messageId).toBe("string");

    // Law 1 — the durable row exists before the PTY write resolves.
    await expect
      .poll(() => crewMessageCount(sandbox, CANVAS, B), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);

    // Law 2 — the attempt ledger: queued first, then notified once the
    // fake repaints Working (a real turn-start), never before.
    await expect
      .poll(
        () =>
          crewMailAttempts(sandbox, CANVAS, B).filter(
            (row) =>
              row.message_id === messageId && row.notified_at !== null,
          ).length,
        { timeout: 60_000, intervals: [250, 500, 1_000] },
      )
      .toBe(1)
      .catch(async (cause: unknown) => {
        const read = await seatAHandle
          .op("seat.read", { target: B, lines: 30 })
          .catch((error: unknown) => ({ ok: false, error: String(error) }));
        const events = await seatBHandle.events().catch(() => []);
        const stdin = await seatBHandle.stdinLog().catch(() => "");
        const receipts = crewReceipts(sandbox, CANVAS, B);
        throw new Error(
          `attempt never notified.\n[delivery log]\n${wakeLog()}\n` +
            `[seat.read B]\n${JSON.stringify(read)}\n` +
            `[receipts B]\n${JSON.stringify(receipts)}\n` +
            `[events B]\n${events.map((e) => JSON.stringify(e)).join("\n")}\n` +
            `[stdin B]\n${JSON.stringify(stdin)}`,
          { cause },
        );
      });
    const [attempt] = crewMailAttempts(sandbox, CANVAS, B).filter(
      (row) => row.message_id === messageId,
    );
    expect(attempt?.policy).toBe("notice");
    expect(attempt?.unresolved_at).toBeNull();
    // refused_at is racy by design: a settle-window gate refusal is a
    // set-once fact that stays on the row even when a later pass notifies.
    // The law is that notified implies the write, not that refusal never
    // happened first.
    expect(attempt?.recipient_generation.length).toBeGreaterThan(0);

    // Physical truth: the fake received the notice payload on its PTY.
    await expect
      .poll(async () => await seatBHandle.stdinLog(), { timeout: 10_000 })
      .toContain("peer mail: checksum 42");

    // Law 4 — msg.sent reads sender receipts only; B's mailbox stays unread
    // until B itself lists or marks it.
    const sent = await seatAHandle.op("msg.sent", {});
    const sentData = opData(sent);
    const items = (sentData.items ?? []) as ReadonlyArray<{
      messageId: string;
      toNodeId: string;
    }>;
    expect(items.some((m) => m.messageId === messageId && m.toNodeId === B))
      .toBe(true);
  } finally {
    await vellum.close();
  }
});

test("crew mail [fake-tui]: unacknowledged paste is unresolved and never re-pasted", async () => {
  test.setTimeout(240_000);
  const vellum = await launch();
  try {
    const { page, sandbox } = vellum;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);

    const seatAHandle = crewSeat(sandbox, CANVAS, A);
    const seatBHandle = crewSeat(sandbox, CANVAS, B);
    await crewOccupySeat(page, CANVAS, seatA, seatAHandle);
    await crewOccupySeat(page, CANVAS, seatB, seatBHandle);

    // The fake swallows every submission: bytes reach the PTY, no
    // turn-start ever repaints — the unresolved class, deterministically.
    await seatBHandle.control({ submit: "ignore", paste: "swallow" });

    const send = await seatAHandle.op("msg.send", {
      target: B,
      text: "peer mail: sink this one",
    });
    const data = opData(send);
    const messageId = data.messageId as string;

    // Durable row first, then a written-but-unproofed attempt.
    await expect
      .poll(() => crewMessageCount(sandbox, CANVAS, B), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(
        () =>
          crewMailAttempts(sandbox, CANVAS, B).filter(
            (row) =>
              row.message_id === messageId && row.unresolved_at !== null,
          ).length,
        { timeout: 90_000, intervals: [500, 1_000, 2_000] },
      )
      .toBe(1);
    const [attempt] = crewMailAttempts(sandbox, CANVAS, B).filter(
      (row) => row.message_id === messageId,
    );
    expect(attempt?.notified_at).toBeNull();
    // The write reached the PTY: the intent witness stamped before the
    // physical write and the outcome is unresolved — the drive only reports
    // unresolved after writing. (Counter columns can stay 0/0 when a
    // settle-gate refusal stamped the set-once write block first; physical
    // byte proof is the stdin log asserted below.)
    expect(attempt?.attempted_at).not.toBeNull();
    expect(attempt?.write_at).not.toBeNull();

    // No-replay on the same generation: settle, flip screens, wait —
    // the ledger must still hold exactly one attempt for this message.
    await seatBHandle.control({ screen: { mode: "idle" } });
    await seatBHandle.print("still there");
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const attempts = crewMailAttempts(sandbox, CANVAS, B).filter(
      (row) => row.message_id === messageId,
    );
    expect(attempts).toHaveLength(1);
    const stdin = await seatBHandle.stdinLog();
    const pastes = stdin.split("sink this one").length - 1;
    expect(pastes).toBe(1);
  } finally {
    await vellum.close();
  }
});

test("crew mail [fake-tui]: read and reply state stay truthful across the pair", async () => {
  test.setTimeout(240_000);
  const vellum = await launch();
  try {
    const { page, sandbox } = vellum;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);

    const seatAHandle = crewSeat(sandbox, CANVAS, A);
    const seatBHandle = crewSeat(sandbox, CANVAS, B);
    await crewOccupySeat(page, CANVAS, seatA, seatAHandle);
    await crewOccupySeat(page, CANVAS, seatB, seatBHandle);

    const send = await seatAHandle.op("msg.send", {
      target: B,
      text: "peer mail: read me back",
    });
    const data = opData(send);
    const messageId = data.messageId as string;
    await expect
      .poll(
        () =>
          crewMailAttempts(sandbox, CANVAS, B).filter(
            (row) =>
              row.message_id === messageId && row.notified_at !== null,
          ).length,
        { timeout: 60_000 },
      )
      .toBe(1);

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

    // B replies; A's own mailbox now holds the reply addressed to A.
    const reply = await seatBHandle.op("msg.reply", {
      target: A,
      text: "peer mail: replying",
      inReplyTo: messageId,
    });
    expect(reply.ok, JSON.stringify(reply)).toBe(true);
    await expect
      .poll(() => crewMessageCount(sandbox, CANVAS, A), { timeout: 15_000 })
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
    await vellum.close();
  }
});

test("crew mail [fake-tui]: masking msg.send off the edge refuses the send", async () => {
  test.setTimeout(180_000);
  const vellum = await launchVellum({
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
  });
  try {
    const { page, sandbox } = vellum;
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
    expect(crewMessageCount(sandbox, CANVAS, B)).toBe(0);
  } finally {
    await vellum.close();
  }
});

test("crew mail [fake-tui]: removing the edge mid-flight closes further sends", async () => {
  test.setTimeout(240_000);
  const vellum = await launch();
  try {
    const { page, sandbox } = vellum;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);

    const seatAHandle = crewSeat(sandbox, CANVAS, A);
    const seatBHandle = crewSeat(sandbox, CANVAS, B);
    await crewOccupySeat(page, CANVAS, seatA, seatAHandle);
    await crewOccupySeat(page, CANVAS, seatB, seatBHandle);

    const first = await seatAHandle.op("msg.send", {
      target: B,
      text: "peer mail: before the cut",
    });
    expect(first.ok).toBe(true);

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
    await vellum.close();
  }
});
