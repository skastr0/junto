/**
 * Crew UI journeys — the operator surfaces tell the same truth the wire
 * does. Seats are fake-tui where a seat must act; pure-surface journeys run
 * without the seat harness.
 *
 * Laws covered:
 *   1. the actor ledger shows each mail row as delivered once written into
 *      the seat, or waiting for a seat that is not running, with its kind;
 *   2. the relation surface renders the compiled port chips of a messages
 *      edge — granted vs masked — and a chip click rewrites ether.mask
 *      through the normal operator path.
 */
import { expect, launchJunto, test } from "../harness/launch";
import {
  crewMessagesEdge,
  crewOccupySeat,
  crewPlayFactory,
  crewSeat,
  crewSeatNode,
  crewDoc,
  installCrewSeatHarness,
  type WorkEnvelope,
} from "../harness/crew-fixture";
import {
  CREW_UI_SELECTORS,
  messagesEdgeWithMask,
} from "../harness/crew-ui-fixtures";

const CANVAS = "crew-ui";
const A = "seat-a";
const B = "seat-b";

const seatA = crewSeatNode({ id: A, x: 40, y: 40 });
const seatB = crewSeatNode({ id: B, x: 360, y: 40 });

const opData = (env: WorkEnvelope): Record<string, unknown> => {
  expect(env.ok, JSON.stringify(env)).toBe(true);
  if (!env.ok) throw new Error("unreachable");
  return (env.data ?? {}) as Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// 1. mail ledger rows
// ---------------------------------------------------------------------------

test("crew ui [fake-tui]: the mail ledger renders truthful delivery on every row", async () => {
  test.setTimeout(240_000);
  const junto = await launchJunto({
    seedCanvases: {
      [CANVAS]: crewDoc(
        [seatA, seatB],
        [crewMessagesEdge("e-ab", A, B, [seatA, seatB])],
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

    // Occupancy parks the seat in the dock; the ledger lives on the node's
    // own surface — double-click brings it to the front pane.
    await page.locator(`.react-flow__node[data-id="${B}"]`).dblclick();
    const front = page.locator(
      ".workbench-pane:not(.workbench-pane--parked) .native-terminal-surface",
    );
    await expect(front).toBeVisible({ timeout: 20_000 });

    const ledger = front.getByTestId(CREW_UI_SELECTORS.ledger);
    await expect(ledger).toBeVisible({ timeout: 15_000 });
    await expect(ledger.locator(".actor-ledger__empty")).toHaveText(
      "No mail yet",
    );

    // Mail is written into the recipient's input at once; the row says so.
    const send = await seatAHandle.op("msg.send", {
      target: B,
      text: "peer mail: ledger shows me",
    });
    const messageId = opData(send).messageId as string;
    const row = ledger.locator(
      `[data-testid="${CREW_UI_SELECTORS.mailRow}"][data-message-id="${messageId}"]`,
    );
    await expect(row).toHaveAttribute("data-delivery", "delivered", {
      timeout: 60_000,
    });
    await expect(row).toHaveAttribute("data-mail-kind", "notice");

    // The recipient's read-ack settles the same row, never a second one.
    const read = await seatBHandle.op("msg.read", { messageId });
    expect(read.ok, JSON.stringify(read)).toBe(true);
    await expect(row).not.toHaveClass(/actor-ledger__mail-item--unread/);
    await expect(row).toHaveAttribute("data-delivery", "delivered");
    await expect(row).toHaveCount(1);

    // A seat whose process is gone cannot take mail yet: the row waits for it.
    await seatBHandle.control({ exit: 0 });
    const waiting = await seatAHandle.op("msg.send", {
      target: B,
      text: "peer mail: seat is gone",
    });
    const waitingId = opData(waiting).messageId as string;
    const waitingRow = ledger.locator(
      `[data-testid="${CREW_UI_SELECTORS.mailRow}"][data-message-id="${waitingId}"]`,
    );
    await expect(waitingRow).toHaveAttribute("data-delivery", "waiting", {
      timeout: 15_000,
    });
  } finally {
    await junto.close();
  }
});

// ---------------------------------------------------------------------------
// 2. the relation surface names the connection, never its capabilities
// ---------------------------------------------------------------------------

test("crew ui: the relation card shows no capability chips and keeps a stored mask", async () => {
  test.setTimeout(90_000);
  const masked = messagesEdgeWithMask("e-ab", A, B, [seatA, seatB], [
    "msg.list",
    "msg.prompt",
    "seat.wait",
    "terminal.read",
  ]);
  const junto = await launchJunto({
    seedCanvases: { [CANVAS]: crewDoc([seatA, seatB], [masked]) },
  });
  try {
    const { page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("rf__edge-e-ab")).toHaveCount(1, {
      timeout: 30_000,
    });

    // The wire's midpoint is a covered hit target; its keyboard affordance
    // ("Select edge") opens the same RTS relation card deterministically.
    await page
      .getByRole("button", { name: /^Select edge -/ })
      .first()
      .press("Enter");

    const card = page.getByRole("toolbar", { name: "Relation actions" });
    await expect(card).toBeVisible({ timeout: 10_000 });
    const panel = page.locator(".rts-panel--cmd");
    await expect(panel).not.toContainText(/\bports?\b|send mail|prompt/i);

    // The kernel still honours the stored mask; the card only stopped
    // showing it.
    const stored = await page.evaluate(async (canvas) => {
      const read = await window.junto!.readCanvas(canvas);
      return read.doc.edges.find((edge) => edge.id === "e-ab")?.ether?.mask;
    }, CANVAS);
    expect(stored).toEqual(["msg.list", "msg.prompt", "seat.wait", "terminal.read"]);
  } finally {
    await junto.close();
  }
});
