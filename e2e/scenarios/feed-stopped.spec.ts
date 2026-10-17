/**
 * Needs you ranks on the need ladder, and lists seats that stopped.
 *   bun run test:e2e:fast e2e/scenarios/feed-stopped.spec.ts
 *
 * Seats publish their harness status on the seat-state plane, the way main
 * does; declared signals arrive as durable rows.
 *
 * Asserts:
 *   - a usage limit, a sign-in error and an unexpected exit each list once as stopped, and count
 *   - a declared block leads, a stop follows it, then an escalation, then feedback
 * Shots land in test-results/feed-stopped/.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import type { AgentSignal } from "../../src/shared/agent-signals";
import { encodeAgentSeatStatus } from "../../src/shared/agent-seat-state";
import { initialSnapshot, reduceSeatSignals, topNeed, type SeatSignal, type SignalSource } from "../../src/shared/harness-domain";
import { BindingId } from "../../src/shared/terminal-session-domain";
import { modelFixture, modelRegion, modelSeat } from "../harness/model";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "feed-stopped");
const CANVAS = "feed-stopped";
const MINUTE = 60_000;

const SEATS = [
  ["limit", "Atlas"],
  ["signin", "Brook"],
  ["exit", "Cedar"],
  ["asks", "Delta"],
  ["hand", "Ember"],
  ["review", "Flint"],
] as const;

const nodes = [
  modelRegion({ id: "build", label: "Build", color: "4", x: 0, y: 0, width: 1700, height: 460 }),
  ...SEATS.map(([id, label], index) =>
    modelSeat({ id, key: `local:e2e-stop-${id}`, label, x: 40 + index * 270, y: 80 }),
  ),
];

const statusOf = (id: string, at: number, steps: ReadonlyArray<readonly [SignalSource, SeatSignal]>) => {
  const seat = Schema.decodeSync(BindingId)(`local:e2e-stop-${id}`);
  const snapshot = reduceSeatSignals(
    initialSnapshot(seat, at),
    steps.map(([source, signal], index) => ({
      seat,
      at: at + index,
      source,
      fidelity: source === "screen" ? ("screen" as const) : ("native" as const),
      signal,
    })),
  );
  return encodeAgentSeatStatus({ snapshot, need: topNeed(snapshot) });
};

const seatEvents = (now: number) => {
  const event = (id: string, state: string, at: number, status?: unknown) => ({
    bindingId: `local:e2e-stop-${id}`,
    epoch: "e2e",
    state,
    reason: "test",
    confidence: "high",
    at,
    ...(status === undefined ? {} : { status }),
  });
  return [
    event("limit", "idle", now - 12 * MINUTE, statusOf("limit", now - 12 * MINUTE, [
      ["screen", { _tag: "TurnStarted" }],
      ["transcript", { _tag: "UsageLimitHit", scope: "weekly", resetsAt: now + 3 * 60 * MINUTE, message: "You've hit your weekly limit" }],
    ])),
    event("signin", "idle", now - 6 * MINUTE, statusOf("signin", now - 6 * MINUTE, [
      ["transcript", { _tag: "ErrorRaised", kind: "auth", message: "authentication_failed: OAuth token has expired" }],
    ])),
    event("exit", "gone", now - 3 * MINUTE, statusOf("exit", now - 3 * MINUTE, [
      ["process", { _tag: "ProcessExited", code: 137, expected: false }],
    ])),
  ];
};

const signal = (nodeId: string, kind: AgentSignal["kind"], text: string, at: number): AgentSignal => ({
  signalId: `e2e-${nodeId}`,
  canvasName: CANVAS,
  nodeId,
  kind,
  text,
  createdAt: at,
  state: "open",
});

test("stopped seats list on Needs you, ranked on the need ladder", async () => {
  await mkdir(SHOTS, { recursive: true });
  const now = Date.now();
  const junto = await launchJunto({
    seedModels: { [CANVAS]: modelFixture(nodes, []) },
    seedAgentSignals: [
      signal("asks", "blocked", "I need the staging key to run the migration.", now - 2 * MINUTE),
      signal("hand", "escalate", "Two specs disagree on ids; I picked the newer one.", now - 20 * MINUTE),
      signal("review", "feedback", "The settings redesign is ready for a look.", now - 30 * MINUTE),
    ],
  });
  try {
    const { page } = junto;
    await expect(page.locator(".react-flow__node", { hasText: "Atlas" })).toBeVisible({ timeout: 30_000 });
    await junto.app.evaluate(({ BrowserWindow }, events) => {
      for (const window of BrowserWindow.getAllWindows()) {
        for (const event of events) window.webContents.send("junto:agent-seat-state-changed", event);
      }
    }, seatEvents(now));

    await expect(page.getByTestId("operator-feed-trigger")).toHaveAttribute("aria-label", "Needs you, 6", { timeout: 10_000 });
    await page.keyboard.press("Meta+I");
    const feed = page.getByTestId("operator-feed");
    await expect(feed).toBeVisible({ timeout: 10_000 });
    const cards = feed.getByTestId("operator-feed-card");
    await expect(cards).toHaveCount(6);
    await expect(cards.nth(0)).toContainText("staging key");
    await expect(cards.nth(1)).toContainText("hit a usage limit, resets");
    await expect(cards.nth(2)).toContainText("stopped on a sign-in error");
    await expect(cards.nth(3)).toContainText("exited unexpectedly");
    await expect(cards.nth(4)).toContainText("Two specs disagree");
    await expect(cards.nth(5)).toContainText("settings redesign");

    await page.mouse.move(4, 700);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SHOTS, "feed.png") });
  } finally {
    await junto.close();
  }
});
