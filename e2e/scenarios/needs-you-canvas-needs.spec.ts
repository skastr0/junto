/**
 * Needs-you: what only the canvas knows reaches the feed.
 *   bun run test:e2e:fast e2e/scenarios/needs-you-canvas-needs.spec.ts
 *
 * The top bar popover used to be the only place a work stoppage showed. It
 * is gone, so the feed must carry those needs. Real work is seeded through
 * the work repository, the way main writes it: a task Atlas claimed and then
 * left waiting on the operator (the stoppage, which holds Atlas up), and an
 * open request on a requests sink (a sink that wants input). Both are written
 * with origin times in the past, before the app has ever started: the app
 * that shows them never saw them begin, as after a quit and relaunch, so the
 * only place the times can come from is the journal.
 *
 * Asserts:
 *   - the stoppage, the held seat and the sink each appear as a feed row, in their region
 *   - the top bar button counts them, and its number is the feed header's
 *   - the button toggles the feed and no popover exists
 *   - each row shows the time its need truly began, on first launch and after a reload
 */
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import type { Locator } from "@playwright/test";
import type { GroupNode, TextNode } from "../../src/shared/canvas";
import { CanvasesLive, CanvasesService } from "../../src/main/junto/canvases";
import { makeStateEngineLive } from "../../src/main/junto/state/engine";
import { SettingsLive } from "../../src/main/junto/settings/service";
import { compileActorSeatRegistry } from "../../src/main/junto/station/actor-seat-compiler";
import { StationFleetTargetRepositoryLive } from "../../src/main/junto/station/fleet-target-repository";
import { StationRepository, StationRepositoryLive } from "../../src/main/junto/station/repository";
import {
  createAuthorialTaskDependencyScopeCapability,
  WorkRepository,
  WorkRepositoryLive,
} from "../../src/main/junto/work/repository";
import { IntentFactBasis } from "../../src/shared/work-protocol";
import { agentTextNode, canvasDoc, verbEdge, type Sandbox } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const CANVAS = "needs-you-canvas";
// When each need began, well before this app process exists.
const STOPPED_AT = Date.now() - 47 * 60_000;
const ASKED_AT = Date.now() - 12 * 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const ops: GroupNode = { id: "ops", type: "group", label: "Ops", x: 0, y: 0, width: 760, height: 360 };
const atlas: TextNode = agentTextNode({ id: "atlas", key: "local:e2e-needs-atlas", label: "Atlas", harness: "claude", x: 40, y: 80 });
const asks: TextNode = {
  id: "asks",
  type: "text",
  text: "requests",
  x: 1000,
  y: 80,
  width: 240,
  height: 120,
  ether: { entity: { kind: "requests" }, requests: { items: [] } },
};
const board: TextNode = {
  id: "board",
  type: "text",
  text: "tasks",
  x: 400,
  y: 80,
  width: 240,
  height: 120,
  ether: { entity: { kind: "task" }, host: "local", tasks: { items: [] } },
};
const nodes = [ops, atlas, board, asks];
const doc = canvasDoc(nodes, [verbEdge("e-atlas-board", "atlas", "board", "contributes", nodes)]);

/** Atlas's claimed task waiting on the operator, and an open request Atlas raised. */
const seedWork = async (sandbox: Sandbox): Promise<void> => {
  const previous = process.env.JUNTO_CANVASES_DIR;
  process.env.JUNTO_CANVASES_DIR = sandbox.canvasesDir;
  const state = makeStateEngineLive(join(sandbox.homeDir, ".junto", "state", "junto.db"));
  const repositories = Layer.provideMerge(
    Layer.mergeAll(WorkRepositoryLive, StationRepositoryLive, SettingsLive, StationFleetTargetRepositoryLive),
    state,
  );
  const runtime = ManagedRuntime.make(Layer.provideMerge(CanvasesLive, repositories));
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const canvases = yield* CanvasesService;
        const work = yield* WorkRepository;
        const installationId = yield* (yield* StationRepository).installationId;
        const authority = yield* canvases.authorityMaterialSnapshot();
        const basis = Schema.decodeUnknownSync(IntentFactBasis, { onExcessProperty: "error" })({
          kind: "authorial-intent",
          generation: authority.generation,
          contentSha256: authority.intentSha256,
        });
        const seat = compileActorSeatRegistry(new Map([[CANVAS, doc]]), new Map([["local", installationId]])).find(
          (candidate) => candidate.refs.some((ref) => ref.nodeId === atlas.id),
        );
        if (!seat) throw new Error("fixture: Atlas did not compile to an actor seat");
        const actor = { seatId: seat.seatId, canvasName: CANVAS, nodeId: atlas.id };
        const boardSink = { canvasName: CANVAS, nodeId: board.id };
        const dependencyScope = createAuthorialTaskDependencyScopeCapability({ authority, authoringSink: boardSink });
        yield* work.createTask({
          sink: boardSink,
          basis,
          dependencyScope,
          task: {
            id: "task-migration",
            state: "submitted",
            history: [
              { messageId: "msg-task-migration", role: "user", parts: [{ kind: "text", text: "Run the accounts migration." }] },
            ],
          },
          originAt: iso(STOPPED_AT - 30 * 60_000),
          receivedAt: iso(STOPPED_AT - 30 * 60_000),
        });
        yield* work.claimLocalTask({
          sink: boardSink,
          basis,
          dependencyScope,
          taskId: "task-migration",
          actor,
          originAt: iso(STOPPED_AT - 20 * 60_000),
          receivedAt: iso(STOPPED_AT - 20 * 60_000),
        });
        yield* work.transitionTask({
          sink: boardSink,
          basis,
          taskId: "task-migration",
          state: "input-required",
          originAt: iso(STOPPED_AT),
          receivedAt: iso(STOPPED_AT),
        });
        yield* work.createRequest({
          sink: { canvasName: CANVAS, nodeId: asks.id },
          basis,
          raisedBy: { seatId: seat.seatId, canvasName: CANVAS, nodeId: atlas.id },
          request: {
            id: "req-staging-password",
            state: "input-required",
            claimedBy: seat.seatId,
            history: [
              {
                messageId: "msg-req-staging-password",
                role: "agent",
                parts: [{ kind: "text", text: "I need the staging database password to run the migration." }],
              },
            ],
          },
          originAt: iso(ASKED_AT),
          receivedAt: iso(ASKED_AT),
        });
      }),
    );
  } finally {
    await runtime.dispose();
    if (previous === undefined) delete process.env.JUNTO_CANVASES_DIR;
    else process.env.JUNTO_CANVASES_DIR = previous;
  }
};

