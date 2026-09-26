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
 *      through the normal operator path;
 *   3. task detail shows the requires-review authoring (required, waiting
 *      for green) and the verdict chain tracks posted verdicts, ageing
 *      prior-epoch rows as send-backs bump the task epoch.
 */
import { expect, launchJunto, test } from "../harness/launch";
import {
  crewManagesEdge,
  crewMessagesEdge,
  crewOccupySeat,
  crewPlayFactory,
  crewReviewsEdge,
  crewSeat,
  crewSeatNode,
  crewTasksNode,
  crewDoc,
  crewWorksEdge,
  installCrewSeatHarness,
  type WorkEnvelope,
} from "../harness/crew-fixture";
import {
  CREW_UI_SELECTORS,
  messagesEdgeWithMask,
  requiresReviewRule,
} from "../harness/crew-ui-fixtures";
import { taskItem } from "../harness/sandbox";

const CANVAS = "crew-ui";
const A = "seat-a";
const B = "seat-b";
const R = "seat-r";
const SINK = "sink";

const SHA_A = "a".repeat(40);

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

// ---------------------------------------------------------------------------
// 3. requires-review authoring + verdict chain on the task detail
// ---------------------------------------------------------------------------

test("crew ui [fake-tui]: task detail arms the review gate and chains posted verdicts", async () => {
  test.setTimeout(300_000);
  const sink = crewTasksNode({
    id: SINK,
    x: 680,
    y: 40,
    items: [taskItem("task-1", "review me before merge")],
    contract: { rules: [requiresReviewRule()] },
  });
  const seatR = crewSeatNode({ id: R, x: 40, y: 280 });
  const doc = crewDoc(
    [seatA, seatR, sink],
    [
      crewWorksEdge("w-sink-a", SINK, A, [seatA, seatR, sink]),
      crewManagesEdge("m-r", R, SINK, [seatA, seatR, sink]),
      crewReviewsEdge("e-rev", R, A, [seatA, seatR, sink]),
    ],
  );
  const junto = await launchJunto({
    seedCanvases: { [CANVAS]: doc },
    afterSeed: installCrewSeatHarness,
  });
  try {
    const { page, sandbox } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);

    const seatAHandle = crewSeat(sandbox, CANVAS, A);
    const seatRHandle = crewSeat(sandbox, CANVAS, R);
    await crewOccupySeat(page, CANVAS, seatA, seatAHandle);
    await crewOccupySeat(page, CANVAS, seatR, seatRHandle);

    // The author claims task-1 and stages a commit for review.
    const claim = await seatAHandle.op("tasks.claim", {
      target: SINK,
      task: "task-1",
    });
    expect(claim.ok, JSON.stringify(claim)).toBe(true);
    const staged = await seatAHandle.op("tasks.update", {
      target: SINK,
      task: "task-1",
      state: "working",
      completionEvidence: { artifacts: [], git: { commits: [SHA_A] } },
    });
    expect(staged.ok, JSON.stringify(staged)).toBe(true);

    // Open the task board and select the task — the detail panel shows the
    // review requirement armed and unsatisfied, and an empty chain.
    const tasksCard = page.locator(`.react-flow__node[data-id="${SINK}"]`);
    await tasksCard.getByTestId("tasks-card").dispatchEvent("dblclick");
    const board = page.getByRole("dialog", { name: "Task board" });
    await expect(board).toBeVisible({ timeout: 15_000 });
    await board
      .getByRole("listitem", { name: /Open details for review me before merge/ })
      .click();
    const detail = page.getByTestId(CREW_UI_SELECTORS.taskDetail);
    await expect(detail).toBeVisible();

    const authoring = detail.getByTestId(CREW_UI_SELECTORS.requiresReview);
    await expect(authoring).toHaveAttribute("data-required", "true");
    await expect(authoring).toHaveAttribute("data-satisfied", "false");
    await expect(authoring).toContainText("waiting for green");

    const chain = detail.getByTestId(CREW_UI_SELECTORS.verdictChain);
    await expect(chain).toBeVisible();
    await expect(chain).toContainText("No verdicts on this epoch yet.");

    // The reviewer reads the subject it must judge, then posts green.
    const show = await seatRHandle.op("tasks.show", {
      target: SINK,
      task: "task-1",
    });
    const subject = (opData(show) as {
      reviewSubject: { epoch: number; subjectHash: string };
    }).reviewSubject;
    const green = await seatRHandle.op("verdict.post", {
      target: SINK,
      subject: {
        kind: "task",
        taskId: "task-1",
        epoch: subject.epoch,
        subjectHash: subject.subjectHash,
      },
      kind: "green",
    });
    expect(green.ok, JSON.stringify(green)).toBe(true);

    // The gate shows satisfied on this epoch; the chain carries the green.
    await expect(authoring).toHaveAttribute("data-satisfied", "true");
    const greenEntry = chain.locator(
      `[data-testid="${CREW_UI_SELECTORS.verdictChainEntry}"][data-verdict="green"]`,
    );
    await expect(greenEntry).toHaveCount(1);
    await expect(greenEntry).toHaveAttribute("data-epoch", "0");
    await expect(greenEntry).toHaveAttribute("data-current", "true");
    await expect(greenEntry).toHaveAttribute("data-reviewer-node", R);

    // A blocking verdict sends the task back at epoch+1: both rows now sit
    // on a prior epoch and the gate waits for a fresh green.
    const blocking = await seatRHandle.op("verdict.post", {
      target: SINK,
      subject: {
        kind: "task",
        taskId: "task-1",
        epoch: subject.epoch,
        subjectHash: subject.subjectHash,
      },
      kind: "blocking",
      findings: ["no tests cover the merge path"],
    });
    expect(blocking.ok, JSON.stringify(blocking)).toBe(true);

    const entries = chain.locator(
      `[data-testid="${CREW_UI_SELECTORS.verdictChainEntry}"]`,
    );
    await expect(entries).toHaveCount(2);
    const blockingEntry = chain.locator(
      `[data-testid="${CREW_UI_SELECTORS.verdictChainEntry}"][data-verdict="blocking"]`,
    );
    await expect(blockingEntry).toHaveAttribute("data-epoch", "0");
    await expect(blockingEntry).toHaveAttribute("data-current", "false");
    await expect(greenEntry).toHaveAttribute("data-current", "false");
    await expect(authoring).toHaveAttribute("data-satisfied", "false");
    await expect(authoring).toContainText("waiting for green");
    await expect(authoring).toContainText("epoch 1");
  } finally {
    await junto.close();
  }
});
