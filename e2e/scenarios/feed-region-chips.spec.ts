/**
 * The Needs you feed's region chips: a parent region is a filter too.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/feed-region-chips.spec.ts
 *
 * Asserts:
 *   - the strip lists All, each waiting region and every region around one,
 *     a parent just before its first child, and the open field
 *   - a parent's count rolls up its children's and its own
 *   - picking the parent shows every need inside it; an inner chip narrows to
 *     its own; pressing the picked chip again shows everything
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { AgentSignal } from "../../src/shared/agent-signals";
import type { Region, Seat as ModelSeat } from "../../src/shared/model";
import { modelFixture, modelRegion, modelSeat, type ModelFixture } from "../harness/model";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = process.env.JUNTO_SHOTS_DIR ?? join(process.cwd(), "test-results", "feed-region-chips");
const CANVAS = "feed-region-chips";
const MINUTE = 60_000;

const region = (input: { id: string; label: string; color?: string; x: number; y: number; width: number; height: number; z: number }): Region =>
  modelRegion(input);

const seat = (id: string, x: number, y: number): ModelSeat =>
  modelSeat({ id, key: `local:e2e-chips-${id}`, label: id, harness: "claude", x, y });

// Junto holds Product and CLI; juno sits in Junto outside both, nova in the open field.
const fixture = (): ModelFixture =>
  modelFixture(
    [
      region({ id: "junto", label: "Junto", color: "2", x: 0, y: 0, width: 1700, height: 900, z: 0 }),
      region({ id: "product", label: "Product", color: "4", x: 40, y: 60, width: 700, height: 500, z: 1 }),
      region({ id: "cli", label: "CLI", color: "6", x: 800, y: 60, width: 700, height: 500, z: 1 }),
      seat("pia", 80, 140),
      seat("cleo", 840, 140),
      seat("juno", 80, 640),
      seat("nova", 2000, 80),
    ],
    [],
  );

const signal = (seatId: string, n: number, kind: AgentSignal["kind"]): AgentSignal => ({
  signalId: `sig-${seatId}-${n}`,
  canvasName: CANVAS,
  nodeId: seatId,
  kind,
  text: `${seatId} asks number ${n}`,
  createdAt: Date.now() - (10 + n) * MINUTE,
  state: "open",
});

const SIGNALS: ReadonlyArray<AgentSignal> = [
  signal("pia", 0, "blocked"),
  signal("cleo", 0, "blocked"),
  signal("cleo", 1, "feedback"),
  signal("juno", 0, "feedback"),
  signal("nova", 0, "feedback"),
];

const shot = async (page: Page, name: string): Promise<void> => {
  await mkdir(SHOTS, { recursive: true });
  await page.mouse.move(4, 700);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, name) });
};

test("a parent region chip shows every need inside it, and its count rolls up its children", async () => {
  const junto = await launchJunto({ seedModels: { [CANVAS]: fixture() }, seedAgentSignals: SIGNALS });
  try {
    const { page } = junto;
    await expect(page.locator(".react-flow__node", { hasText: "pia" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("operator-feed-trigger")).toHaveAttribute("aria-label", "Needs you, 5", { timeout: 10_000 });
    await page.keyboard.press("Meta+I");
    const feed = page.getByTestId("operator-feed");
    await expect(feed).toBeVisible({ timeout: 10_000 });
    const cards = feed.getByTestId("operator-feed-card");
    await expect(cards).toHaveCount(5);

    const strip = page.getByRole("radiogroup", { name: "Filter needs by region" });
    const names = await strip.getByRole("radio").evaluateAll((chips) => chips.map((chip) => chip.getAttribute("aria-label")));
    expect(names[0]).toBe("All regions, 5 waiting");
    // Junto rolls up Product's one, CLI's two and juno's own: four.
    expect(names[1]).toBe("Junto, 4 waiting");
    expect(names.slice(2).sort()).toEqual(["Junto > CLI, 2 waiting", "Junto > Product, 1 waiting", "open field, 1 waiting"]);
    await shot(page, "chips-all.png");

    const junto4 = strip.getByRole("radio", { name: "Junto, 4 waiting" });
    await junto4.click();
    await expect(junto4).toHaveAttribute("aria-checked", "true");
    await expect(cards).toHaveCount(4);
    await expect(feed.locator("[data-item-id='signal:sig-nova-0']")).toHaveCount(0);
    await expect(page.locator(".operator-feed__status")).toHaveText("4 of 5 waiting in Junto");
    await shot(page, "chips-parent-junto.png");

    await strip.getByRole("radio", { name: "Junto > CLI, 2 waiting" }).click();
    await expect(cards).toHaveCount(2);
    await expect(page.locator(".operator-feed__status")).toHaveText("2 of 5 waiting in CLI");
    await shot(page, "chips-inner-cli.png");

    // The picked chip again: everything.
    await strip.getByRole("radio", { name: "Junto > CLI, 2 waiting" }).click();
    await expect(cards).toHaveCount(5);
    await expect(strip.getByRole("radio", { name: "All regions, 5 waiting" })).toHaveAttribute("aria-checked", "true");
  } finally {
    await junto.close();
  }
});
