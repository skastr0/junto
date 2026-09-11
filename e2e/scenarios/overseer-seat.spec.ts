/**
 * Overseer seat identity + human toggle.
 *
 * Glance-only cards: OVERSEER reads on the card; grant/revoke lives on the
 * RTS kind strip. Pause/play is orthogonal. Ordinary agents stay unstyled.
 *
 * Boards install at runtime via window.vellumCommand.
 * Run: `bunx electron-vite build && bun run test:e2e:fast e2e/scenarios/overseer-seat.spec.ts`
 */
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "overseer-seat");
const ARTIFACT = join(process.cwd(), ".amp/in/artifacts/overseer-seat.png");

const fixtureDoc = canvasDoc([
  agentTextNode({
    id: "overseer-seat",
    key: "local:overseer",
    label: "overseer worker",
    x: 40,
    y: 40,
  }),
  {
    ...agentTextNode({
      id: "ordinary-seat",
      key: "local:ordinary",
      label: "ordinary worker",
      x: 340,
      y: 40,
    }),
  },
  agentTextNode({
    id: "paused-overseer",
    key: "local:paused",
    label: "paused overseer",
    x: 40,
    y: 200,
  }),
]);

const withGrant = (doc: ReturnType<typeof canvasDoc>, nodeId: string) => ({
  ...doc,
  nodes: doc.nodes.map((node) =>
    node.id === nodeId
      ? { ...node, ether: { ...node.ether, overseer: true as const } }
      : node,
  ),
});

const installBoard = async (
  page: Page,
  document: typeof fixtureDoc,
): Promise<string> => {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const runtime = globalThis as unknown as {
            readonly vellumCommand?: { readonly listCanvases: () => Promise<unknown[]> };
          };
          return Boolean(runtime.vellumCommand?.listCanvases);
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
  return page.evaluate(async (board) => {
    const api = (
      globalThis as unknown as {
        readonly vellumCommand: {
          readonly listCanvases: () => Promise<ReadonlyArray<{ name: string }>>;
          readonly createCanvas: (name: string) => Promise<{ name: string; revision: string }>;
          readonly readCanvas: (name: string) => Promise<{ name: string; revision: string }>;
          readonly writeCanvas: (
            name: string,
            doc: unknown,
            expectedRevision?: string,
          ) => Promise<unknown>;
        };
      }
    ).vellumCommand;
    let list = await api.listCanvases();
    let name = list[0]?.name;
    if (!name) {
      const created = await api.createCanvas("overseer");
      name = created.name;
    }
    const read = await api.readCanvas(name);
    await api.writeCanvas(name, board, read.revision);
    return name;
  }, document);
};

const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
};

test("overseer identity: card, selected, paused, ordinary contrast, toggle", async ({
  vellumCommand,
}) => {
  const { page } = vellumCommand;
  await mkdir(SHOTS, { recursive: true });
  await mkdir(join(process.cwd(), ".amp/in/artifacts"), { recursive: true });

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await installBoard(
    page,
    withGrant(withGrant(fixtureDoc, "overseer-seat"), "paused-overseer"),
  );

  const granted = page.locator('.react-flow__node[data-id="overseer-seat"]');
  const ordinary = page.locator('.react-flow__node[data-id="ordinary-seat"]');
  const paused = page.locator('.react-flow__node[data-id="paused-overseer"]');
  await expect(granted).toBeVisible({ timeout: 30_000 });
  await expect(ordinary).toBeVisible();
  await expect(paused).toBeVisible();

  await expect(granted.locator(".vellum-node")).toHaveAttribute("data-overseer", "true");
  await expect(granted.getByTestId("overseer-mark")).toHaveText("OVERSEER");
  const grantedColor = await granted.getByTestId("overseer-mark").evaluate((el) => getComputedStyle(el).color);
  expect(grantedColor).not.toBe("rgb(229, 72, 77)"); // crimson
  expect(grantedColor).not.toBe("rgb(232, 163, 61)"); // amber
  await expect(ordinary.locator(".vellum-node")).not.toHaveAttribute("data-overseer", "true");
  await expect(ordinary.getByTestId("overseer-mark")).toHaveCount(0);
  await expect(paused.locator(".vellum-node")).toHaveAttribute("data-overseer", "true");

  await shot(page, "01-enabled-vs-ordinary");

  await granted.click();
  await expect(page.getByTestId("rts-overseer")).toBeVisible();
  await expect(page.getByTestId("rts-overseer")).toHaveAttribute("data-overseer", "true");
  await expect(page.locator(".rts-kind-id")).toHaveAttribute("data-overseer", "true");
  await expect(page.locator(".rts-kind-id").getByTestId("overseer-mark")).toHaveText("OVERSEER");
  await expect(page.getByTestId("node-toolbar-pause")).toHaveAttribute("data-paused", "false");
  await shot(page, "02-selected-enabled");

  await ordinary.click();
  await expect(page.getByTestId("rts-overseer")).toHaveAttribute("data-overseer", "false");
  await expect(page.locator(".rts-kind-id")).not.toHaveAttribute("data-overseer", "true");
  await expect(page.locator(".rts-kind-id").getByTestId("overseer-mark")).toHaveCount(0);
  await shot(page, "03-selected-disabled");

  await paused.click();
  const leftPause = page.getByTestId("rts-pause-node");
  await expect(leftPause).toBeVisible();
  await leftPause.click();
  await expect(leftPause).toHaveAttribute("data-paused", "true");
  await expect(paused.locator(".vellum-node")).toHaveAttribute("data-overseer", "true");
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
  await expect(granted.getByTestId("overseer-mark")).toHaveText("OVERSEER");
  await expect(ordinary.getByTestId("overseer-mark")).toHaveCount(0);
  await shot(page, "05-bright-enabled");

  await copyFile(join(SHOTS, "02-selected-enabled.png"), ARTIFACT);
});
