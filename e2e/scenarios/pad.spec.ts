/**
 * Pad sink e2e: catalog create, wire a mock seat, work-API patch,
 * persist across reload, focus-modal box, pin + look-here.
 *
 * No real harnesses. Isolation: throwaway HOME (harness/launch.ts).
 */
import type { WorkOpResult } from "../../src/shared/ipc";
import type { Pad, PadPatch } from "../../src/shared/pad";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const CANVAS = "pad-e2e";

test.use({
  vellumOptions: {
    seedCanvases: {
      [CANVAS]: canvasDoc([
        agentTextNode({
          id: "seat",
          key: "local:pad-seat",
          label: "seat",
          x: 40,
          y: 40,
        }),
      ]),
    },
  },
});

type PadBody = {
  readonly revision: number;
  readonly pad: Pad;
  readonly digest: string;
};

const waitForApi = async (page: import("@playwright/test").Page): Promise<void> => {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const api = window.vellumCommand;
          return (
            typeof api?.workPadRead === "function" &&
            typeof api.workPadPatch === "function" &&
            typeof api.writeCanvas === "function"
          );
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
};

const readPad = (
  page: import("@playwright/test").Page,
  nodeId: string,
  pinId?: string,
) =>
  page.evaluate(
    ([canvas, id, pin]) => window.vellumCommand!.workPadRead(canvas, id, pin),
    [CANVAS, nodeId, pinId] as const,
  );

const patchPad = (
  page: import("@playwright/test").Page,
  nodeId: string,
  patches: ReadonlyArray<PadPatch>,
): Promise<WorkOpResult<PadBody>> =>
  page.evaluate(
    ([canvas, id, next]) => window.vellumCommand!.workPadPatch(canvas, id, next),
    [CANVAS, nodeId, patches] as const,
  );

test("pad: create, wire seat, patch, persist, draw, pin + look-here", async ({
  vellumCommand,
}) => {
  const { page } = vellumCommand;

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await waitForApi(page);
  await expect(page.locator(".react-flow__node", { hasText: "seat" })).toBeVisible({
    timeout: 30_000,
  });

  await page.getByRole("button", { name: "Add canvas item" }).click();
  const deck = page.getByRole("dialog", { name: "Add canvas item" });
  await expect(deck).toBeVisible();
  await deck.getByRole("searchbox", { name: "Search nodes and agents" }).fill("pad");
  await deck.locator(".node-deck-catalog__card").filter({ hasText: "Pad" }).click();

  const padCard = page.getByTestId("pad-card");
  await expect(padCard).toBeVisible({ timeout: 15_000 });

  const padId = await page.evaluate(async (canvas) => {
    const api = window.vellumCommand!;
    const read = await api.readCanvas(canvas);
    const pad = read.doc.nodes.find((node) => node.ether?.entity?.kind === "pad");
    if (!pad) throw new Error("catalog did not create a pad node");
    await api.writeCanvas(
      canvas,
      {
        ...read.doc,
        edges: [
          ...read.doc.edges,
          { id: "e-seat-pad", fromNode: "seat", toNode: pad.id },
        ],
      },
      read.revision,
    );
    return pad.id;
  }, CANVAS);
  expect(padId.length).toBeGreaterThan(0);

  const patched = await patchPad(page, padId, [
    {
      op: "upsert",
      layer: "shape",
      shape: {
        id: "api-box" as Pad["shapes"][number]["id"],
        type: "box",
        x: 20,
        y: 20,
        w: 80,
        h: 40,
        z: 0,
        text: "api-box",
      },
    },
  ]);
  expect(patched.ok).toBe(true);
  if (!patched.ok) return;
  expect(patched.data.pad.shapes.map((shape) => shape.text)).toContain("api-box");

  await page.reload();
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await waitForApi(page);
  await expect(page.getByTestId("pad-card")).toBeVisible({ timeout: 15_000 });

  const afterReload = await readPad(page, padId);
  expect(afterReload.ok).toBe(true);
  if (!afterReload.ok) return;
  expect(afterReload.data.pad.shapes.map((shape) => shape.text)).toContain("api-box");

  await page.locator('.react-flow__node').filter({ has: page.getByTestId("pad-card") }).click();
  await page.getByRole("button", { name: "Open pad" }).click();
  const detail = page.getByTestId("pad-detail");
  await expect(detail).toBeVisible({ timeout: 15_000 });
  const svg = page.getByTestId("pad-svg");
  await expect(svg).toBeVisible();
  await expect(page.getByTestId("pad-empty")).toHaveCount(0);

  await page.getByTestId("pad-tool-box").click();
  const box = await svg.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + 90, box!.y + 80);
  await page.mouse.down();
  await page.mouse.move(box!.x + 200, box!.y + 160);
  await page.mouse.up();

  await expect
    .poll(async () => {
      const read = await readPad(page, padId);
      return read.ok ? read.data.pad.shapes.length : 0;
    }, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(2);

  await page.getByTestId("pad-tool-ink").click();
  await expect(svg).toHaveAttribute("data-tool", "ink");
  await page.mouse.move(box!.x + 60, box!.y + 180);
  await page.mouse.down();
  await page.mouse.move(box!.x + 140, box!.y + 230);
  await page.mouse.up();

  await expect
    .poll(async () => {
      const read = await readPad(page, padId);
      return read.ok ? read.data.pad.inks.length : 0;
    }, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(1);

  const inked = await readPad(page, padId);
  expect(inked.ok).toBe(true);
  if (!inked.ok) return;
  expect(inked.data.pad.inks[0]?.points.length).toBeGreaterThanOrEqual(2);
  expect(inked.data.svg).toMatch(/<path d="M /);
  expect(inked.data.digest).toContain("inks ::");
  expect(inked.data.digest).not.toMatch(/\{"x":/);

  await page.getByTestId("pad-tool-pin").click();
  await expect(svg).toHaveAttribute("data-tool", "pin");
  await page.mouse.click(box!.x + 140, box!.y + 110);

  await expect
    .poll(async () => {
      const read = await readPad(page, padId);
      return read.ok ? read.data.pad.pins.length : 0;
    }, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(1);

  await page.getByRole("button", { name: "Close pad" }).click();
  await expect(detail).toHaveCount(0);

  const withPin = await readPad(page, padId);
  expect(withPin.ok).toBe(true);
  if (!withPin.ok) return;
  const pinId = withPin.data.pad.pins[0]?.id;
  expect(pinId).toBeTruthy();
  const focused = await readPad(page, padId, pinId);
  expect(focused.ok).toBe(true);
  if (!focused.ok) return;
  expect(focused.data.lookHere?.digest).toMatch(/look-here/);
  expect(focused.data.lookHere?.svg).toMatch(/<svg/i);
  expect(focused.data.lookHere?.bounds.w).toBeGreaterThan(0);
  expect(focused.data.lookHere?.bounds.h).toBeGreaterThan(0);
});
