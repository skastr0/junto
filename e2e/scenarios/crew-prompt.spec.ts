/**
 * Prompt mail — the full body typed into the recipient seat at once, over a
 * messages edge [fake-tui].
 *
 * msg.prompt (the op behind `junto msg send --prompt`) stores a prompt and
 * types `mail from <sender>\n<full body>` into the recipient's input and
 * submits it, whatever the seat is doing. The harness queues or steers what
 * it receives. The op answers { messageId, delivery }: "delivered" once the
 * text is on the seat, "waiting" when the seat is not up yet.
 *
 * Evidence: the op's `delivery` field, the projected `deliveredAt` receipt,
 * the fake's stdin log (one bracketed paste of the exact payload), and the
 * fake's submit event (the composer text the CR submitted, by hash). The
 * fake-tui seats give deterministic control over what the seat is doing
 * when the prompt lands: idle, working, or holding an operator draft.
 *
 * Laws covered:
 *   1. an idle seat takes the full body: one paste of the exact
 *      "mail from <seat>" + body payload, submitted, and receipted;
 *   2. a working seat takes the prompt at once, typed while it works;
 *   3. a composer holding a draft takes the prompt at once, typed after
 *      the draft and submitted with it;
 *   4. a body of any length is typed in full.
 *
 * Seats are fake-tui: deterministic screen control, labelled honestly.
 */
import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import type { Message } from "../../src/shared/canvas";
import { readMailExtension } from "../../src/shared/crew";
import { composeImmediatePromptPayload } from "../../src/shared/message-delivery";
import { expect, launchJunto, test } from "../harness/launch";
import {
  crewOccupySeat,
  crewPlayFactory,
  crewReceipts,
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

/** B's live seat read, as A sees it over the edge. */
const readSeat = async (
  from: CrewSeat,
): Promise<{ readonly state: string; readonly text: string }> => {
  const read = await from.op("seat.read", { target: B, lines: 20 });
  if (!read.ok) return { state: "unreadable", text: "" };
  const data = (read.data ?? {}) as { state?: unknown; text?: unknown };
  return {
    state: typeof data.state === "string" ? data.state : "unknown",
    text: typeof data.text === "string" ? data.text : "",
  };
};

/** The stored prompt as the app projects it on B's mailbox. */
const projectedMessage = async (page: Page, messageId: string): Promise<Message> => {
  const doc = await page.evaluate(
    async (name) => (await window.junto!.readCanvas(name)).doc,
    CANVAS,
  );
  const message = doc.nodes
    .find((node) => node.id === B)
    ?.ether?.messages?.items.find((item) => item.messageId === messageId);
  if (message === undefined) throw new Error(`Missing projected prompt ${messageId}`);
  return message;
};

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

/** Bracketed pastes of exactly this payload in the seat's raw PTY input. */
const pastesOf = (stdin: string, payload: string): number =>
  stdin.split(`${BRACKETED_PASTE_START}${payload}${BRACKETED_PASTE_END}`).length - 1;

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

/** Hashes of every non-empty composer text the fake submitted on CR. */
const submittedHashes = async (seat: CrewSeat): Promise<ReadonlyArray<string>> =>
  (await seat.events())
    .filter((event) => event.event === "submit" && Number(event.textLength) > 0)
    .map((event) => String(event.textSha256));

/**
 * Send a prompt from A to B and prove it was typed at once: the op answers
 * delivered, the receipt is stamped, and B's input took exactly one paste
 * of the full "mail from <sender>" + body payload.
 */
const promptDelivered = async (
  page: Page,
  a: CrewSeat,
  b: CrewSeat,
  text: string,
): Promise<{ readonly messageId: string; readonly payload: string }> => {
  const data = opData(await a.op("msg.prompt", { target: B, text }));
  const messageId = data.messageId as string;
  expect(typeof messageId).toBe("string");
  expect(data.delivery).toBe("delivered");

  const message = await projectedMessage(page, messageId);
  expect(readMailExtension(message.metadata)?.mailKind).toBe("prompt");
  const payload = composeImmediatePromptPayload(message);
  expect(payload.startsWith(`mail from ${A}\n`)).toBe(true);
  expect(payload.endsWith(text)).toBe(true);

  await expect
    .poll(
      async () =>
        (await crewReceipts(page, CANVAS, B)).find((row) => row.messageId === messageId)
          ?.deliveredAt,
      { timeout: 15_000 },
    )
    .toBeDefined();
  await expect
    .poll(async () => pastesOf(await b.stdinLog(), payload), { timeout: 10_000 })
    .toBe(1);
  return { messageId, payload };
};

test("crew prompt [fake-tui]: idle seat takes the full body immediately", async () => {
  test.setTimeout(240_000);
  const junto = await launch();
  try {
    const { page, a, b } = await boot(junto);
    await expect
      .poll(async () => (await readSeat(a)).state, { timeout: 30_000 })
      .toBe("idle");

    const { payload } = await promptDelivered(
      page,
      a,
      b,
      "prompt: rotate the keys now",
    );

    // The empty composer took the whole payload and the CR submitted it.
    await expect
      .poll(() => submittedHashes(b), { timeout: 10_000 })
      .toContain(sha256(payload));
  } finally {
    await junto.close();
  }
});

test("prompt [fake-tui]: working seat takes the prompt at once", async () => {
  test.setTimeout(240_000);
  const junto = await launch();
  try {
    const { page, a, b } = await boot(junto);

    // B is mid-turn when the prompt lands; the harness queues or steers it.
    await b.control({ screen: { mode: "working" } });
    await expect
      .poll(async () => (await readSeat(a)).state, { timeout: 30_000 })
      .toBe("working");

    const { payload } = await promptDelivered(
      page,
      a,
      b,
      "prompt: take this while you work",
    );

    // Typed and submitted while B was working.
    await expect
      .poll(() => submittedHashes(b), { timeout: 10_000 })
      .toContain(sha256(payload));
    expect((await readSeat(a)).state).toBe("working");
  } finally {
    await junto.close();
  }
});

test("prompt [fake-tui]: composer holding a draft takes the prompt at once", async () => {
  test.setTimeout(240_000);
  const junto = await launch();
  try {
    const { page, a, b } = await boot(junto);

    // An operator half-typed into B's composer before the prompt landed.
    const draft = "half-typed thought";
    await b.control({ screen: { mode: "draft", text: draft } });
    await expect
      .poll(async () => (await readSeat(a)).text, { timeout: 30_000 })
      .toContain(draft);

    const { payload } = await promptDelivered(
      page,
      a,
      b,
      "prompt: land on top of the draft",
    );

    // The prompt went in after the draft and the CR submitted both.
    await expect
      .poll(() => submittedHashes(b), { timeout: 10_000 })
      .toContain(sha256(`${draft}${payload}`));
  } finally {
    await junto.close();
  }
});

test("prompt [fake-tui]: a long body is typed in full", async () => {
  test.setTimeout(240_000);
  const junto = await launch();
  try {
    const { page, a, b } = await boot(junto);
    await expect
      .poll(async () => (await readSeat(a)).state, { timeout: 30_000 })
      .toBe("idle");

    const text = `prompt: ${"step through the long body; ".repeat(16)}end of body`;
    expect(text.length).toBeGreaterThan(160);

    const { payload } = await promptDelivered(page, a, b, text);

    // Every character reached the composer, and the CR submitted all of it.
    expect(await b.stdinLog()).toContain(text);
    await expect
      .poll(() => submittedHashes(b), { timeout: 10_000 })
      .toContain(sha256(payload));
  } finally {
    await junto.close();
  }
});
