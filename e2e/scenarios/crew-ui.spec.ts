/**
 * Crew UI journeys — the operator surfaces tell the same truth the wire
 * does. Seats are fake-tui where a seat must act; pure-surface journeys run
 * without the seat harness.
 *
 * Laws covered:
 *   1. the actor ledger renders each durable delivery state it is fed —
 *      refused, notified, read, written-but-unacknowledged — with the mail
 *      kind and the unresolved flag on the row and an unresolved header
 *      count;
 *   2. the connections rail counts unresolved writes per peer on the drawn
 *      edge;
 *   3. the relation surface renders the compiled port chips of a messages
 *      edge — granted vs masked — and a chip click rewrites ether.mask
 *      through the normal operator path;
 *   4. task detail shows the requires-review authoring (required, waiting
 *      for green) and the verdict chain tracks posted verdicts, ageing
 *      prior-epoch rows as send-backs bump the task epoch.
 */
import { expect, launchJunto, test } from "../harness/launch";
import {
  crewMailAttempts,
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
// 1-2. mail ledger rows + glance chips
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

    // Cold first contact: a transient refusal (the seat still painting) may
    // coalesce on the same attempt row, but the landed write ranks above it —
    // the row must tell the truth about the notification, not the refusal.
    const send = await seatAHandle.op("msg.send", {
      target: B,
      text: "peer mail: ledger shows me",
    });
    const messageId = opData(send).messageId as string;
    await expect
      .poll(
        async () =>
          (await crewMailAttempts(page, CANVAS, B))
            .find((row) => row.messageId === messageId)?.notifiedAt,
        // Cold first contact can refuse once and retry — the stamp follows
        // the delivery pipeline's own retry.
        { timeout: 60_000, intervals: [250, 500, 1_000] },
      )
      .not.toBeUndefined();

    const row = ledger.locator(
      `[data-testid="${CREW_UI_SELECTORS.mailRow}"][data-message-id="${messageId}"]`,
    );
    await expect(row).toHaveAttribute("data-delivery", "notified");
    await expect(row).toHaveAttribute("data-mail-kind", "notice");
    await expect(row).not.toHaveAttribute("data-unresolved", "true");

    // The recipient's read-ack moves the same row to read — never a second row.
    const read = await seatBHandle.op("msg.read", { messageId });
    expect(read.ok, JSON.stringify(read)).toBe(true);
    await expect(row).toHaveAttribute("data-delivery", "read");
    await expect(row).toHaveCount(1);

    // A write the seat never acknowledges is unresolved — the ledger says so
    // on the row, in the header count, and on the peer chip in the rail.
    // The first mail's ack left the fake in its Working frame; an idle
    // request returns it so the swallowed write can actually land.
    await seatBHandle.control({
      screen: { mode: "idle" },
      submit: "ignore",
      paste: "swallow",
    });
    const swallowed = await seatAHandle.op("msg.send", {
      target: B,
      text: "peer mail: swallowed write",
    });
    const swallowedId = opData(swallowed).messageId as string;
    await expect
      .poll(
        async () =>
          (await crewMailAttempts(page, CANVAS, B))
            .find((entry) => entry.messageId === swallowedId)?.unresolvedAt,
        // Written-but-unacknowledged is stamped after the drive's ack
        // observation window — same evidence window crew-mail uses.
        { timeout: 90_000, intervals: [500, 1_000, 2_000] },
      )
      .not.toBeUndefined();

    const unresolvedRow = ledger.locator(
      `[data-testid="${CREW_UI_SELECTORS.mailRow}"][data-message-id="${swallowedId}"]`,
    );
    await expect(unresolvedRow).toHaveAttribute("data-delivery", "unresolved", {
      timeout: 15_000,
    });
    await expect(unresolvedRow).toHaveAttribute("data-unresolved", "true");
    await expect(
      ledger.getByTestId(CREW_UI_SELECTORS.mailUnresolved),
    ).toHaveText("1");

    // The connections rail carries the same count against the drawn edge.
    // It may already be open; only the collapsed rail shows the expand key.
    const glance = front.getByTestId(CREW_UI_SELECTORS.edgesGlance);
    const expandToggle = glance.getByRole("button", {
      name: /Expand connections/,
    });
    if ((await expandToggle.count()) > 0) {
      await expandToggle.click();
    }
    await expect(
      glance.locator(
        `[data-testid="${CREW_UI_SELECTORS.seatUnresolvedMail}"][data-peer-id="${A}"]`,
      ),
    ).toHaveText("1");
    await expect(
      glance.getByTestId(CREW_UI_SELECTORS.seatUnresolvedMailTotal),
    ).toHaveText("1");

    // A send the seat can never take is refused, not parked forever: kill
    // the recipient and the consult stamps the refusal durably.
    await seatBHandle.control({ exit: 0 });
    const refused = await seatAHandle.op("msg.send", {
      target: B,
      text: "peer mail: seat is gone",
    });
    const refusedId = opData(refused).messageId as string;
    await expect
      .poll(async () =>
        (await crewMailAttempts(page, CANVAS, B))
          .find((entry) => entry.messageId === refusedId)?.refusedAt,
        { timeout: 30_000 },
      )
      .not.toBeUndefined();
    const refusedRow = ledger.locator(
      `[data-testid="${CREW_UI_SELECTORS.mailRow}"][data-message-id="${refusedId}"]`,
    );
    await expect(refusedRow).toHaveAttribute("data-delivery", "refused");
    await expect(refusedRow).not.toHaveAttribute("data-unresolved", "true");
  } finally {
    await junto.close();
  }
});

// ---------------------------------------------------------------------------
// 3. port-mask chips on the relation surface
// ---------------------------------------------------------------------------

test("crew ui: the relation surface paints granted and masked ports from ether.mask", async () => {
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

    const mask = page.getByTestId(CREW_UI_SELECTORS.edgePortMask);
    await expect(mask).toBeVisible({ timeout: 10_000 });

    // messages compiles five crew ports; ether.mask dropped msg.send.
    const chips = mask.getByTestId(CREW_UI_SELECTORS.edgePortMaskChip);
    await expect(chips).toHaveCount(5);
    for (const port of [
      "msg.list",
      "msg.prompt",
      "seat.wait",
      "terminal.read",
    ]) {
      await expect(
        mask.locator(`[data-port="${port}"]`),
      ).toHaveAttribute("data-granted", "true");
    }
    const sendChip = mask.locator('[data-port="msg.send"]');
    await expect(sendChip).toHaveAttribute("data-granted", "false");
    await expect(sendChip).toHaveAttribute("data-attenuable", "true");

    // The chip is editable: granting it back clears the mask to the full
    // compile through the normal operator mutation.
    await sendChip.click();
    await expect(sendChip).toHaveAttribute("data-granted", "true");
  } finally {
    await junto.close();
  }
});

// ---------------------------------------------------------------------------
// 4. requires-review authoring + verdict chain on the task detail
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
