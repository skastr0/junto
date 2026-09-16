/**
 * THE critical Tasks e2e — full task path data fidelity in the real app.
 *
 * Topology: intake forks to build and review; both converge on ship.
 * One agent seat holds `contributes` on every board. Every hop is driven
 * through the product IPC (operator gestures — no live agent process), and
 * after EVERY transition the canvas is re-read and the full task field set
 * is asserted: state, claimedBy, visits (entry/exit/epoch/notes), defects,
 * epoch, rules carried, approval gate, dropped re-home fields, completion
 * evidence — then the rendered visits list in the task detail.
 *
 * Verb law: every edge here authors its verb explicitly. Nothing in this
 * fixture relies on decode-time inference.
 */
import type { CanvasDoc, TextNode } from "../../src/shared/canvas";
import { agentTextNode, canvasDoc, tasksNode } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const board = (
  id: string,
  label: string,
  x: number,
  y: number,
  admission?: "approval",
): TextNode => {
  const node = tasksNode({ id, x, y, items: [] });
  return {
    ...node,
    text: label,
    ether: {
      ...node.ether,
      entity: { kind: "task", name: label },
      tasks: {
        items: [],
        name: label,
        ...(admission
          ? { contract: { incoming: { admission } } }
          : {}),
      },
    },
  };
};

const fixture = (): CanvasDoc =>
  canvasDoc(
    [
      board("intake", "Intake", 80, 220),
      board("build", "Build", 420, 80),
      board("review", "Review", 420, 360, "approval"),
      board("ship", "Ship", 760, 220),
      agentTextNode({
        id: "worker",
        key: "local:worker",
        label: "worker",
        x: 80,
        y: 480,
      }),
    ],
    [
      { id: "f-intake-build", fromNode: "intake", toNode: "build", ether: { verb: "feeds" } },
      { id: "f-intake-review", fromNode: "intake", toNode: "review", ether: { verb: "feeds" } },
      { id: "f-build-ship", fromNode: "build", toNode: "ship", ether: { verb: "feeds" } },
      { id: "f-review-ship", fromNode: "review", toNode: "ship", ether: { verb: "feeds" } },
      { id: "w-intake", fromNode: "worker", toNode: "intake", ether: { verb: "contributes" } },
      { id: "w-build", fromNode: "worker", toNode: "build", ether: { verb: "contributes" } },
      { id: "w-review", fromNode: "worker", toNode: "review", ether: { verb: "contributes" } },
      { id: "w-ship", fromNode: "worker", toNode: "ship", ether: { verb: "contributes" } },
    ],
  );

