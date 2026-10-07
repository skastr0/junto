/**
 * Everything a seat can show on the canvas, captured for design review: each
 * state at rest, then one seat selected, then bubbles. Frames land in
 * test-results/seat-states/.
 *   bun run test:e2e:fast e2e/scenarios/canvas-seat-states.spec.ts
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "seat-states");
const CANVAS = "seat-states";

/** id, name, seat state. Declared signals are staged apart, below. */
const seats = [
  ["resting", "resting", "idle"],
  ["working", "working", "working"],
  ["input", "product-automation", "attention"],
  ["done", "done unread", "done"],
  ["escalate", "raised a hand", "idle"],
  ["blocked", "blocked on you", "idle"],
  ["review", "ready for review", "idle"],
  ["long", "a seat with quite a long name", "attention"],
] as const;

const nodes = seats.map(([id, label], index) =>
  agentTextNode({
    id,
    key: `local:e2e-state-${id}`,
    label,
    x: 40 + (index % 4) * 260,
    y: 40 + Math.floor(index / 4) * 150,
  }),
);

const seatEvents = (at: number) =>
  seats.flatMap(([id, , state]) => {
    const event = (value: string, offset: number) => ({
      bindingId: `local:e2e-state-${id}`,
      epoch: "e2e",
      state: value,
      reason:
        value === "idle" ? "rule:empty_prompt_idle" : value === "attention" ? "rule:approval_prompt" : "rule:osc_title_working",
      confidence: "high",
      at: at + offset,
    });
    // Done is a turn that ended and nobody has read.
    return state === "done" ? [event("working", 0), event("idle", 1)] : [event(state, 0)];
  });

const signalEvents = (at: number) =>
  (
    [
      ["escalate", "escalate", "two specs disagree on ids"],
      ["blocked", "blocked", "needs the staging key"],
      ["review", "feedback", "draft ready, worth a look"],
    ] as const
  ).map(([nodeId, kind, text]) => ({
    signalId: `e2e-${nodeId}`,
    canvasName: CANVAS,
    nodeId,
    kind,
    text,
    createdAt: at,
    state: "open",
  }));

test("every seat state, at rest, selected and speaking", async () => {
  await mkdir(SHOTS, { recursive: true });
  const junto = await launchJunto({ seedCanvases: { [CANVAS]: canvasDoc(nodes, []) } });
  try {
    const { page } = junto;
    const seat = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
    await expect(seat("input")).toBeVisible({ timeout: 30_000 });
    const stagedAt = Date.now();
    await junto.app.evaluate(
      ({ BrowserWindow }, { seatsNow, signalsNow }) => {
        for (const window of BrowserWindow.getAllWindows()) {
          for (const event of seatsNow) window.webContents.send("junto:agent-seat-state-changed", event);
          for (const event of signalsNow) window.webContents.send("junto:agent-signal", event);
        }
      },
      { seatsNow: seatEvents(stagedAt), signalsNow: signalEvents(stagedAt) },
    );
    await page.getByRole("button", { name: /fit all/i }).first().click();
    await page.waitForTimeout(900);
    // No status chip rides a seat: the ring and the line say it once.
    await expect(page.locator(".junto-node__status-rail")).toHaveCount(0);

    await page.locator(".react-flow").screenshot({ path: join(SHOTS, "canvas.png") });
    for (const [id] of seats) {
      const box = await seat(id).boundingBox();
      if (!box) throw new Error(`seat ${id} has no box`);
      // Room around the seat, so anything that sticks out of it is in frame.
      await page.screenshot({
        path: join(SHOTS, `seat-${id}.png`),
        clip: { x: box.x - 24, y: box.y - 34, width: box.width + 48, height: box.height + 58 },
      });
    }

    // Selected: the surface and the toolbar.
    await seat("input").click();
    await page.waitForTimeout(400);
    const selected = await seat("input").boundingBox();
    if (!selected) throw new Error("selected seat has no box");
    await page.screenshot({
      path: join(SHOTS, "seat-input-selected.png"),
      clip: { x: selected.x - 60, y: selected.y - 70, width: selected.width + 120, height: selected.height + 100 },
    });
    await page.locator(".react-flow__pane").click({ position: { x: 12, y: 12 } });

    // Speaking: a bubble over each kind of seat.
    const now = Date.now();
    const staged = [
      { nodeId: "working", text: "splitting the migration into two steps" },
      { nodeId: "input", text: "approve the schema change?", provenance: "agent", action: "signal", tone: "amber" },
      { nodeId: "blocked", text: "blocked: needs the staging key", provenance: "agent", action: "signal", tone: "crimson" },
      { nodeId: "done", text: "done, not read yet", provenance: "system", action: "state", tone: "green" },
    ].map((fields, i) => ({ preambleId: `stage-${String(i)}`, canvasName: CANVAS, expiresAt: now + 60_000, ...fields }));
    await junto.app.evaluate(({ BrowserWindow }, events) => {
      for (const window of BrowserWindow.getAllWindows()) {
        for (const event of events) window.webContents.send("junto:preamble", event);
      }
    }, staged);
    await expect(page.getByTestId("node-preamble")).toHaveCount(staged.length, { timeout: 10_000 });
    await page.waitForTimeout(500);
    await page.locator(".react-flow").screenshot({ path: join(SHOTS, "canvas-speaking.png") });
  } finally {
    await junto.close();
  }
});
