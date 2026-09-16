/**
 * Pad work-plane e2e: create a pad, wire a mock seat, pad.patch a box,
 * pad.read sees it, reload persists. No real harnesses.
 */
import type { WorkOpResult } from "../../src/shared/ipc";
import type { Pad, PadPatch } from "../../src/shared/pad";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const CANVAS = "pad-work-plane";

test.use({
  juntoOptions: {
    seedCanvases: {
      [CANVAS]: canvasDoc([
        agentTextNode({
          id: "seat",
          key: "local:pad-work-plane",
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

const readPad = (page: import("@playwright/test").Page, nodeId: string) =>
  page.evaluate(
    ([canvas, id]) => window.vellumCommand!.workPadRead(canvas, id),
    [CANVAS, nodeId] as const,
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

test("pad work plane: create, wire seat, patch box, read, persist across reload", async ({
  junto,
}) => {
  const { page } = junto;

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
  await expect(deck).toHaveCount(0);

  const padCard = page.getByTestId("pad-card");
  await expect(padCard).toBeVisible({ timeout: 15_000 });

  let padId = "";
  await expect
    .poll(
      async () => {
        padId = await page.evaluate(async (canvas) => {
          const read = await window.vellumCommand!.readCanvas(canvas);
          return (
            read.doc.nodes.find((node) => node.ether?.entity?.kind === "pad")?.id ??
            ""
          );
        }, CANVAS);
        return padId.length;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  await page.evaluate(async ([canvas, id]) => {
    const api = window.vellumCommand!;
    const read = await api.readCanvas(canvas);
    if (read.doc.edges.some((edge) => edge.id === "e-seat-pad")) return;
    await api.writeCanvas(
      canvas,
      {
        ...read.doc,
        edges: [
          ...read.doc.edges,
          { id: "e-seat-pad", fromNode: "seat", toNode: id },
        ],
      },
      read.revision,
    );
  }, [CANVAS, padId] as const);

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

  const seen = await readPad(page, padId);
  expect(seen.ok).toBe(true);
  if (!seen.ok) return;
  expect(seen.data.pad.shapes.map((shape) => shape.text)).toContain("api-box");
  expect(seen.data.digest.length).toBeGreaterThan(0);
  expect(seen.data.svg).toMatch(/<svg/i);

  await page.reload();
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await waitForApi(page);
  await expect(page.getByTestId("pad-card")).toBeVisible({ timeout: 15_000 });

  const afterReload = await readPad(page, padId);
  expect(afterReload.ok).toBe(true);
  if (!afterReload.ok) return;
  expect(afterReload.data.pad.shapes.map((shape) => shape.text)).toContain("api-box");
  expect(afterReload.data.pad.revision).toBeGreaterThanOrEqual(seen.data.revision);
});

test("pad work plane: an external patch surfaces in the open pad", async ({
  junto,
}) => {
  const { page } = junto;

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
  await expect(deck).toHaveCount(0);

  const padCard = page.getByTestId("pad-card");
  await expect(padCard).toBeVisible({ timeout: 15_000 });

  let padId = "";
  await expect
    .poll(
      async () => {
        padId = await page.evaluate(async (canvas) => {
          const read = await window.vellumCommand!.readCanvas(canvas);
          return (
            read.doc.nodes.find((node) => node.ether?.entity?.kind === "pad")?.id ??
            ""
          );
        }, CANVAS);
        return padId.length;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  // Open the pad on empty content, then patch it from outside the editor —
  // the call a wired agent makes. The open surface must pick the patch up
  // without closing.
  await page.locator(".react-flow__node").filter({ has: padCard }).dblclick();
  const detail = page.getByTestId("pad-detail");
  await expect(detail).toBeVisible({ timeout: 15_000 });
  const svg = page.getByTestId("pad-svg");
  await expect(svg).toBeVisible();

  const patched = await patchPad(page, padId, [
    {
      op: "upsert",
      layer: "shape",
      shape: {
        id: "external-box" as Pad["shapes"][number]["id"],
        type: "box",
        x: 20,
        y: 20,
        w: 80,
        h: 40,
        z: 0,
        text: "external-box",
      },
    },
  ]);
  expect(patched.ok).toBe(true);
  if (!patched.ok) return;

  await expect(svg.getByText("external-box")).toBeVisible({ timeout: 15_000 });
  await expect(
    detail.getByText(new RegExp(`rev ${patched.data.revision}$`)),
  ).toBeVisible({ timeout: 15_000 });

  await detail.getByRole("button", { name: "Close pad", exact: true }).click();
  await expect(detail).toHaveCount(0);
});
