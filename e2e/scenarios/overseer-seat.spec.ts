import { installModelFixture, modelFixture, modelSeat } from "../harness/model";
import { grantOverseer } from "../harness/model";
/**
 * Overseer seat identity + human toggle.
 *
 * Glance-only cards: OVERSEER reads on the card; grant/revoke lives on the
 * RTS kind strip. Pause/play is orthogonal. Ordinary agents stay unstyled.
 *
 * Boards install at runtime via window.junto.
 * Run: `bunx electron-vite build && bun run test:e2e:fast e2e/scenarios/overseer-seat.spec.ts`
 */
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";

import { expect, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "overseer-seat");
const ARTIFACT = join(process.cwd(), ".amp/in/artifacts/overseer-seat.png");

const fixtureDoc = modelFixture([
  modelSeat({
    id: "overseer-seat",
    key: "local:overseer",
    label: "overseer worker",
    x: 40,
    y: 40,
  }),
  {
    ...modelSeat({
      id: "ordinary-seat",
      key: "local:ordinary",
      label: "ordinary worker",
      x: 340,
      y: 40,
    }),
  },
  modelSeat({
    id: "paused-overseer",
    key: "local:paused",
    label: "paused overseer",
    x: 640,
    y: 40,
  }),
]);

const installBoard = async (
  page: Page,
  document: typeof fixtureDoc,
): Promise<string> => {
  await page.waitForFunction(() => Boolean(window.junto?.modelCanvases), undefined, { timeout: 30_000 });
  const name = await installModelFixture(page, document, "overseer");
  for (const id of ["overseer-seat", "paused-overseer"]) await grantOverseer(page, name, id);
  return name;
};

const shot = async (page: Page, name: string) => {
  await page.mouse.move(30, 30);
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
};

test("overseer identity: card, selected, paused, ordinary contrast, toggle", async ({
  junto,
}) => {
  const { page } = junto;
  await mkdir(SHOTS, { recursive: true });
  await mkdir(join(process.cwd(), ".amp/in/artifacts"), { recursive: true });

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await installBoard(page, fixtureDoc);

  const granted = page.locator('.react-flow__node[data-id="overseer-seat"]');
  const ordinary = page.locator('.react-flow__node[data-id="ordinary-seat"]');
  const paused = page.locator('.react-flow__node[data-id="paused-overseer"]');
  await expect(granted).toBeVisible({ timeout: 30_000 });
  await expect(ordinary).toBeVisible();
  await expect(paused).toBeVisible();

  // Visual setup is a human camera action, separate from the invariant spec.
  await page.getByRole("button", { name: "Fit all nodes" }).click();
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
  await page.getByRole("radio", { name: "Dark", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Dark", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("html")).not.toHaveAttribute("data-theme");
  await page.locator(".settings-panel__close").click();

  await expect(granted.locator(".junto-node")).toHaveAttribute("data-overseer", "true");
  // On the canvas the role is a crest on the ring, not a text tab.
  await expect(granted.getByTestId("overseer-crest")).toBeVisible();
  await expect(granted.getByTestId("overseer-mark")).toHaveCount(0);
  const grantedColor = await granted.getByTestId("overseer-crest").evaluate((el) => getComputedStyle(el).color);
  expect(grantedColor).not.toBe("rgb(229, 72, 77)"); // crimson
  expect(grantedColor).not.toBe("rgb(232, 163, 61)"); // amber
  await expect(ordinary.locator(".junto-node")).not.toHaveAttribute("data-overseer", "true");
  await expect(ordinary.getByTestId("overseer-crest")).toHaveCount(0);
  await expect(paused.locator(".junto-node")).toHaveAttribute("data-overseer", "true");

  await shot(page, "01-enabled-vs-ordinary");

  await granted.click();
  await expect(page.getByTestId("rts-overseer")).toBeVisible();
  await expect(page.getByTestId("rts-overseer")).toHaveAttribute("data-overseer", "true");
  await expect(page.locator(".rts-kind-id")).toHaveAttribute("data-overseer", "true");
  await expect(page.locator(".rts-kind-id").getByTestId("overseer-mark")).toHaveText("OVERSEER");
  await shot(page, "02-selected-enabled");

  await ordinary.click();
  await expect(page.getByTestId("rts-overseer")).toHaveAttribute("data-overseer", "false");
  await expect(page.locator(".rts-kind-id")).not.toHaveAttribute("data-overseer", "true");
  await expect(page.locator(".rts-kind-id").getByTestId("overseer-mark")).toHaveCount(0);
  await shot(page, "03-selected-disabled");

  // Pause is canvas-wide only: selecting the seat offers no node pause.
  await paused.click();
  await expect(page.getByTestId("rts-pause-node")).toHaveCount(0);
  await expect(paused.locator(".junto-node")).toHaveAttribute("data-overseer", "true");
  await expect(page.getByTestId("rts-overseer")).toHaveAttribute("data-overseer", "true");
  await shot(page, "04-paused-enabled");

  // Bright mode — same granted/ordinary contrast through the real settings path.
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
  const brightChoice = page.getByRole("radio", { name: "Bright" });
  await brightChoice.click();
  await expect(brightChoice).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
  await page.locator(".settings-panel__close").click();
  await page.waitForTimeout(400);
  await granted.click();
  await expect(granted.getByTestId("overseer-crest")).toBeVisible();
  await expect(ordinary.getByTestId("overseer-crest")).toHaveCount(0);
  await shot(page, "05-bright-enabled");

  await copyFile(join(SHOTS, "04-paused-enabled.png"), ARTIFACT);
  await copyFile(join(SHOTS, "05-bright-enabled.png"), ARTIFACT.replace(".png", "-bright.png"));

  await page.getByTestId("rts-overseer").click();
  await expect(page.getByTestId("rts-overseer")).toHaveAttribute("data-overseer", "false");
  // Revoking one seat's grant leaves the other's alone. On the canvas the
  // role is the crest on the ring; the OVERSEER text is not on a card.
  await expect(granted.getByTestId("overseer-crest")).toHaveCount(0);
  await expect(granted.locator(".junto-node")).not.toHaveAttribute("data-overseer", "true");
  await expect(paused.getByTestId("overseer-crest")).toBeVisible();
  await expect(paused.locator(".junto-node")).toHaveAttribute("data-overseer", "true");
});
