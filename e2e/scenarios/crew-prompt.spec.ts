/**
 * Crew prompts — immediate full-body delivery over a messages edge
 * [fake-tui].
 *
 * msg.prompt stores a prompt and requests immediate delivery through the
 * managed drive. Evidence uses the app's projected current-generation
 * timestamps, correlated successful paste writes in the PTY trace, and
 * the fake's stdin log for the received payload. The fake-tui seats give
 * deterministic control over the admission classes the drive
 * distinguishes: idle+empty composer (notified), working seat
 * (retryable SeatBusy), drafted composer (retryable SeatBusy), oversize
 * body (InputError, never typed), and written-but-unacknowledged
 * (unresolved — never re-pasted on the same generation).
 *
 * Laws covered:
 *   1. an idle empty seat takes the full body — the PTY shows
 *      "mail from <seat>" + the body, never a msg-read pointer;
 *   2. busy/drafted/settling seats refuse retryable SeatBusy — the
 *      durable messageId survives the refusal and the SAME row retries;
 *   3. fallback:"notice" retains the same durable row and delivers the
 *      ordinary notice form (summary + msg-read pointer), not the body;
 *   4. a paste without turn-start evidence is unresolved — the generation
 *      stays unchanged and the trace still counts one paste after redraw;
 *   5. a prompt retry must name this seat's own prompt for this
 *      recipient — anything else is ScopeError;
 *   6. an immediate body past the limit refuses InputError before any
 *      byte reaches the PTY.
 *
 * Seats are fake-tui: deterministic screen control, labelled honestly.
 */
