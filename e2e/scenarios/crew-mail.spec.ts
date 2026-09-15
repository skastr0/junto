/**
 * Crew mail — truthful delivery states over a messages edge [fake-tui].
 *
 * Two fake-tui seats on one generated canvas, one real messages edge
 * between them. Sends ride the real work-control socket from inside the
 * admitted seat process; delivery rides the real drive onto the seat's
 * PTY. Evidence comes from the app's projected mailbox and current-generation
 * transport facts, correlated successful paste writes in the PTY trace, and
 * the fake's own stdin log for the received payload.
 *
 * Laws covered:
 *   1. after a send, the projected inbox contains the message and its
 *      queued/notified timestamps;
 *   2. a notified message has one correlated successful PTY paste and
 *      the fake receives the notice payload;
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
  crewMessagePasteWrites,
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
    extraEnv: { VELLUM_COMMAND_PTY_TRACE: "1" },
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

test("crew mail [fake-tui]: sent mail projects notified delivery with one PTY paste", async () => {
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
    const messageId = data.messageId as string;
    expect(typeof messageId).toBe("string");

    // The live projection contains the sent message; this after-send read
    // makes no claim about ordering relative to the physical paste.
    await expect
      .poll(() => crewMessageCount(page, CANVAS, B), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);

    // Current-generation transport facts are read through the app.
    await expect
      .poll(
        async () =>
          (await crewMailAttempts(page, CANVAS, B)).filter(
            (row) =>
              row.messageId === messageId && row.notifiedAt !== undefined,
          ).length,
        { timeout: 60_000, intervals: [250, 500, 1_000] },
      )
      .toBe(1)
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
          `attempt never notified.\n[delivery log]\n${wakeLog()}\n` +
            `[diagnostics]\n${JSON.stringify(diagnostics, null, 2)}`,
          { cause },
        );
      });
    const [attempt] = (await crewMailAttempts(page, CANVAS, B)).filter(
      (row) => row.messageId === messageId,
    );
    expect(attempt?.mailKind).toBe("notice");
    expect(attempt?.queuedAt).toBeDefined();
    expect(attempt?.unresolvedAt).toBeUndefined();
    expect(attempt?.generation).toBeTruthy();
    await expect.poll(
      () => crewMessagePasteWrites(page, sandbox, CANVAS, B, messageId),
      { timeout: 15_000 },
    ).toBe(1);

    // Physical truth: the fake received the notice payload on its PTY.
    await expect
      .poll(async () => await seatBHandle.stdinLog(), { timeout: 10_000 })
      .toContain("peer mail: checksum 42");

    // Law 4 — msg.sent reads sender receipts only; B's mailbox stays unread
    // until B itself lists or marks it.
    await expect.poll(
      async () => (await crewReceipts(page, CANVAS, B))
        .find((row) => row.messageId === messageId)?.deliveredAt,
      { timeout: 15_000 },
    ).toBeDefined();
    const beforeSent = (await crewReceipts(page, CANVAS, B)).find((row) => row.messageId === messageId);
    expect(beforeSent).toBeDefined();
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
    await vellum.close();
  }
});

test("crew mail [fake-tui]: unacknowledged paste is unresolved and never re-pasted", async () => {
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

    // The fake swallows every submission: bytes reach the PTY, no
    // turn-start ever repaints — the unresolved class, deterministically.
    await seatBHandle.control({ submit: "ignore", paste: "swallow" });

    const send = await seatAHandle.op("msg.send", {
      target: B,
      text: "peer mail: sink this one",
    });
    const data = opData(send);
    const messageId = data.messageId as string;

    // Observe the inbox and unresolved outcome through the live projection.
    await expect
      .poll(() => crewMessageCount(page, CANVAS, B), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(
        async () =>
          (await crewMailAttempts(page, CANVAS, B)).filter(
            (row) =>
              row.messageId === messageId && row.unresolvedAt !== undefined,
          ).length,
        { timeout: 90_000, intervals: [500, 1_000, 2_000] },
      )
      .toBe(1)
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
          `attempt never stamped unresolved.\n[delivery log]\n${wakeLog()}\n` +
            `[diagnostics]\n${JSON.stringify(diagnostics, null, 2)}`,
          { cause },
        );
      });
    const [attempt] = (await crewMailAttempts(page, CANVAS, B)).filter(
      (row) => row.messageId === messageId,
    );
    expect(attempt?.mailKind).toBe("notice");
    expect(attempt?.notifiedAt).toBeUndefined();
    expect(attempt?.attemptedAt).toBeDefined();
    expect(attempt?.generation).toBeTruthy();
    await expect.poll(
      () => crewMessagePasteWrites(page, sandbox, CANVAS, B, messageId),
      { timeout: 15_000 },
    ).toBe(1);

    // Redraw and wait on the same generation. The projection identifies
    // that generation; the trace counts physical pastes across the interval.
    await seatBHandle.control({ screen: { mode: "idle" } });
    await seatBHandle.print("still there");
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const current = (await crewMailAttempts(page, CANVAS, B)).find(
      (row) => row.messageId === messageId,
    );
    expect(current?.generation).toBe(attempt!.generation);
    expect(current?.unresolvedAt).toBe(attempt!.unresolvedAt);
    expect(current?.notifiedAt).toBeUndefined();
    await expect.poll(
      () => crewMessagePasteWrites(page, sandbox, CANVAS, B, messageId),
      { timeout: 15_000 },
    ).toBe(1);
    const stdin = await seatBHandle.stdinLog();
    expect(stdin).toContain("sink this one");
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
        async () =>
          (await crewMailAttempts(page, CANVAS, B)).filter(
            (row) =>
              row.messageId === messageId && row.notifiedAt !== undefined,
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
    extraEnv: { VELLUM_COMMAND_PTY_TRACE: "1" },
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
    expect(await crewMessageCount(page, CANVAS, B)).toBe(0);
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
