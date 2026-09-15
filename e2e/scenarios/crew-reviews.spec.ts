/** Generated canvas, real process-bound work ops and SQLite owner, fake TUI seats. */
import { expect, launchVellum, test } from "../harness/launch";
import {
  crewDoc, crewOccupySeat, crewPlayFactory, crewReviewsEdge, crewRule,
  crewSeat, crewSeatNode, crewTasksNode, crewWorksEdge, installCrewSeatHarness,
  type CrewSeat, type WorkEnvelope,
} from "../harness/crew-fixture";
import { taskItem } from "../harness/sandbox";
import type { Message, Task } from "../../src/shared/work-model";
import type { WorkTaskShowView } from "../../src/main/vellum-command/work/service";
import type { VerdictPostArgs } from "../../src/shared/work-control";

const CANVAS = "crew-reviews";
const AUTHOR = "author";
const REVIEWER = "reviewer";
const BOARD = "review-work";
const TASK = "review-candidate";
const TITLE = "Prove the independent review cycle";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const authorNode = crewSeatNode({ id: AUTHOR, label: "Author", x: 40, y: 40 });
const reviewerNode = crewSeatNode({ id: REVIEWER, label: "Reviewer", x: 360, y: 40 });
const boardNode = crewTasksNode({
  id: BOARD, x: 680, y: 40,
  items: [taskItem(TASK, TITLE)],
  contract: {
    incoming: { admission: "auto" },
    rules: [crewRule("independent-review", "An independent reviewer must approve the candidate", "requires-review")],
  },
});
const nodes = [authorNode, reviewerNode, boardNode];
const doc = crewDoc(nodes, [
  crewWorksEdge("author-works", BOARD, AUTHOR, nodes),
  crewReviewsEdge("reviewer-reviews", REVIEWER, AUTHOR, nodes),
]);

const data = <T>(result: WorkEnvelope): T => {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.data as T;
};

const show = async (author: CrewSeat): Promise<WorkTaskShowView> =>
  data(await author.op("tasks.show", { target: BOARD, task: TASK }));

const claim = async (author: CrewSeat): Promise<void> => {
  // The normal factory may already have assigned the only eligible author.
  if ((await show(author)).task.state === "submitted") {
    data(await author.op("tasks.claim", { target: BOARD, task: TASK }));
  }
  expect((await show(author)).task.state).toBe("working");
};

const evidence = (sha: string) => ({ artifacts: [], git: { commits: [sha] } });

const receiptSubject = async (
  reviewer: CrewSeat,
  epoch: number,
): Promise<Extract<VerdictPostArgs["subject"], { kind: "task" }>> => {
  let found: Message | undefined;
  await expect.poll(async () => {
    const inbox = data<{ items: Message[] }>(await reviewer.op("msg.list", {}));
    found = inbox.items.find((message) => {
      const subject = message.metadata?.reviewSubject as { taskId?: string; epoch?: number } | undefined;
      return message.metadata?.mailKind === "receipt" && subject?.taskId === TASK && subject.epoch === epoch;
    });
    return found !== undefined;
  }, { timeout: 15_000 }).toBe(true);
  const subject = found!.metadata!.reviewSubject as Extract<VerdictPostArgs["subject"], { kind: "task" }>;
  expect(subject.subjectHash).toMatch(/^[a-f0-9]{64}$/);
  expect(found!.metadata!.fromSeat).toBeTruthy();
  return subject;
};