import { expect, launchJunto, test } from "../harness/launch";
import {
  crewMailAttempts,
  crewMessagePasteWrites,
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

const CANVAS = "crew-prompt";
const A = "seat-a";
const B = "seat-b";

const seatA = crewSeatNode({ id: A, x: 40, y: 40 });
const seatB = crewSeatNode({ id: B, x: 360, y: 40 });
const promptDoc = crewDoc(
  [seatA, seatB],
  [crewMessagesEdge("e-ab", A, B, [seatA, seatB])],
);

const opData = (env: WorkEnvelope): Record<string, unknown> => {
  expect(env.ok, JSON.stringify(env)).toBe(true);
  if (!env.ok) throw new Error("unreachable");
  return (env.data ?? {}) as Record<string, unknown>;
};

const attemptRows = async (
  page: Parameters<typeof crewMailAttempts>[0],
  messageId: string,
) =>
  (await crewMailAttempts(page, CANVAS, B)).filter(
    (r) => r.messageId === messageId,
  );

const launch = () =>
  launchJunto({
    seedCanvases: { [CANVAS]: promptDoc },
    afterSeed: installCrewSeatHarness,
    extraEnv: { JUNTO_PTY_TRACE: "1" },
  });

const boot = async (junto: Awaited<ReturnType<typeof launch>>) => {
  const { page, sandbox } = junto;
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await crewPlayFactory(page);
  const a = crewSeat(sandbox, CANVAS, A);
  const b = crewSeat(sandbox, CANVAS, B);
  await crewOccupySeat(page, CANVAS, seatA, a);
  await crewOccupySeat(page, CANVAS, seatB, b);
  return { page, sandbox, a, b };
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retryable gate-refusal reasons under the SeatBusy type. Every gate
 * refusal reports retryable:true, so the reason is the discriminator:
 * these mean "the seat is not settled/ready yet" — keep retrying the
 * SAME messageId. composer-not-empty and over-limit are terminal for a
 * given attempt and must surface to the caller.
 */
const SETTLING_REASONS = new Set([
  "seat-busy",
  "not-ready",
  "unavailable",
  "paused",
]);

const isSettlingRefusal = (
  env: WorkEnvelope,
): env is Extract<WorkEnvelope, { readonly ok: false }> =>
  !env.ok &&
  env.error.type === "SeatBusy" &&
  typeof env.error.details?.reason === "string" &&
  SETTLING_REASONS.has(env.error.details.reason as string);

/**
 * Retry a durable prompt row until the drive resolves it. SeatBusy with a
 * settling reason retries the SAME messageId; ok envelopes (notified or
 * unresolved) and non-settling errors surface to the caller.
 */
const retryPrompt = async (
  seat: CrewSeat,
  target: string,
  messageId: string,
  extra?: { readonly fallback?: "notice" },
): Promise<WorkEnvelope> => {
  const deadline = Date.now() + 60_000;
  let last: WorkEnvelope | undefined;
  while (Date.now() < deadline) {
    last = await seat.op(
      "msg.prompt",
      { target, messageId, ...extra },
      { timeoutMs: 60_000 },
    );
    if (last.ok) return last;
    if (!isSettlingRefusal(last)) return last;
    await sleep(800);
  }
  throw new Error(`prompt retry never resolved: ${JSON.stringify(last)}`);
};

/**
 * First-call prompt honoring the real caller contract: a refusal must
 * be retryable SeatBusy carrying the durable row id, and the retry
 * addresses that same row. Returns the row id and the final delivery.
 */
const promptUntilNotified = async (
  seat: CrewSeat,
  args: {
    readonly target: string;
    readonly text: string;
    readonly fallback?: "notice";
  },
): Promise<{ readonly messageId: string; readonly data: Record<string, unknown> }> => {
  const first = await seat.op("msg.prompt", args);
  if (first.ok) {
    const data = opData(first);
    return { messageId: data.messageId as string, data };
  }
  // A fresh generation's first prompt can take one settle-window
  // refusal — retryable, never a new message.
  expect(isSettlingRefusal(first), JSON.stringify(first)).toBe(true);
  expect(first.error.details?.retryable).toBe(true);
  const messageId = first.error.details?.messageId as string;
  expect(typeof messageId).toBe("string");
  const last = await retryPrompt(
    seat,
    args.target,
    messageId,
    args.fallback !== undefined ? { fallback: args.fallback } : undefined,
  );
  const data = opData(last);
  expect((data.delivery as { state: string }).state).toBe("notified");
  return { messageId: data.messageId as string, data };
};

test("crew prompt [fake-tui]: idle seat takes the full body immediately", async () => {
  test.setTimeout(240_000);
  const junto = await launch();
  try {
    const { page, sandbox, a, b } = await boot(junto);

    const { messageId, data } = await promptUntilNotified(a, {
      target: B,
      text: "prompt: rotate the keys now",
    });
    expect((data.delivery as { state: string }).state).toBe("notified");

    // Projected prompt facts identify the outcome; the trace independently
    // proves one successful paste of the exact immediate payload.
    const [attempt] = await attemptRows(page, messageId);
    expect(attempt?.mailKind).toBe("prompt");
    expect(attempt?.notifiedAt).toBeDefined();
    expect(attempt?.unresolvedAt).toBeUndefined();
    expect(attempt?.attemptedAt).toBeDefined();
    await expect.poll(
      () => crewMessagePasteWrites(page, sandbox, CANVAS, B, messageId, "immediate"),
      { timeout: 15_000 },
    ).toBe(1);

    // Full-body form: "mail from <seat>" + the body, no read pointer.
    await expect
      .poll(async () => await b.stdinLog(), { timeout: 10_000 })
      .toContain("mail from seat-a");
    const stdin = await b.stdinLog();
    expect(stdin).toContain("rotate the keys now");
    expect(stdin).not.toContain("msg read");
  } finally {
    await junto.close();
  }
});

test("crew prompt [fake-tui]: busy seat refuses SeatBusy, same row retries clean", async () => {
  test.setTimeout(300_000);
  const junto = await launch();
  try {
    const { page, sandbox, a, b } = await boot(junto);

    // Park the seat in Working — an immediate prompt must refuse, not queue.
    await b.control({ screen: { mode: "working" } });
    await sleep(1_500);

    const res = await a.op("msg.prompt", {
      target: B,
      text: "prompt: hold while busy",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.type).toBe("SeatBusy");
    expect(res.error.details?.retryable).toBe(true);
    const messageId = res.error.details?.messageId as string;
    expect(typeof messageId).toBe("string");

    // The durable prompt row exists — the refusal did not eat the body.
    // Free the seat and retry the SAME durable row: the repaint makes B
    // newly idle, so the first retries settle-refuse before the drive is
    // admitted — the helper rides that out on the same messageId.
    await b.control({ screen: { mode: "idle" } });
    const last = await retryPrompt(a, B, messageId);
    const data = opData(last);
    expect((data.delivery as { state: string }).state).toBe("notified");

    const [attempt] = await attemptRows(page, messageId);
    expect(attempt?.mailKind).toBe("prompt");
    expect(attempt?.notifiedAt).toBeDefined();
    await expect.poll(
      () => crewMessagePasteWrites(page, sandbox, CANVAS, B, messageId, "immediate"),
      { timeout: 15_000 },
    ).toBe(1);

    await expect
      .poll(async () => await b.stdinLog(), { timeout: 10_000 })
      .toContain("hold while busy");
  } finally {
    await junto.close();
  }
});

test("crew prompt [fake-tui]: drafted composer refuses SeatBusy, no bytes typed", async () => {
  test.setTimeout(240_000);
  const junto = await launch();
  try {
    const { a, b } = await boot(junto);

    // An operator half-typed into the composer — prompt must not paste over it.
    await b.control({ screen: { mode: "draft", text: "half-typed thought" } });
    await sleep(1_500);

    // The gate consults settle before the composer verdict, so the first
    // eval on this generation can still refuse plain seat-busy — retry the
    // same row until the composer verdict is what answers.
    const first = await a.op("msg.prompt", {
      target: B,
      text: "prompt: do not paste over the draft",
    });
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.error.type).toBe("SeatBusy");
    expect(first.error.details?.retryable).toBe(true);
    const messageId = first.error.details?.messageId as string;
    expect(typeof messageId).toBe("string");
    const last = isSettlingRefusal(first)
      ? await retryPrompt(a, B, messageId)
      : first;
    expect(last.ok).toBe(false);
    if (last.ok) return;
    expect(last.error.type).toBe("SeatBusy");
    expect(last.error.details?.reason).toBe("composer-not-empty");

    // No prompt bytes reached the PTY.
    const stdin = await b.stdinLog();
    expect(stdin).not.toContain("do not paste over the draft");
  } finally {
    await junto.close();
  }
});

test("crew prompt [fake-tui]: fallback notice delivers the pointer form on the same row", async () => {
  test.setTimeout(300_000);
  const junto = await launch();
  try {
    const { page, sandbox, a, b } = await boot(junto);

    // Explicit fallback: the same durable row delivers ordinary-notice
    // form — one summary line with a msg-read pointer, not the body.
    const { messageId, data } = await promptUntilNotified(a, {
      target: B,
      text: "prompt: fall back to notice",
      fallback: "notice",
    });
    expect((data.delivery as { state: string }).state).toBe("notified");

    const [attempt] = await attemptRows(page, messageId);
    // The stored message remains a prompt; fallback chooses the notice
    // payload form, whose exact paste is counted separately in the trace.
    expect(attempt?.mailKind).toBe("prompt");
    expect(attempt?.notifiedAt).toBeDefined();
    expect(attempt?.unresolvedAt).toBeUndefined();
    await expect.poll(
      () => crewMessagePasteWrites(page, sandbox, CANVAS, B, messageId, "notice"),
      { timeout: 15_000 },
    ).toBe(1);

    await expect
      .poll(async () => await b.stdinLog(), { timeout: 10_000 })
      .toContain(`msg read ${messageId}`);
    const stdin = await b.stdinLog();
    expect(stdin).toContain("mail from seat-a");
    // Notice form carries a preview + pointer, never the raw full body
    // on its own line the way the immediate payload does.
    expect(stdin).not.toContain("\nprompt: fall back to notice");
  } finally {
    await junto.close();
  }
});

test("crew prompt [fake-tui]: unacknowledged paste is unresolved, never replayed", async () => {
  test.setTimeout(300_000);
  const junto = await launch();
  try {
    const { page, sandbox, a, b } = await boot(junto);

    // The fake keeps the pasted text in its composer and never repaints
    // Working — the written-no-evidence class, deterministically.
    await b.control({ submit: "hold" });

    // First call settles-refuses (SeatBusy) on a fresh generation; the
    // retry's paste is the one the fake strands. The unresolved outcome
    // is an ok envelope — the write happened, the turn-start did not.
    const first = await a.op("msg.prompt", {
      target: B,
      text: "prompt: strand me in the composer",
    });
    let messageId: string;
    let data: Record<string, unknown>;
    if (first.ok) {
      data = opData(first);
      messageId = data.messageId as string;
    } else {
      expect(first.error.type).toBe("SeatBusy");
      messageId = first.error.details?.messageId as string;
      expect(typeof messageId).toBe("string");
      const last = await retryPrompt(a, B, messageId);
      data = opData(last);
    }
    const deliveryState = (data.delivery as { state: string }).state;
    expect(deliveryState).toBe("unresolved");

    const [attempt] = await attemptRows(page, messageId);
    expect(attempt?.mailKind).toBe("prompt");
    expect(attempt?.unresolvedAt).toBeDefined();
    expect(attempt?.notifiedAt).toBeUndefined();
    expect(attempt?.attemptedAt).toBeDefined();
    expect(attempt?.generation).toBeTruthy();
    await expect.poll(
      () => crewMessagePasteWrites(page, sandbox, CANVAS, B, messageId, "immediate"),
      { timeout: 15_000 },
    ).toBe(1);

    // The current projection proves generation identity, not attempt history.
    // After redraw and a wait, the trace must still count one physical paste.
    await b.control({ screen: { mode: "idle" }, submit: "ack" });
    await b.print("poke");
    await sleep(8_000);
    const [current] = await attemptRows(page, messageId);
    expect(current?.generation).toBe(attempt!.generation);
    expect(current?.unresolvedAt).toBe(attempt!.unresolvedAt);
    expect(current?.notifiedAt).toBeUndefined();
    await expect.poll(
      () => crewMessagePasteWrites(page, sandbox, CANVAS, B, messageId, "immediate"),
      { timeout: 15_000 },
    ).toBe(1);
    const stdin = await b.stdinLog();
    expect(stdin).toContain("strand me in the composer");
  } finally {
    await junto.close();
  }
});

test("crew prompt [fake-tui]: retry must name this seat's own prompt", async () => {
  test.setTimeout(240_000);
  const junto = await launch();
  try {
    const { a } = await boot(junto);

    // A invented message id — not a prompt this seat created for B.
    const forged = await a.op("msg.prompt", {
      target: B,
      messageId: "01JFORGED00000000000000000",
    });
    expect(forged.ok).toBe(false);
    if (forged.ok) return;
    expect(forged.error.type).toBe("ScopeError");
  } finally {
    await junto.close();
  }
});

test("crew prompt [fake-tui]: oversize immediate body refuses before any byte", async () => {
  test.setTimeout(240_000);
  const junto = await launch();
  try {
    const { a, b } = await boot(junto);

    // The immediate limit bounds the pasted payload, so a body that
    // pushes the envelope over refuses as an input error — never typed.
    // The gate runs before the body admission check, so a fresh
    // generation can settle-refuse first: retry the same row until the
    // body check is what answers.
    const first = await a.op("msg.prompt", {
      target: B,
      text: `prompt: ${"x".repeat(400)}`,
    });
    let last = first;
    if (isSettlingRefusal(first)) {
      const messageId = first.error.details?.messageId as string;
      expect(typeof messageId).toBe("string");
      last = await retryPrompt(a, B, messageId);
    }
    expect(last.ok).toBe(false);
    if (last.ok) return;
    expect(last.error.type).toBe("InputError");
    expect(last.error.details?.reason).toBe("over-limit");

    const stdin = await b.stdinLog();
    expect(stdin).not.toContain("xxxx");
  } finally {
    await junto.close();
  }
});
