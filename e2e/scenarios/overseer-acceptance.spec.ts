import { installModelFixture, modelFixture, modelSeat } from "../harness/model";
import { grantOverseer, readModelCanvas } from "../harness/model";
/**
 * Overseer acceptance: human toggle persists authority; viewport is unchanged.
 *
 * Seed a managed seat through model commands. Grant via
 * the human API (RTS toggle or GrantOverseer). Observe the committed
 * rows through modelOpen. Do not pan, zoom, fit, or switch canvas.
 *
 * Run: bunx electron-vite build && bun run test:e2e:fast e2e/scenarios/overseer-acceptance.spec.ts
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";

import { expect, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "overseer-acceptance");
const ARTIFACT = join(
  process.cwd(),
  ".amp/in/artifacts/overseer-acceptance-toggle.png",
);
const SEAT_ID = "overseer-seat";
const ORDINARY_ID = "ordinary-seat";

type Viewport = { readonly x: number; readonly y: number; readonly zoom: number };

const fixtureDoc = modelFixture([
  modelSeat({
    id: SEAT_ID,
    key: "local:overseer",
    label: "overseer worker",
    x: 40,
    y: 40,
  }),
  modelSeat({
    id: ORDINARY_ID,
    key: "local:ordinary",
    label: "ordinary worker",
    x: 340,
    y: 40,
  }),
]);

const viewportOf = async (page: Page): Promise<Viewport> =>
  page.locator(".react-flow__viewport").evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return { x: matrix.m41, y: matrix.m42, zoom: matrix.a };
  });

const installBoard = async (page: Page): Promise<string> => {
  await page.waitForFunction(() => Boolean(window.junto?.modelCanvases), undefined, { timeout: 30_000 });
  const name = await installModelFixture(page, fixtureDoc, "overseer-acceptance");
  return name;
};

const readGrant = async (page: Page, canvas: string, id: string) => {
  const opened = await readModelCanvas(page, canvas);
  const node = opened.nodes.find((candidate) => candidate.id === id);
  return { overseer: node?.kind === "agent" ? node.overseer : undefined, seq: opened.seq };
};

const grantViaHumanApi = async (
  page: Page,
  canvasName: string,
  nodeId: string,
): Promise<
  | { readonly path: "toggle" }
  | { readonly path: "ipc"; readonly overseer: boolean }
> => {
  const toggle = page.getByTestId("rts-overseer");
  if ((await toggle.count()) > 0) {
    await expect(toggle).toHaveAttribute("data-overseer", "false");
    await toggle.click();
    return { path: "toggle" };
  }
  await grantOverseer(page, canvasName, nodeId);
  return { path: "ipc" as const, overseer: (await readGrant(page, canvasName, nodeId)).overseer === true };
};

test("human toggle persists overseer authority without moving the viewport", async ({
  junto,
}) => {
  const { page } = junto;
  await mkdir(SHOTS, { recursive: true });
  await mkdir(join(process.cwd(), ".amp/in/artifacts"), { recursive: true });

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  const canvasName = await installBoard(page);

  const grantedNode = page.locator(`.react-flow__node[data-id="${SEAT_ID}"]`);
  const ordinaryNode = page.locator(`.react-flow__node[data-id="${ORDINARY_ID}"]`);
  await expect(grantedNode).toBeVisible({ timeout: 30_000 });
  await expect(ordinaryNode).toBeVisible();

  const beforeGrant = await readGrant(page, canvasName, SEAT_ID);
  expect(beforeGrant.overseer, "generic fixture edits must not mint overseer").not.toBe(
    true,
  );

  await grantedNode.click();
  const before = await viewportOf(page);

  const grant = await grantViaHumanApi(page, canvasName, SEAT_ID);
  if (grant.path === "ipc") {
    expect(grant.overseer).toBe(true);
  }

  await expect
    .poll(async () => (await readGrant(page, canvasName, SEAT_ID)).overseer, {
      timeout: 15_000,
    })
    .toBe(true);

  const after = await viewportOf(page);
  expect(after).toEqual(before);

  const ordinary = await readGrant(page, canvasName, ORDINARY_ID);
  expect(ordinary.overseer).not.toBe(true);

  const card = grantedNode.locator(".junto-node");
  if ((await card.count()) > 0) {
    await expect(card).toHaveAttribute("data-overseer", "true");
  }
  const crest = grantedNode.getByTestId("overseer-crest");
  if ((await card.count()) > 0) {
    await expect(crest).toHaveCount(1);
  }

  await page.screenshot({
    path: join(SHOTS, "toggle-persisted.png"),
    fullPage: false,
  });
  await page.screenshot({ path: ARTIFACT, fullPage: false });
});