type AnyTask = {
  readonly id: string;
  readonly state: string;
  readonly claimedBy?: string;
  readonly history: ReadonlyArray<{
    readonly parts: ReadonlyArray<{ readonly kind: string; readonly text?: string }>;
  }>;
  readonly rules?: ReadonlyArray<{ readonly id: string; readonly board: string }>;
  readonly reason?: string;
  readonly raisedBy?: unknown;
  readonly epoch?: number;
  readonly visits?: ReadonlyArray<{
    readonly board: string;
    readonly enteredAt: string;
    readonly epoch: number;
    readonly claimedBy?: string;
    readonly exitedAt?: string;
    readonly exit?: string;
    readonly next?: string;
    readonly handoffNote?: string;
  }>;
  readonly defects?: ReadonlyArray<{ readonly epoch: number; readonly target: string; readonly at: string }>;
  readonly waitUntil?: string;
  readonly checkResults?: ReadonlyArray<unknown>;
  readonly dependsOn?: ReadonlyArray<string>;
  readonly admission?: string;
  readonly completionEvidence?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

test("task path carries exact data through fork, defect, gate, converge, and close", async () => {
  test.setTimeout(180_000);
  const junto = await launchJunto({
    seedCanvases: { factory: fixture() },
  });

  try {
    const { page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

    const readTask = (nodeId: string, taskId: string) =>
      page.evaluate(
        async ([node, id]) => {
          const read = await window.junto!.readCanvas("factory");
          return (read.doc.nodes
            .find((candidate) => candidate.id === node)
            ?.ether?.tasks?.items.find((task) => task.id === id) ?? null) as unknown;
        },
        [nodeId, taskId] as const,
      ) as Promise<AnyTask | null>;

    // ---- birth ------------------------------------------------------------
    const created = await page.evaluate(async () => {
      const api = window.junto!;
      return api.workTaskCreate(
        "factory",
        "intake",
        "Cut the release",
        { details: "Prove the task path carries exact data." },
        "release readiness",
        undefined,
        undefined,
        undefined,
        [{ id: "c-ship", text: "cite the build receipt", board: "ship" }],
      );
    });
    expect(created).toMatchObject({ ok: true });
    const taskId = (created as { data: { id: string } }).data.id;

    const birth = await readTask("intake", taskId);
    expect(birth).toMatchObject({
      state: "submitted",
      reason: "release readiness",
      rules: [{ id: "c-ship", board: "ship" }],
    });
    expect(birth?.claimedBy).toBeUndefined();
    expect(birth?.visits ?? []).toHaveLength(0);
    expect(birth?.epoch ?? 0).toBe(0);
    expect(birth?.history[0]?.parts.some((part) => part.text?.includes("Cut the release"))).toBe(true);

    // ---- claim at intake ---------------------------------------------------
    const claimIntake = await page.evaluate(
      ([id]) => window.junto!.workTaskClaim("factory", "intake", id, "worker"),
      [taskId] as const,
    );
    expect(claimIntake).toMatchObject({ ok: true });
    const working = await readTask("intake", taskId);
    expect(working?.state).toBe("working");
    const seatId = working?.claimedBy;
    expect(typeof seatId).toBe("string");
    expect(seatId).toMatch(/^seat_/);

    // ---- send on: fork demands an explicit next ---------------------------
    const forkless = await page.evaluate(
      ([id]) =>
        window.junto!.workTaskTransition(
          "factory", "intake", id, "completed", "done at intake", { artifacts: [] },
        ),
      [taskId] as const,
    );
    expect(forkless).toMatchObject({ ok: false });

    const toBuild = await page.evaluate(
      ([id]) =>
        window.junto!.workTaskTransition(
          "factory", "intake", id, "completed", "intake accepted", { artifacts: [] },
          { next: "build", handoffNote: "intake accepted" },
        ),
      [taskId] as const,
    );
    expect(toBuild).toMatchObject({ ok: true });

    const intakeAfterSendOn = await readTask("intake", taskId);
    expect(intakeAfterSendOn).toMatchObject({ state: "completed" });
    expect(intakeAfterSendOn?.completionEvidence).toBeDefined();
    expect(intakeAfterSendOn?.visits?.at(-1)).toMatchObject({
      board: "intake",
      epoch: 0,
      exit: "sent-on",
      next: "build",
      handoffNote: "intake accepted",
      claimedBy: seatId,
    });
    expect(intakeAfterSendOn?.visits?.at(-1)?.exitedAt).toBeDefined();

    const atBuild = await readTask("build", taskId);
    expect(atBuild).toMatchObject({
      id: taskId,
      state: "submitted",
      epoch: 0,
      rules: [{ id: "c-ship", board: "ship" }],
    });
    expect(atBuild?.claimedBy).toBeUndefined();
    expect(atBuild?.completionEvidence).toBeUndefined();
    expect(atBuild?.dependsOn).toBeUndefined();
    expect(atBuild?.checkResults).toBeUndefined();
    expect(atBuild?.admission).toBeUndefined();
    expect(atBuild?.visits?.map((p) => [p.board, p.exit ?? "open"])).toEqual([
      ["intake", "sent-on"],
      ["build", "open"],
    ]);
    // Entry thread: authored brief plus the re-home marker, nothing else.
    expect(atBuild?.history).toHaveLength(2);
    expect(
      atBuild?.history[1]?.parts.some((part) => part.text?.includes('sent on from "intake"')),
    ).toBe(true);

    // ---- send back to intake ----------------------------------------------
    const claimBuild = await page.evaluate(
      ([id]) => window.junto!.workTaskClaim("factory", "build", id, "worker"),
      [taskId] as const,
    );
    expect(claimBuild).toMatchObject({ ok: true });

    const defect = await page.evaluate(
      ([id]) =>
        window.junto!.workTaskTransition(
          "factory", "build", id, "rejected", "wrong artifact shape", undefined,
          { defect: { summary: "the intake brief chose the wrong artifact" } },
        ),
      [taskId] as const,
    );
    expect(defect).toMatchObject({ ok: true });

    const rejectedAtBuild = await readTask("build", taskId);
    expect(rejectedAtBuild?.state).toBe("rejected");
    expect(rejectedAtBuild?.completionEvidence).toBeUndefined();
    expect(rejectedAtBuild?.visits?.at(-1)).toMatchObject({
      board: "build",
      exit: "sent-back",
      next: "intake",
    });

    const backAtIntake = await readTask("intake", taskId);
    expect(backAtIntake).toMatchObject({ state: "submitted", epoch: 1 });
    expect(backAtIntake?.defects?.at(-1)).toMatchObject({ epoch: 1, target: "intake" });
    expect(backAtIntake?.defects?.at(-1)?.at).toBeDefined();
    expect(
      backAtIntake?.history.some((message) =>
        message.parts.some((part) =>
          part.text?.includes("the intake brief chose the wrong artifact"),
        ),
      ),
    ).toBe(true);

    // ---- re-claim, send on down the other fork arm ------------------------
    const reclaim = await page.evaluate(
      ([id]) => window.junto!.workTaskClaim("factory", "intake", id, "worker"),
      [taskId] as const,
    );
    expect(reclaim).toMatchObject({ ok: true });
    const toReview = await page.evaluate(
      ([id]) =>
        window.junto!.workTaskTransition(
          "factory", "intake", id, "completed", "redone for review", { artifacts: [] },
          { next: "review", handoffNote: "redone for review" },
        ),
      [taskId] as const,
    );
    expect(toReview).toMatchObject({ ok: true });

    // ---- approval gate at review ------------------------------------------
    const gatedClaim = await page.evaluate(
      ([id]) => window.junto!.workTaskClaim("factory", "review", id, "worker"),
      [taskId] as const,
    );
    expect(gatedClaim).toMatchObject({ ok: false });
    expect(JSON.stringify(gatedClaim)).toContain("approval");

    const promote = await page.evaluate(
      ([id]) => window.junto!.workTaskPromote("factory", "review", id, "reviewed the redo"),
      [taskId] as const,
    );
    expect(promote).toMatchObject({ ok: true });

    const promotedClaim = await page.evaluate(
      ([id]) => window.junto!.workTaskClaim("factory", "review", id, "worker"),
      [taskId] as const,
    );
    expect(promotedClaim).toMatchObject({ ok: true });

    // ---- converge onto ship; the approval marker must NOT travel ----------
    const toShip = await page.evaluate(
      ([id]) =>
        window.junto!.workTaskTransition(
          "factory", "review", id, "completed", "review accepted", { artifacts: [] },
          { next: "ship", handoffNote: "review accepted" },
        ),
      [taskId] as const,
    );
    expect(toShip).toMatchObject({ ok: true });

    const atShip = await readTask("ship", taskId);
    expect(atShip).toMatchObject({ state: "submitted", epoch: 1 });
    expect(atShip?.claimedBy).toBeUndefined();
    // Approval is per-board: the review approval marker may not re-home.
    expect(
      JSON.stringify(atShip?.metadata ?? {}),
    ).not.toContain("approvedEpoch");

    // ---- terminal close at ship -------------------------------------------
    const claimShip = await page.evaluate(
      ([id]) => window.junto!.workTaskClaim("factory", "ship", id, "worker"),
      [taskId] as const,
    );
    expect(claimShip).toMatchObject({ ok: true });
    // The board-addressed rule gates the close: refusing an unanswered
    // rule is the product requirement this spec exists to prove.
    const unanswered = await page.evaluate(
      ([id]) =>
        window.junto!.workTaskTransition(
          "factory", "ship", id, "completed", "shipped", { artifacts: [] },
        ),
      [taskId] as const,
    );
    expect(unanswered).toMatchObject({ ok: false });
    expect(JSON.stringify(unanswered)).toContain("c-ship");

    const close = await page.evaluate(
      ([id]) =>
        window.junto!.workTaskTransition(
          "factory", "ship", id, "completed", "shipped",
          {
            artifacts: [],
            claims: [
              {
                ruleId: "c-ship",
                text: "build receipt cited",
                refs: ["receipt://build/1"],
              },
            ],
          },
        ),
      [taskId] as const,
    );
    expect(close).toMatchObject({ ok: true });

    const closed = await readTask("ship", taskId);
    expect(closed?.state).toBe("completed");
    expect(closed?.completionEvidence).toBeDefined();
    // The whole visit list, in order, with per-visit exits and epochs.
    expect(
      closed?.visits?.map((p) => [p.board, p.exit ?? "open", p.epoch]),
    ).toEqual([
      ["intake", "sent-on", 0],
      ["build", "sent-back", 0],
      ["intake", "sent-on", 1],
      ["review", "sent-on", 1],
      ["ship", "completed", 1],
    ]);
    expect(closed?.visits?.at(-1)).toMatchObject({ claimedBy: seatId });
    expect(closed?.visits?.every((p) => p.enteredAt !== undefined)).toBe(true);
    expect(closed?.visits?.every((p) => p.exitedAt !== undefined)).toBe(true);

    // ---- the rendered visits ----------------------------------------------
    const shipNode = page.locator('.react-flow__node[data-id="ship"]');
    await expect(shipNode).toBeVisible({ timeout: 30_000 });
    await shipNode.getByTestId("tasks-card").dispatchEvent("dblclick");
    const board = page.getByRole("dialog", { name: "Task board" });
    await expect(board).toBeVisible();
    await board.getByLabel("Open details for Cut the release").click();
    const details = board.getByRole("complementary", {
      name: "Details for Cut the release",
    });
    await expect(details.locator('[data-testid^="task-visits-layer-"]')).toHaveCount(5);
    // Layer ordinals are 1-based, in visit order.
    await expect(details.locator('[data-testid="task-visits-layer-1"]')).toContainText("Intake");
    await expect(details.locator('[data-testid="task-visits-layer-2"]')).toContainText("Build");
    await expect(details.locator('[data-testid="task-visits-layer-5"]')).toContainText("Ship");
  } finally {
    await junto.close();
  }
});
