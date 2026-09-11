/**
 * Overseer acceptance: human toggle persists authority; viewport is unchanged.
 *
 * Seed the managed seat through writeCanvas without ether.overseer. Grant via
 * the human API (RTS toggle or canvasOverseerSet). Observe the committed
 * document through readCanvas. Do not pan, zoom, fit, or switch canvas.
 *
 * Run: bunx electron-vite build && bun run test:e2e:fast e2e/scenarios/overseer-acceptance.spec.ts
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "overseer-acceptance");
const ARTIFACT = join(
  process.cwd(),
  ".amp/in/artifacts/overseer-acceptance-toggle.png",
);
const SEAT_ID = "overseer-seat";
const ORDINARY_ID = "ordinary-seat";

type Viewport = { readonly x: number; readonly y: number; readonly zoom: number };

type CanvasApi = {
  readonly listCanvases: () => Promise<ReadonlyArray<{ name: string }>>;
  readonly createCanvas: (name: string) => Promise<{ name: string; revision: string }>;
  readonly readCanvas: (name: string) => Promise<{
    readonly name: string;
    readonly revision: string;
    readonly doc: {
      readonly nodes: ReadonlyArray<{
        readonly id: string;
        readonly ether?: { readonly overseer?: boolean };
      }>;
    };
  }>;
  readonly writeCanvas: (
    name: string,
    doc: unknown,
    expectedRevision?: string,
  ) => Promise<unknown>;
  readonly canvasOverseerSet?: (input: {
    readonly canvasName: string;
    readonly nodeId: string;
    readonly overseer: boolean;
    readonly expectedRevision: string;
  }) => Promise<{
    readonly binding: { readonly hostId: string; readonly bindingId: string };
    readonly overseer: boolean;
    readonly affected: ReadonlyArray<{ readonly name: string; readonly revision: string }>;
  }>;
};

const fixtureDoc = canvasDoc([
  agentTextNode({
    id: SEAT_ID,
    key: "local:overseer",
    label: "overseer worker",
    x: 40,
    y: 40,
  }),
  agentTextNode({
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

const waitForApi = async (page: Page): Promise<void> => {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const runtime = globalThis as unknown as {
            readonly vellumCommand?: { readonly listCanvases?: unknown };
          };
          return typeof runtime.vellumCommand?.listCanvases === "function";
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
};

const installBoard = async (page: Page): Promise<string> => {
  await waitForApi(page);
  return page.evaluate(async (document) => {
    const api = (globalThis as unknown as { readonly vellumCommand: CanvasApi })
      .vellumCommand;
    let list = await api.listCanvases();
    let name = list[0]?.name;
    if (!name) {
      const created = await api.createCanvas("overseer-acceptance");
      name = created.name;
    }
    const read = await api.readCanvas(name);
    await api.writeCanvas(name, document, read.revision);
    return name;
  }, fixtureDoc);
};

const readGrant = async (
  page: Page,
  canvasName: string,
  nodeId: string,
): Promise<{ readonly overseer: boolean | undefined; readonly revision: string }> =>
  page.evaluate(
    async ({ name, id }) => {
      const api = (globalThis as unknown as { readonly vellumCommand: CanvasApi })
        .vellumCommand;
      const read = await api.readCanvas(name);
      const node = read.doc.nodes.find((candidate) => candidate.id === id);
      return {
        overseer: node?.ether?.overseer,
        revision: read.revision,
      };
    },
    { name: canvasName, id: nodeId },
  );

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
  return page.evaluate(
    async ({ name, id }) => {
      const api = (globalThis as unknown as { readonly vellumCommand: CanvasApi })
        .vellumCommand;
      if (typeof api.canvasOverseerSet !== "function") {
        throw new Error(
          "Overseer control is unavailable: no rts-overseer and no canvasOverseerSet",
        );
      }
      const read = await api.readCanvas(name);
      const result = await api.canvasOverseerSet({
        canvasName: name,
        nodeId: id,
        overseer: true,
        expectedRevision: read.revision,
      });
      return { path: "ipc" as const, overseer: result.overseer };
    },
    { name: canvasName, id: nodeId },
  );
};

test("human toggle persists overseer authority without moving the viewport", async ({
  vellumCommand,
}) => {
  const { page } = vellumCommand;
  await mkdir(SHOTS, { recursive: true });
  await mkdir(join(process.cwd(), ".amp/in/artifacts"), { recursive: true });

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  const canvasName = await installBoard(page);

  const grantedNode = page.locator(`.react-flow__node[data-id="${SEAT_ID}"]`);
  const ordinaryNode = page.locator(`.react-flow__node[data-id="${ORDINARY_ID}"]`);
  await expect(grantedNode).toBeVisible({ timeout: 30_000 });
  await expect(ordinaryNode).toBeVisible();

  const beforeGrant = await readGrant(page, canvasName, SEAT_ID);
  expect(beforeGrant.overseer, "writeCanvas must not mint overseer").not.toBe(
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

  const card = grantedNode.locator(".vellum-node");
  if ((await card.count()) > 0) {
    await expect(card).toHaveAttribute("data-overseer", "true");
  }
  const mark = grantedNode.getByTestId("overseer-mark");
  if ((await mark.count()) > 0) {
    await expect(mark).toHaveText("OVERSEER");
  }

  await page.screenshot({
    path: join(SHOTS, "toggle-persisted.png"),
    fullPage: false,
  });
  await page.screenshot({ path: ARTIFACT, fullPage: false });
});
