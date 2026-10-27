/**
 * The pad's look in the real app: an agent writes a small flow (every shape
 * kind, statuses, labelled edges, a seat card) and the pad is shot fitted,
 * with a shape selected, in both themes.
 *
 *   bun run test:e2e:fast e2e/scenarios/pad-look.spec.ts
 *
 * Writes test-results/pad-look/*.png (PAD_LOOK_LABEL prefixes the names).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { mentionHref } from "../../src/shared/mention";
import { asNodeId, Node } from "../../src/shared/model";
import { mintOpId } from "../../src/shared/resource-command";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelRegion, modelSeat } from "../harness/model";

const CANVAS = "pad-look";
const OUT = "test-results/pad-look";
const LABEL = process.env.PAD_LOOK_LABEL ?? "after";

const shot = async (page: Page, name: string) => {
  mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(300);
  await page.locator(".pad-stage").screenshot({ path: join(OUT, `${LABEL}-${name}.png`) });
};

test("the pad draws an agent's flow legibly in both themes", async () => {
  test.setTimeout(180_000);
  const scout = modelSeat({ id: "scout", key: "local:look-scout", label: "Scout", harness: "codex", x: 40, y: 300 });
  const shelf = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({
    kind: "artifacts",
    id: "shelf",
    label: "Shelf",
    x: 40,
    y: 40,
    width: 280,
    height: 160,
    z: 0,
  });
  const region = modelRegion({ id: "ops", label: "Ops", x: 0, y: 0, width: 1600, height: 900 });
  const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture([region, shelf, scout], []) } });
  try {
    const { page } = junto;
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    const card = page.locator('.react-flow__node[data-id="shelf"]');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.dblclick();
    await expect(page.getByRole("list", { name: "Artifacts" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "New artifact" }).click();
    await page.getByRole("group", { name: "New artifact" }).locator("button").filter({ hasText: "Pad" }).click();
    const meta = page.locator(".artifact-head__meta");
    await expect(meta).toHaveText("Pad, version 1", { timeout: 15_000 });

    const head = await page.evaluate(
      async ({ canvas, node }) => {
        const heads = await window.junto!.resource!.artifact!.list(canvas, node);
        const pad = heads.find((h) => h.artifact.type === "pad")!;
        return { id: pad.artifact.artifactId, version: pad.artifact.version };
      },
      { canvas: CANVAS, node: asNodeId("shelf") },
    );
    const seat = mentionHref({ kind: "seat", nodeId: asNodeId("scout") }, CANVAS);
    const s = (id: string, type: string, x: number, y: number, w: number, h: number, more: Record<string, unknown> = {}) => ({
      op: "upsert",
      layer: "shape",
      shape: { id, type, x, y, w, h, z: 0, ...more },
    });
    const e = (id: string, from: string, to: string, more: Record<string, unknown> = {}) => ({
      op: "upsert",
      layer: "edge",
      edge: { id, from, to, ...more },
    });
    const patches = [
      s("start", "ellipse", 0, 40, 140, 70, { text: "Request in", status: "done" }),
      s("plan", "box", 220, 30, 180, 90, { text: "Plan the pad work with the region" }),
      s("ready", "diamond", 480, 20, 150, 110, { text: "Ready?" }),
      s("build", "box", 720, 30, 180, 90, { text: "Agent step", status: "active" }),
      s("store", "cylinder", 720, 200, 180, 110, { text: "junto.db" }),
      s("stuck", "triangle", 480, 210, 150, 110, { text: "Blocked", status: "blocked" }),
      s("note", "label", 0, 200, 260, 40, { text: "Agents draw the flow, the operator reads it" }),
      ...(seat ? [s("who", "card", 220, 220, 220, 72, { href: seat, label: "Scout" })] : []),
      e("e1", "start", "plan"),
      e("e2", "plan", "ready"),
      e("e3", "ready", "build", { label: "yes" }),
      e("e4", "ready", "stuck", { label: "no" }),
      e("e5", "build", "store", { label: "writes" }),
    ];
    await page.evaluate(
      ({ canvas, node, id, version, patches, opId }) =>
        window.junto!.resource!.artifact!.apply(canvas, node, id as never, opId, {
          op: "edit",
          edit: { kind: "patch", type: "pad", baseVersion: version, patches },
        } as never),
      { canvas: CANVAS, node: asNodeId("shelf"), id: head.id, version: head.version, patches, opId: mintOpId() },
    );
    await expect(meta).not.toHaveText("Pad, version 1", { timeout: 10_000 });
    await page.getByRole("button", { name: "Fit view" }).click();
    await shot(page, "flow-dark");

    const svg = page.getByTestId("pad-svg");
    const ready = page.locator('g[data-shape-id="ready"]');
    if ((await ready.count()) > 0) {
      const box = (await ready.boundingBox())!;
      await svg.click({ position: { x: box.x - (await svg.boundingBox())!.x + box.width / 2, y: box.y - (await svg.boundingBox())!.y + box.height / 2 } });
      await shot(page, "selected-dark");
      await page.keyboard.press("Escape");
    }

    // Connectors: a hovered shape shows its ports; a port dragged onto another shape writes an edge.
    const centre = async (id: string) => {
      const b = (await page.locator(`g[data-shape-id="${id}"]`).boundingBox())!;
      return { x: b.x + b.width / 2, y: b.y + b.height / 2, b };
    };
    const edgesBefore = await page.getByTestId("pad-edge").count();
    const store = await centre("store");
    await page.mouse.move(store.x, store.y);
    await expect(page.getByTestId("pad-port")).toHaveCount(4);
    await shot(page, "ports-dark");
    const versionBefore = await meta.textContent();
    const stuck = await centre("stuck");
    await page.mouse.move(store.b.x, store.y);
    await page.mouse.down();
    await page.mouse.move((store.b.x + stuck.x) / 2, store.y, { steps: 6 });
    await page.mouse.move(stuck.x, stuck.y + 10, { steps: 6 });
    await expect(page.getByTestId("pad-edge-draft")).toHaveAttribute("data-target", "stuck");
    await shot(page, "snapping-dark");
    await page.mouse.up();
    await expect(page.getByTestId("pad-edge")).toHaveCount(edgesBefore + 1, { timeout: 10_000 });
    await expect(meta).not.toHaveText(versionBefore ?? "", { timeout: 10_000 });

    // The connect tool starts anywhere on a shape.
    await svg.click({ position: { x: 8, y: 8 } });
    await page.keyboard.press("a");
    await expect(page.getByTestId("pad-tool-connect")).toHaveAttribute("aria-pressed", "true");
    const start = await centre("start");
    const note = await centre(seat ? "who" : "plan");
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(note.x, note.y, { steps: 8 });
    await page.mouse.up();
    await expect(page.getByTestId("pad-edge")).toHaveCount(edgesBefore + 2, { timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("pad-tool-select")).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Fit view" }).click();
    await shot(page, "connected-dark");

    // By keyboard: Enter picks the first shape, Tab walks, and the connect tool walks targets and writes with Enter.
    const spoken = page.getByTestId("pad-spoken");
    await svg.focus();
    await page.keyboard.press("Escape");
    await svg.focus();
    await page.keyboard.press("Enter");
    await expect(spoken).toContainText(/^Selected .+, 1 of \d+$/u);
    await page.keyboard.press("Tab");
    await expect(spoken).toContainText(/, 2 of \d+$/u);
    const edgesNow = await page.getByTestId("pad-edge").count();
    await page.keyboard.press("a");
    await page.keyboard.press("Tab");
    await expect(spoken).toContainText(/^Connect .+ to .+, Enter connects$/u);
    await shot(page, "key-connect-dark");
    await page.keyboard.press("Enter");
    await expect(spoken).toContainText(/^Connected .+ to .+/u, { timeout: 10_000 });
    await expect(page.getByTestId("pad-edge")).toHaveCount(edgesNow + 1);
    await page.keyboard.press("Escape");

    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "bright" } }));
    await expect(page.locator("html")).toHaveAttribute("data-theme", "bright", { timeout: 5_000 });
    await shot(page, "flow-bright");
  } finally {
    await junto.close();
  }
});
