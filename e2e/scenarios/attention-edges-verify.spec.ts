/**
 * Real app, 0d052a27f: an attention surface without a one-sided accent
 * edge, dark and bright. A seat's answered signal opens from its signal row
 * in Seat details: the "your reply" block reads a full 1px border on all four
 * sides, rounded, tinted, no left stripe. The cache due band is not drawn
 * here: a real cache window does not end inside a test, and nothing may fake
 * the core's list, so its jsdom test holds it (tests/seat-cache-due-popup.test.tsx).
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/attention-edges-verify.spec.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { AgentSignal } from "../../src/shared/agent-signals";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelSeat } from "../harness/model";

const CANVAS = "attention-edges";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/attention-edges-verify";
const MINUTE = 60_000;

// The four sides of an element's border, its radius, background and inset shadow.
const edges = (target: Locator) =>
  target.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      top: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
      right: `${s.borderRightWidth} ${s.borderRightStyle} ${s.borderRightColor}`,
      bottom: `${s.borderBottomWidth} ${s.borderBottomStyle} ${s.borderBottomColor}`,
      left: `${s.borderLeftWidth} ${s.borderLeftStyle} ${s.borderLeftColor}`,
      radius: s.borderRadius,
      background: s.backgroundColor,
      shadow: s.boxShadow,
      before: getComputedStyle(el, "::before").content,
    };
  });

const setTheme = (page: Page, theme: "dark" | "bright") =>
  page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);

test("attention edges: the answered signal's reply block carries no one-sided accent", async () => {
  test.setTimeout(300_000);
  const now = Date.now();
  const answered: AgentSignal = {
    signalId: "sig-worker-answered",
    canvasName: CANVAS,
    nodeId: "worker",
    kind: "escalate",
    text: "Should the export include archived projects, or only live ones?",
    createdAt: now - 20 * MINUTE,
    state: "answered",
    response: { text: "Live ones only, archived stays out of this export.", at: now - 5 * MINUTE },
    closedAt: now - 5 * MINUTE,
  } as AgentSignal;
  const junto = await launchJunto({
    windowContentSize: { width: 1500, height: 900 },
    seedModels: { [CANVAS]: modelFixture([modelSeat({ id: "worker", key: "local:worker", label: "worker", x: 200, y: 120 })]) },
    seedAgentSignals: [answered],
  });
  const read: Record<string, unknown> = {};
  const misses: string[] = [];
  const step = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      misses.push(`${name}: ${String(error).replace(/\u001b\[[0-9;]*m/gu, "").split("\n").slice(0, 3).join(" ")}`);
    }
  };
  try {
    const { page } = junto;
    await setTheme(page, "dark");
    const seat = page.locator('.react-flow__node[data-id="worker"]');
    await expect(seat).toBeVisible({ timeout: 30_000 });
    await seat.dblclick();
    const view = page.locator(".workbench-pane:not(.workbench-pane--parked) .native-terminal-surface");
    await expect(view.locator("header").first()).toBeVisible({ timeout: 20_000 });

    await step("signal reply block", async () => {
      await view.getByTestId("seat-details-button").click();
      await page.getByTestId("seat-signal-row").first().click();
      const block = page.locator(".seat-signal-popover__response").first();
      await expect(block).toBeVisible({ timeout: 10_000 });
      for (const theme of ["dark", "bright"] as const) {
        mkdirSync(join(SHOTS, theme), { recursive: true });
        await setTheme(page, theme);
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(SHOTS, theme, "01-signal-reply.png") });
        await block.screenshot({ path: join(SHOTS, theme, "01a-signal-reply-crop.png") });
        read[`${theme}/signal-reply`] = await edges(block);
      }
      await setTheme(page, "dark");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
    });
  } finally {
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, "edges.json"), JSON.stringify({ read, misses }, null, 2));
    await junto.close();
  }
  console.log("ATTN-EDGES", JSON.stringify(read));
  console.log("ATTN-MISSES", JSON.stringify(misses));
  expect(misses).toEqual([]);
});