test("crew reviews [fake-tui]: receipt, blocking, repair and green reach the live verdict chain", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const app = await launchVellum({ seedCanvases: { [CANVAS]: doc }, afterSeed: installCrewSeatHarness });
  try {
    const { page, sandbox } = app;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);
    const author = crewSeat(sandbox, CANVAS, AUTHOR);
    const reviewer = crewSeat(sandbox, CANVAS, REVIEWER);
    await crewOccupySeat(page, CANVAS, authorNode, author);
    await crewOccupySeat(page, CANVAS, reviewerNode, reviewer);
    await claim(author);

    data(await author.op("tasks.update", { target: BOARD, task: TASK, state: "working", completionEvidence: evidence(SHA_A) }));
    const firstSubject = await receiptSubject(reviewer, 0);
    expect((await show(author)).reviewSubject.subjectHash).toBe(firstSubject.subjectHash);

    // A reviews edge grants verdicts, not task reads or terminal input/observation.
    for (const [op, args] of [
      ["tasks.show", { target: BOARD, task: TASK }],
      ["seat.read", { target: AUTHOR, lines: 10 }],
    ] as const) {
      const denied = await reviewer.op(op, args);
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.type).toBe("ScopeError");
    }
    const noGreen = await author.op("tasks.update", { target: BOARD, task: TASK, state: "completed", completionEvidence: evidence(SHA_A) });
    expect(noGreen.ok, JSON.stringify(noGreen)).toBe(false);
    expect((await show(author)).task.state).toBe("working");
    const self = await author.op("verdict.post", { target: BOARD, subject: firstSubject, kind: "green" });
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.error.type).toBe("ReviewerIsAuthor");

    const blocked = data<{ effect: string; newEpoch: number }>(await reviewer.op("verdict.post", {
      target: BOARD, subject: firstSubject, kind: "blocking",
      findings: ["Add the missing acceptance case"], refs: [{ kind: "commit", sha: SHA_A }],
    }));
    expect(blocked).toMatchObject({ effect: "rejected", newEpoch: 1 });
    const afterBlock = await show(author);
    expect(afterBlock.task.epoch).toBe(1);
    expect(afterBlock.task.defects).toHaveLength(1);
    expect(afterBlock.task.completionEvidence).toBeUndefined();
    expect(afterBlock.verdicts.map((verdict) => verdict.kind)).toEqual(["blocking"]);

    const stale = await reviewer.op("verdict.post", { target: BOARD, subject: firstSubject, kind: "green" });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.details?.reason).toBe("stale-subject");
    await claim(author);
    data(await author.op("tasks.update", { target: BOARD, task: TASK, state: "working", completionEvidence: evidence(SHA_B) }));
    const repairedSubject = await receiptSubject(reviewer, 1);
    expect(repairedSubject.subjectHash).not.toBe(firstSubject.subjectHash);
    data(await reviewer.op("verdict.post", { target: BOARD, subject: repairedSubject, kind: "green", refs: [{ kind: "commit", sha: SHA_B }] }));
    data(await author.op("tasks.update", { target: BOARD, task: TASK, state: "completed", completionEvidence: evidence(SHA_B) }));
    expect((await show(author)).task.state).toBe("completed");

    // Read the app's canonical projection, never a second database connection.
    const projected = await page.evaluate(async ({ canvas, board, task }) => {
      const read = await window.vellumCommand!.readCanvas(canvas);
      return read.doc.nodes.find((node) => node.id === board)?.ether?.tasks?.items.find((item) => item.id === task);
    }, { canvas: CANVAS, board: BOARD, task: TASK }) as Task;
    expect(projected.subjectHash).toBe(repairedSubject.subjectHash);
    expect(projected.verdicts?.map((verdict) => [verdict.kind, verdict.epoch])).toEqual([["blocking", 0], ["green", 1]]);

    await page.locator(`.react-flow__node[data-id="${BOARD}"]`).getByTestId("tasks-card").dispatchEvent("dblclick");
    const board = page.getByRole("dialog", { name: "Task board" });
    await board.getByTestId("task-board-card").filter({ hasText: TITLE }).click();
    const chain = page.getByTestId("verdict-chain");
    await expect(chain).toBeVisible();
    await expect(chain.locator('[data-verdict="blocking"][data-epoch="0"]')).toContainText("Add the missing acceptance case");
    await expect(chain.locator('[data-verdict="green"][data-epoch="1"]')).toHaveAttribute("data-current", "true");
    const screenshot = testInfo.outputPath("crew-verdict-chain.png");
    await chain.screenshot({ path: screenshot });
    await testInfo.attach("verdict-chain", { path: screenshot, contentType: "image/png" });

    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("command-bar-input").fill("> Open canvas digest");
    await page.getByRole("option", { name: /Open canvas digest/ }).click();
    const digest = page.getByTestId("canvas-digest-body");
    await expect(digest).toBeVisible();
    await expect(digest).toContainText("blocking");
    await expect(digest).toContainText("green");
    await expect(digest).toContainText(repairedSubject.subjectHash.slice(0, 12));
    const digestScreenshot = testInfo.outputPath("crew-review-digest.png");
    await page.getByTestId("canvas-digest").screenshot({ path: digestScreenshot });
    await testInfo.attach("review-digest", { path: digestScreenshot, contentType: "image/png" });
  } finally {
    await app.close();
  }
});