test("a work stoppage, the seat it holds up and a sink wanting input are feed rows, counted, and show when they truly began", async () => {
  const junto = await launchJunto({ seedCanvases: { [CANVAS]: doc }, afterSeed: seedWork });
  try {
    const { page } = junto;
    await expect(page.locator(".react-flow__node", { hasText: "Atlas" })).toBeVisible({ timeout: 30_000 });

    // The button carries the count; there is no number in the label at zero.
    const trigger = page.getByTestId("operator-feed-trigger");
    await expect(trigger).toHaveAttribute("aria-label", "Needs you, 3", { timeout: 20_000 });
    await expect(trigger.locator(".operator-feed-trigger__count")).toHaveText("3");

    // Pressing it opens the feed itself: the popover is gone.
    await trigger.click();
    const modal = page.locator('[data-layer="operator"][data-operator-modal="feed"]');
    await expect(modal).toBeVisible();
    await expect(page.getByTestId("needs-you-inbox")).toHaveCount(0);
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(modal.locator(".operator-feed__status")).toHaveText("3 waiting across 2 regions");
    const regionOf = (itemId: string): Locator =>
      modal.locator(".operator-feed__region", { has: page.locator(`[data-item-id='${itemId}']`) });

    // The stoppage: the task sink whose claimed task waits on the operator.
    const stoppage = modal.locator("[data-item-id='stoppage:board']");
    await expect(stoppage).toHaveAttribute("data-kind", "blocked");
    await expect(stoppage).toContainText("holding up 1 other");
    await expect(regionOf("stoppage:board").locator(".operator-feed__region-label")).toHaveText("Ops");

    // The held node: the seat that work stops, in its region.
    const held = modal.locator("[data-item-id='held:atlas']");
    await expect(held).toHaveAttribute("data-kind", "blocked");
    await expect(held.locator(".operator-feed__kind")).toHaveText("blocked");
    await expect(held).toContainText("waiting on blocked work upstream");
    await expect(regionOf("held:atlas").locator(".operator-feed__region-label")).toHaveText("Ops");

    // The requests sink that wants input, outside every region.
    const input = modal.locator("[data-item-id='input:asks']");
    await expect(input).toHaveAttribute("data-kind", "attention");
    await expect(input.locator(".operator-feed__kind")).toHaveText("needs input");
    await expect(regionOf("input:asks")).toHaveAttribute("data-open-field", "true");
    // Urgency first: both blocked rows come before the needs input row.
    await expect(modal.getByTestId("operator-feed-card")).toHaveCount(3);
    await expect(modal.getByTestId("operator-feed-card").last()).toHaveAttribute("data-item-id", "input:asks");

    // The same press closes it, like the chord.
    await trigger.dispatchEvent("click");
    await expect(modal).toHaveCount(0);
    await expect(trigger).toHaveAttribute("aria-expanded", "false");

    // Each row says when its need truly began: the stoppage and the seat it
    // holds up since the task started waiting, the sink since the request.
    const began: ReadonlyArray<readonly [string, number]> = [
      ["stoppage:board", STOPPED_AT],
      ["held:atlas", STOPPED_AT],
      ["input:asks", ASKED_AT],
    ];
    const expectTrueTimes = async (): Promise<void> => {
      for (const [id, at] of began) {
        const row = modal.locator(`[data-item-id='${id}'] time`);
        // The tooltip layer may have moved the title into its own attribute.
        const said = await row.evaluate((time) => time.getAttribute("title") ?? time.getAttribute("data-junto-tooltip"));
        expect(said).toBe(await page.evaluate((ms) => new Date(ms).toLocaleString(), at));
      }
      await expect(modal.locator("[data-item-id='stoppage:board'] time")).toHaveText(/^4[78]m$/);
      await expect(modal.locator("[data-item-id='input:asks'] time")).toHaveText(/^1[23]m$/);
    };
    await trigger.click();
    await expectTrueTimes();
    await page.keyboard.press("Escape");

    // A reload reads the same journal: nothing is restamped as now.
    await page.reload();
    await expect(page.locator(".react-flow__node", { hasText: "Atlas" })).toBeVisible({ timeout: 30_000 });
    await expect(trigger).toHaveAttribute("aria-label", "Needs you, 3", { timeout: 20_000 });
    await trigger.click();
    await expectTrueTimes();
  } finally {
    await junto.close();
  }
});
