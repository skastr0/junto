/**
 * Real-app check of the pad at HEAD, dark and bright: the look (f3253f1b2), edges that land on the
 * facing side (be6404dfa), connectors (5a4063f70, 96a822547), Cmd+D, redo (8b9c78b0c), the triangle's
 * ports (2274fc219), and cards on the pad (paste a seat link, @, move, resize, connect, double-click,
 * a card whose seat is gone). Frames go to JUNTO_SHOTS_DIR.
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

const CANVAS = "pad-verify";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/pad-lead-check";
const LOAD_SEATS = Number(process.env.PAD_VERIFY_SEATS ?? 40);

test("pad: look, connectors, keys, cards, dark and bright", async () => {
  test.setTimeout(300_000);
  const scout = modelSeat({ id: "scout", key: "local:verify-scout", label: "Scout", harness: "codex", x: 40, y: 300 });
  const crowd = Array.from({ length: LOAD_SEATS }, (_, i) =>
    modelSeat({ id: `c${i}`, key: `local:verify-c${i}`, label: `Crowd ${i}`, x: 700 + (i % 8) * 200, y: 40 + Math.floor(i / 8) * 130 }),
  );
  const shelf = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({ kind: "artifacts", id: "shelf", label: "Shelf", x: 40, y: 40, width: 280, height: 160, z: 0 });
  const region = modelRegion({ id: "ops", label: "Ops", x: 0, y: 0, width: 2600, height: 900 });
  const junto = await launchJunto({ windowContentSize: { width: 1500, height: 900 }, seedModels: { [CANVAS]: modelFixture([region, shelf, scout, ...crowd], []) } });
  const report: Record<string, unknown> = {};
  const shot = async (page: Page, theme: string, name: string) => {
    mkdirSync(join(SHOTS, theme), { recursive: true });
    await page.waitForTimeout(300);
    await page.locator(".pad-stage").screenshot({ path: join(SHOTS, theme, `${name}.png`) });
  };
  try {
    const { page } = junto;
    const log = (k: string, v: unknown) => { report[k] = v; };
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
    const seat = mentionHref({ kind: "seat", nodeId: asNodeId("scout") }, CANVAS)!;
    const ghost = mentionHref({ kind: "seat", nodeId: asNodeId("ghost") }, CANVAS);
    const s = (id: string, type: string, x: number, y: number, w: number, h: number, more: Record<string, unknown> = {}) => ({ op: "upsert", layer: "shape", shape: { id, type, x, y, w, h, z: 0, ...more } });
    const e = (id: string, from: string, to: string, more: Record<string, unknown> = {}) => ({ op: "upsert", layer: "edge", edge: { id, from, to, ...more } });
    const patches = [
      s("start", "ellipse", 0, 40, 140, 70, { text: "Request in", status: "done" }),
      s("plan", "box", 220, 30, 180, 90, { text: "Plan the pad work with the region and its owners" }),
      s("ready", "diamond", 480, 20, 150, 110, { text: "Ready?" }),
      s("build", "box", 720, 30, 180, 90, { text: "Agent step", status: "active" }),
      s("stuck", "triangle", 480, 210, 150, 110, { text: "Blocked", status: "blocked" }),
      s("tiny", "card", 700, 240, 100, 30, { href: seat, label: "Scout" }),
      ...(ghost ? [s("gone", "card", 220, 330, 220, 72, { href: ghost, label: "Old seat" })] : []),
      e("e1", "start", "plan"),
      e("e2", "plan", "ready"),
      e("e3", "ready", "build", { label: "yes" }),
      e("e4", "ready", "stuck", { label: "no" }),
    ];
    await page.evaluate(
      ({ canvas, node, id, version, patches, opId }) =>
        window.junto!.resource!.artifact!.apply(canvas, node, id as never, opId, { op: "edit", edit: { kind: "patch", type: "pad", baseVersion: version, patches } } as never),
      { canvas: CANVAS, node: asNodeId("shelf"), id: head.id, version: head.version, patches, opId: mintOpId() },
    );
    await expect(meta).not.toHaveText("Pad, version 1", { timeout: 10_000 });
    await page.getByRole("button", { name: "Fit view" }).click();
    const svg = page.getByTestId("pad-svg");
    const shapes = () => page.getByTestId("pad-shape").count();
    const centre = async (id: string) => {
      const b = (await page.locator(`g[data-shape-id="${id}"]`).first().boundingBox())!;
      return { x: b.x + b.width / 2, y: b.y + b.height / 2, b };
    };

    for (const theme of ["dark", "bright"] as const) {
      await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
      await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(theme === "bright" ? "bright" : null);
      const f: Record<string, unknown> = {};
      report[theme] = f;
      await page.getByRole("button", { name: "Fit view" }).click();
      await shot(page, theme, "1-look");

      // Card minimum 160x56: the 100x30 card draws at least that.
      const tiny = await page.locator('[data-testid="pad-card"][data-shape-id="tiny"]').boundingBox();
      f.tinyCardOnScreen = tiny ? { w: Math.round(tiny.width), h: Math.round(tiny.height) } : null;
      // A card whose seat is gone is drawn missing under its label.
      f.goneCard = await page.locator('[data-testid="pad-card"][data-shape-id="gone"] [data-testid="preview-card"]').getAttribute("data-kind").catch(() => "none");

      // Ports on hover, per shape, and the triangle's sit on its slanted sides.
      for (const id of ["plan", "stuck"]) {
        const c = await centre(id);
        await page.mouse.move(c.x, c.y);
        await expect(page.getByTestId("pad-port")).toHaveCount(4);
        f[`ports ${id}`] = await page.getByTestId("pad-port").evaluateAll((els, box) => els.map((p) => { const r = p.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2 - (box as { x: number }).x), y: Math.round(r.y + r.height / 2 - (box as { y: number }).y) }; }), { x: c.b.x, y: c.b.y });
        if (id === "stuck") await shot(page, theme, "2-triangle-ports");
      }

      // A drag from a port snaps to the shape and writes an edge and a version.
      const edgesBefore = await page.getByTestId("pad-edge").count();
      const versionBefore = await meta.textContent();
      // Each theme drags a pair no earlier pass joined, so a second pass writes a new edge.
      const [fromId, toId] = theme === "dark" ? (["plan", "build"] as const) : (["ready", "plan"] as const);
      const plan = await centre(fromId);
      const build = await centre(toId);
      await page.mouse.move(plan.x, plan.y);
      await expect(page.getByTestId("pad-port")).toHaveCount(4);
      await page.mouse.move(theme === "dark" ? plan.b.x + plan.b.width : plan.b.x, plan.y);
      await page.mouse.down();
      await page.mouse.move((plan.b.x + build.x) / 2, plan.y - 30, { steps: 6 });
      await page.mouse.move(build.x, build.y + 8, { steps: 8 });
      await expect(page.getByTestId("pad-edge-draft")).toHaveAttribute("data-target", toId);
      await shot(page, theme, "3-snap-draft");
      await page.mouse.up();
      await expect(page.getByTestId("pad-edge")).toHaveCount(edgesBefore + 1, { timeout: 10_000 });
      await expect(meta).not.toHaveText(versionBefore ?? "", { timeout: 10_000 });

      // Connect tool (A) from anywhere on a shape; Escape climbs to select.
      await svg.click({ position: { x: 6, y: 6 } });
      await page.keyboard.press("a");
      await expect(page.getByTestId("pad-tool-connect")).toHaveAttribute("aria-pressed", "true");
      const start = await centre(theme === "dark" ? "start" : "build");
      const stuck = await centre(theme === "dark" ? "stuck" : "start");
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(stuck.x, stuck.y, { steps: 8 });
      await page.mouse.up();
      await expect(page.getByTestId("pad-edge")).toHaveCount(edgesBefore + 2, { timeout: 10_000 });
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("pad-tool-select")).toHaveAttribute("aria-pressed", "true");
      await page.getByRole("button", { name: "Fit view" }).click();
      await shot(page, theme, "4-connected");

      // Cmd+D duplicates the selection; Cmd+Z removes the copy; Cmd+Shift+Z puts it back.
      const c0 = await shapes();
      const sel = await centre("plan");
      await svg.click({ position: { x: sel.x - (await svg.boundingBox())!.x, y: sel.y - (await svg.boundingBox())!.y } });
      await page.keyboard.press("Meta+d");
      await expect.poll(shapes).toBe(c0 + 1);
      await page.keyboard.press("Meta+z");
      await expect.poll(shapes).toBe(c0);
      await page.keyboard.press("Meta+Shift+z");
      await expect.poll(shapes).toBe(c0 + 1);
      f.dupUndoRedo = { before: c0, afterDup: c0 + 1, afterUndo: c0, afterRedo: c0 + 1 };
      await shot(page, theme, "5-duplicate-redo");
      await page.keyboard.press("Meta+z");
      await expect.poll(shapes).toBe(c0);

      // Cards: paste a seat link, then @ and a name.
      await svg.click({ position: { x: 6, y: 6 } });
      const cards0 = await page.getByTestId("pad-card").count();
      await page.evaluate((text) => {
        const dt = new DataTransfer();
        dt.setData("text/plain", text);
        window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      }, seat);
      await expect(page.getByTestId("pad-card")).toHaveCount(cards0 + 1, { timeout: 10_000 });
      const pasted = page.getByTestId("pad-card").last();
      f.pastedSelected = await pasted.getAttribute("data-selected");
      f.pastedKind = await pasted.locator('[data-testid="preview-card"]').getAttribute("data-kind");
      await shot(page, theme, "6-card-pasted");
      await svg.click({ position: { x: 6, y: 6 } });
      await page.keyboard.press("@");
      await expect(page.getByTestId("pad-card-picker")).toBeVisible();
      await page.keyboard.type("Scou");
      await shot(page, theme, "7-at-picker");
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("pad-card")).toHaveCount(cards0 + 2, { timeout: 10_000 });

      // Move, resize and connect the pasted card.
      const before = (await pasted.boundingBox())!;
      await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
      await page.mouse.down();
      await page.mouse.move(before.x + before.width / 2 + 120, before.y + before.height / 2 + 90, { steps: 8 });
      await page.mouse.up();
      const moved = (await pasted.boundingBox())!;
      f.cardMoved = { dx: Math.round(moved.x - before.x), dy: Math.round(moved.y - before.y) };
      expect(Math.abs(moved.x - before.x)).toBeGreaterThan(40);
      await page.mouse.click(moved.x + moved.width / 2, moved.y + moved.height / 2);
      const handles = page.getByTestId("pad-handle");
      f.handles = await handles.count();
      if ((await handles.count()) > 0) {
        const hb = (await handles.last().boundingBox())!;
        await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
        await page.mouse.down();
        await page.mouse.move(hb.x + hb.width / 2 + 60, hb.y + hb.height / 2 + 30, { steps: 6 });
        await page.mouse.up();
        const resized = (await pasted.boundingBox())!;
        f.cardResized = { dw: Math.round(resized.width - moved.width), dh: Math.round(resized.height - moved.height) };
      }
      const edgesNow = await page.getByTestId("pad-edge").count();
      await svg.click({ position: { x: 6, y: 6 } });
      await page.keyboard.press("a");
      const from = await centre("plan");
      const toBox = (await pasted.boundingBox())!;
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 8 });
      await page.mouse.up();
      await expect(page.getByTestId("pad-edge")).toHaveCount(edgesNow + 1, { timeout: 10_000 });
      await page.keyboard.press("Escape");
      await shot(page, theme, "8-card-moved-resized-connected");

      // Double-click a card opens the seat.
      const open = (await pasted.boundingBox())!;
      await page.mouse.dblclick(open.x + open.width / 2, open.y + open.height / 2);
      const front = page.locator(".workbench-pane:not(.workbench-pane--parked) .native-terminal-surface");
      f.dblclickOpened = await front.locator("header").first().innerText({ timeout: 15_000 }).then((t) => t.replace(/\s+/g, " ").slice(0, 60)).catch(() => "nothing opened");
      await shot(page, theme, "9-after-dblclick").catch(() => undefined);
      await page.keyboard.press("Escape");
      if ((await page.getByTestId("pad-svg").count()) === 0) {
        await card.dblclick();
        await page.getByRole("list", { name: "Artifacts" }).locator("button").filter({ hasText: "Untitled pad" }).first().click();
      }
      // Remove the extra cards so the next theme starts as this one did.
      for (let i = 0; i < 2; i += 1) {
        await page.getByTestId("pad-card").last().click({ force: true }).catch(() => undefined);
        await page.keyboard.press("Delete");
      }
    }
    log("loadSeats", LOAD_SEATS);
    console.log("PADREPORT", JSON.stringify(report, null, 1));
  } finally {
    console.log("PADREPORT-PARTIAL", JSON.stringify(report));
    await junto.close();
  }
});
