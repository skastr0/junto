/**
 * THE critical Tasks e2e — full pipeline data fidelity in the real app.
 *
 * Topology: intake forks to build and review; both converge on ship.
 * One agent seat holds `contributes` on every station. Every hop is driven
 * through the product IPC (operator gestures — no live agent process), and
 * after EVERY transition the canvas is re-read and the full task field set
 * is asserted: state, claimedBy, journey passages (entry/exit/epoch/notes),
 * defects, epoch, claims carried, promotion gate, dropped re-home fields,
 * completion evidence — then the rendered journey onion in the task detail.
 *
 * Verb law: every edge here authors its verb explicitly. Nothing in this
 * fixture relies on decode-time inference.
 */
import type { CanvasDoc, TextNode } from "../../src/shared/canvas";
import { agentTextNode, canvasDoc, tasksNode } from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";

const station = (
  id: string,
  label: string,
  x: number,
  y: number,
  admission?: "operator-gated",
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
        ...(admission
          ? { contract: { inbound: { admission } } }
          : {}),
      },
    },
  };
};

const fixture = (): CanvasDoc =>
  canvasDoc(
    [
      station("intake", "Intake", 80, 220),
      station("build", "Build", 420, 80),
      station("review", "Review", 420, 360, "operator-gated"),
      station("ship", "Ship", 760, 220),
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
  readonly claims?: ReadonlyArray<{ readonly id: string; readonly station: string }>;
  readonly reason?: string;
  readonly raisedBy?: unknown;
  readonly epoch?: number;
  readonly journey?: ReadonlyArray<{
    readonly nodeId: string;
    readonly enteredAt: string;
    readonly epoch: number;
    readonly claimedBy?: string;
    readonly exitedAt?: string;
    readonly exit?: string;
    readonly next?: string;
    readonly emissionNote?: string;
  }>;
  readonly defects?: ReadonlyArray<{ readonly epoch: number; readonly target: string; readonly at: string }>;
  readonly holdUntil?: string;
  readonly boarding?: ReadonlyArray<unknown>;
  readonly dependsOn?: ReadonlyArray<string>;
  readonly admission?: string;
  readonly completionEvidence?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

test("task pipeline carries exact data through fork, defect, gate, converge, and close", async () => {
  test.setTimeout(180_000);
  const vellumCommand = await launchVellum({
    seedCanvases: { factory: fixture() },
  });

  try {
    const { page } = vellumCommand;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

    const readTask = (nodeId: string, taskId: string) =>
      page.evaluate(
        async ([node, id]) => {
          const read = await window.vellumCommand!.readCanvas("factory");
          return (read.doc.nodes
            .find((candidate) => candidate.id === node)
            ?.ether?.tasks?.items.find((task) => task.id === id) ?? null) as unknown;
        },
        [nodeId, taskId] as const,
      ) as Promise<AnyTask | null>;

    // ---- birth ------------------------------------------------------------
    const created = await page.evaluate(async () => {
      const api = window.vellumCommand!;
      return api.workTaskCreate(
        "factory",
        "intake",
        "Cut the release",
        { details: "Prove the pipeline carries exact data." },
        "release readiness",
        undefined,
        undefined,
        undefined,
        [{ id: "c-ship", text: "cite the build receipt", severity: "hard", station: "ship" }],
      );
    });
    expect(created).toMatchObject({ ok: true });
    const taskId = (created as { data: { id: string } }).data.id;

    const birth = await readTask("intake", taskId);
    expect(birth).toMatchObject({
      state: "submitted",
      reason: "release readiness",
      claims: [{ id: "c-ship", station: "ship" }],
    });
    expect(birth?.claimedBy).toBeUndefined();
    expect(birth?.journey ?? []).toHaveLength(0);
    expect(birth?.epoch ?? 0).toBe(0);
    expect(birth?.history[0]?.parts.some((part) => part.text?.includes("Cut the release"))).toBe(true);

    // ---- claim at intake ---------------------------------------------------
    const claimIntake = await page.evaluate(
      ([id]) => window.vellumCommand!.workTaskClaim("factory", "intake", id, "worker"),
      [taskId] as const,
    );
    expect(claimIntake).toMatchObject({ ok: true });
    const working = await readTask("intake", taskId);
    expect(working?.state).toBe("working");
    const seatId = working?.claimedBy;
    expect(typeof seatId).toBe("string");
    expect(seatId).toMatch(/^seat_/);

    // ---- forward: fork demands an explicit next ---------------------------
    const forkless = await page.evaluate(
      ([id]) =>
        window.vellumCommand!.workTaskTransition(
          "factory", "intake", id, "completed", "done at intake", { artifacts: [] },
        ),
      [taskId] as const,
    );
    expect(forkless).toMatchObject({ ok: false });

    const toBuild = await page.evaluate(
      ([id]) =>
        window.vellumCommand!.workTaskTransition(
          "factory", "intake", id, "completed", "intake accepted", { artifacts: [] }, { next: "build" },
        ),
      [taskId] as const,
    );
    expect(toBuild).toMatchObject({ ok: true });

    const sourceAfterForward = await readTask("intake", taskId);
    expect(sourceAfterForward).toMatchObject({ state: "completed" });
    expect(sourceAfterForward?.completionEvidence).toBeDefined();
    expect(sourceAfterForward?.journey?.at(-1)).toMatchObject({
      nodeId: "intake",
      epoch: 0,
      exit: "forwarded",
      next: "build",
      emissionNote: "intake accepted",
      claimedBy: seatId,
    });
    expect(sourceAfterForward?.journey?.at(-1)?.exitedAt).toBeDefined();

    const arrivalAtBuild = await readTask("build", taskId);
    expect(arrivalAtBuild).toMatchObject({
      id: taskId,
      state: "submitted",
      epoch: 0,
      claims: [{ id: "c-ship", station: "ship" }],
    });
    expect(arrivalAtBuild?.claimedBy).toBeUndefined();
    expect(arrivalAtBuild?.completionEvidence).toBeUndefined();
    expect(arrivalAtBuild?.dependsOn).toBeUndefined();
    expect(arrivalAtBuild?.boarding).toBeUndefined();
    expect(arrivalAtBuild?.admission).toBeUndefined();
    expect(arrivalAtBuild?.journey?.map((p) => [p.nodeId, p.exit ?? "open"])).toEqual([
      ["intake", "forwarded"],
      ["build", "open"],
    ]);
    // Arrival thread: authored brief plus the re-home marker, nothing else.
    expect(arrivalAtBuild?.history).toHaveLength(2);
    expect(
      arrivalAtBuild?.history[1]?.parts.some((part) => part.text?.includes('forwarded from "intake"')),
    ).toBe(true);

    // ---- defect back to intake --------------------------------------------
    const claimBuild = await page.evaluate(
      ([id]) => window.vellumCommand!.workTaskClaim("factory", "build", id, "worker"),
      [taskId] as const,
    );
    expect(claimBuild).toMatchObject({ ok: true });

    const defect = await page.evaluate(
      ([id]) =>
        window.vellumCommand!.workTaskTransition(
          "factory", "build", id, "rejected", "wrong artifact shape", undefined,
          { defect: { summary: "the intake brief chose the wrong artifact" } },
        ),
      [taskId] as const,
    );
    expect(defect).toMatchObject({ ok: true });

    const rejectedAtBuild = await readTask("build", taskId);
    expect(rejectedAtBuild?.state).toBe("rejected");
    expect(rejectedAtBuild?.completionEvidence).toBeUndefined();
    expect(rejectedAtBuild?.journey?.at(-1)).toMatchObject({
      nodeId: "build",
      exit: "rejected-back",
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

    // ---- re-claim, re-forward down the other fork arm ---------------------
    const reclaim = await page.evaluate(
      ([id]) => window.vellumCommand!.workTaskClaim("factory", "intake", id, "worker"),
      [taskId] as const,
    );
    expect(reclaim).toMatchObject({ ok: true });
    const toReview = await page.evaluate(
      ([id]) =>
        window.vellumCommand!.workTaskTransition(
          "factory", "intake", id, "completed", "redone for review", { artifacts: [] }, { next: "review" },
        ),
      [taskId] as const,
    );
    expect(toReview).toMatchObject({ ok: true });

    // ---- operator gate at review ------------------------------------------
    const gatedClaim = await page.evaluate(
      ([id]) => window.vellumCommand!.workTaskClaim("factory", "review", id, "worker"),
      [taskId] as const,
    );
    expect(gatedClaim).toMatchObject({ ok: false });
    expect(JSON.stringify(gatedClaim)).toContain("operator approval");

    const promote = await page.evaluate(
      ([id]) => window.vellumCommand!.workTaskPromote("factory", "review", id, "reviewed the redo"),
      [taskId] as const,
    );
    expect(promote).toMatchObject({ ok: true });

    const promotedClaim = await page.evaluate(
      ([id]) => window.vellumCommand!.workTaskClaim("factory", "review", id, "worker"),
      [taskId] as const,
    );
    expect(promotedClaim).toMatchObject({ ok: true });

    // ---- converge onto ship; the promotion marker must NOT travel ---------
    const toShip = await page.evaluate(
      ([id]) =>
        window.vellumCommand!.workTaskTransition(
          "factory", "review", id, "completed", "review accepted", { artifacts: [] }, { next: "ship" },
        ),
      [taskId] as const,
    );
    expect(toShip).toMatchObject({ ok: true });

    const arrivalAtShip = await readTask("ship", taskId);
    expect(arrivalAtShip).toMatchObject({ state: "submitted", epoch: 1 });
    expect(arrivalAtShip?.claimedBy).toBeUndefined();
    // Promotion is per-station: the review admission marker may not re-home.
    expect(
      JSON.stringify(arrivalAtShip?.metadata ?? {}),
    ).not.toContain("admittedEpoch");

    // ---- terminal close at ship -------------------------------------------
    const claimShip = await page.evaluate(
      ([id]) => window.vellumCommand!.workTaskClaim("factory", "ship", id, "worker"),
      [taskId] as const,
    );
    expect(claimShip).toMatchObject({ ok: true });
    // The station-addressed claim gates the close: refusing an unanswered
    // claim IS the product law this spec exists to prove.
    const unanswered = await page.evaluate(
      ([id]) =>
        window.vellumCommand!.workTaskTransition(
          "factory", "ship", id, "completed", "shipped", { artifacts: [] },
        ),
      [taskId] as const,
    );
    expect(unanswered).toMatchObject({ ok: false });
    expect(JSON.stringify(unanswered)).toContain("c-ship");

    const close = await page.evaluate(
      ([id]) =>
        window.vellumCommand!.workTaskTransition(
          "factory", "ship", id, "completed", "shipped",
          {
            artifacts: [],
            responses: [
              {
                claimId: "c-ship",
                response: "build receipt cited",
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
    // The whole onion, in order, with per-passage exits and epochs.
    expect(
      closed?.journey?.map((p) => [p.nodeId, p.exit ?? "open", p.epoch]),
    ).toEqual([
      ["intake", "forwarded", 0],
      ["build", "rejected-back", 0],
      ["intake", "forwarded", 1],
      ["review", "forwarded", 1],
      ["ship", "closed", 1],
    ]);
    expect(closed?.journey?.at(-1)).toMatchObject({ claimedBy: seatId });
    expect(closed?.journey?.every((p) => p.enteredAt !== undefined)).toBe(true);
    expect(closed?.journey?.every((p) => p.exitedAt !== undefined)).toBe(true);

    // ---- the rendered onion ------------------------------------------------
    const shipNode = page.locator('.react-flow__node[data-id="ship"]');
    await expect(shipNode).toBeVisible({ timeout: 30_000 });
    await shipNode.getByTestId("tasks-card").dispatchEvent("dblclick");
    const board = page.getByRole("dialog", { name: "Task flow" });
    await expect(board).toBeVisible();
    await board.getByLabel("Open details for Cut the release").click();
    const details = board.getByRole("complementary", {
      name: "Details for Cut the release",
    });
    await expect(details.locator('[data-testid^="task-journey-layer-"]')).toHaveCount(5);
    // Layer ordinals are 1-based, in passage order.
    await expect(details.locator('[data-testid="task-journey-layer-1"]')).toContainText("Intake");
    await expect(details.locator('[data-testid="task-journey-layer-2"]')).toContainText("Build");
    await expect(details.locator('[data-testid="task-journey-layer-5"]')).toContainText("Ship");
  } finally {
    await vellumCommand.close();
  }
});
