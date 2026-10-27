/**
 * The 0.10.3 artifacts rebuild, from the briefs, in the real app. One test per
 * piece, each named for its owner; a piece not landed yet is marked test.fail
 * with what it waits on, so the suite stays green and the marker flips (Playwright
 * reports "expected to fail" passing) the moment the piece lands.
 *
 *   document live edit (product-documents): click a line, edit, move off, a new version, history
 *   comment on a selection (product-documents, product-sheet): the quote, the rail, the mark
 *   comments rail (product-sheet): collapsed by default, toggles by click and key, count, faces
 *   sidebar and room (product-sheet): narrow sidebar, the open sheet and pad get the width
 *   sheet (product-sheet): a typed cell saves a version and the grid fits
 *   pad (product-pad): draw, pan three ways, tool change inside one frame budget
 *
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/artifacts-rebuild.spec.ts
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { asNodeId, Node } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelRegion, modelSeat } from "../harness/model";

const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/artifacts-rebuild";
const shelfAt = (x: number, y: number) =>
  Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({ kind: "artifacts", id: "shelf", label: "Shelf", x, y, width: 280, height: 160, z: 0 });

/** Tool change, input to the frame that paints it, at p95. The brief's pain was about a second. */
const TOOL_CHANGE_P95_MS = 100;

const shot = async (page: Page, name: string): Promise<void> => {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

const seedDocument = (page: Page, canvas: string, title: string, markdown: string) =>
  page.evaluate(
    ({ canvas, node, artifactId, opId, title, markdown }) =>
      window.junto!.resource!.artifact!.apply(canvas, node, artifactId, opId, { op: "create", title, body: { type: "document", markdown } }),
    { canvas, node: asNodeId("shelf"), artifactId: mintItemId(), opId: mintOpId(), title, markdown },
  );

const openShelf = async (page: Page): Promise<void> => {
  const card = page.locator('.react-flow__node[data-id="shelf"]');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.dblclick();
  await expect(page.getByRole("list", { name: "Artifacts" })).toBeVisible({ timeout: 20_000 });
};

const pick = async (page: Page, title: string): Promise<void> => {
  await page.getByRole("list", { name: "Artifacts" }).locator("button").filter({ hasText: title }).first().click();
  await expect(page.locator(".artifact-head__title")).toHaveValue(title, { timeout: 15_000 });
};

const create = async (page: Page, noun: "Document" | "Sheet" | "Pad"): Promise<void> => {
  await page.getByRole("button", { name: "New artifact" }).click();
  await page.getByRole("group", { name: "New artifact" }).locator("button").filter({ hasText: noun }).click();
  await expect(page.locator(".artifact-head__meta")).toHaveText(`${noun}, version 1`, { timeout: 15_000 });
};

/** Input to the second frame after it. */
const frameAfter = async (page: Page, run: () => Promise<void>): Promise<number> => {
  const t0 = await page.evaluate(() => performance.now());
  await run();
  const t1 = await page.evaluate(() => new Promise<number>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())))));
  return t1 - t0;
};

const DOC = ["# Launch plan", "", "The pitch lands on **the desktop app** first.", "", "- Write the notes", "- Ship the build"].join("\n");

test("document live edit (product-documents): click a line, edit in place, move off, a new version in history", async () => {
  test.setTimeout(240_000);
  const canvas = "rebuild-doc";
  const junto = await launchJunto({ windowContentSize: { width: 1500, height: 900 }, seedModels: { [canvas]: modelFixture([shelfAt(60, 60)], []) } });
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="shelf"]')).toBeVisible({ timeout: 30_000 });
    await seedDocument(page, canvas, "Launch plan", DOC);
    await openShelf(page);
    await pick(page, "Launch plan");
    const meta = page.locator(".artifact-head__meta");
    await expect(meta).toHaveText("Document, version 1");
    const source = page.getByLabel("Markdown");

    // One surface, rendered: no tabs, no markdown showing.
    for (const tab of ["Write", "Split", "Read"]) await expect(page.getByRole("button", { name: tab, exact: true })).toHaveCount(0);
    await expect(source).not.toContainText("**the desktop app**");
    await expect(source).not.toContainText("# Launch");

    // Click a line: only that line shows its markdown.
    await page.locator(".cm-md-strong").click();
    await expect(source).toContainText("**the desktop app**");
    await expect(source).not.toContainText("# Launch");
    await page.keyboard.press("End");
    await page.keyboard.type(" Then the phone.");
    await shot(page, "doc-1-line-open");

    // Move off: it renders, the typing is kept, a version lands.
    await page.locator(".cm-md-h1").click();
    await expect(source).not.toContainText("**the desktop app**");
    await expect(source).toContainText("Then the phone.");
    await expect(meta).toHaveText("Document, version 2", { timeout: 15_000 });

    // History holds both; the old version reads with no caret.
    await page.getByRole("button", { name: "History" }).click();
    const versions = page.getByRole("list", { name: "Versions" });
    await expect(versions.locator("button")).toHaveCount(2, { timeout: 15_000 });
    await versions.locator("button").filter({ hasText: "Version 1" }).click();
    const old = page.getByLabel("Markdown");
    await expect(old).not.toContainText("Then the phone.");
    await expect(old).toHaveAttribute("contenteditable", "false");
    await shot(page, "doc-2-history");
    await page.getByRole("button", { name: "Back to editing" }).first().click();
    await expect(meta).toHaveText("Document, version 2");
  } finally {
    await junto.close();
  }
});

test("comment on a selection (product-documents, product-sheet): quote saved, thread anchored, mark findable when the rail is collapsed", async () => {
  test.setTimeout(240_000);
  const canvas = "rebuild-select";
  const junto = await launchJunto({ windowContentSize: { width: 1500, height: 900 }, seedModels: { [canvas]: modelFixture([shelfAt(60, 60)], []) } });
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="shelf"]')).toBeVisible({ timeout: 30_000 });
    await seedDocument(page, canvas, "Launch plan", DOC);
    await openShelf(page);
    await pick(page, "Launch plan");

    // Select a word: the float offers a comment on it.
    await page.locator(".cm-md-strong").dblclick();
    const float = page.getByRole("button", { name: "Comment on selection" });
    await expect(float).toBeVisible({ timeout: 10_000 });
    await shot(page, "select-1-float");
    await float.click();

    // The rail opens on a draft that carries the quote; posting threads it.
    const field = page.getByLabel("New comment");
    await expect(field).toBeVisible();
    await field.click();
    await page.keyboard.type("Name the phone too");
    await page.keyboard.press("Meta+Enter");
    const threads = page.getByRole("list", { name: "Threads" });
    await expect(threads.locator(".artifact-thread")).toHaveCount(1, { timeout: 20_000 });
    await expect(threads.locator(".artifact-thread").first()).toContainText("Name the phone too");
    await expect(threads.locator(".artifact-thread").first()).toContainText(/desktop/);
    await shot(page, "select-2-thread");

    // Collapsed, the document keeps a mark on the quote; pressing it reopens the rail on that thread.
    await page.keyboard.press("Meta+Shift+M");
    await expect(page.locator(".artifact-comments-edge")).toBeVisible();
    await expect(page.getByTestId("comments-edge-count")).toHaveText("1");
    const mark = page.locator(".artifact-document__anchor");
    await expect(mark).toHaveCount(1, { timeout: 15_000 });
    await shot(page, "select-3-mark");
    await mark.click();
    await expect(threads.locator(".artifact-thread[data-revealed='true']")).toContainText("Name the phone too");
  } finally {
    await junto.close();
  }
});

test("comments rail (product-sheet): collapsed by default, click and key toggle, count and the faces of seats that took part", async () => {
  test.setTimeout(360_000);
  const canvas = "rebuild-rail";
  const folder = mkdtempSync(join(tmpdir(), "junto-rebuild-seat-"));
  const scout = modelSeat({ id: "scout", key: "local:rebuild-scout", label: "Scout", harness: "codex", cwd: folder, x: 40, y: 60 });
  const ops = modelRegion({ id: "ops", label: "Ops", x: 0, y: 0, width: 800, height: 400 });
  const junto = await launchJunto({
    windowContentSize: { width: 1500, height: 900 },
    seedModels: { [canvas]: modelFixture([ops, scout, shelfAt(400, 60)], []) },
    afterSeed: installCrewSeatHarness,
  });
  try {
    const { page, sandbox } = junto;
    await expect(page.locator('.react-flow__node[data-id="shelf"]')).toBeVisible({ timeout: 30_000 });
    const seat = crewSeat(sandbox, canvas, "scout");
    await crewPlayFactory(page);
    await crewOccupySeat(page, canvas, scout, seat);
    expect((await seat.op("onboard", {})).ok, "scout onboards").toBe(true);
    await seedDocument(page, canvas, "Rail doc", "# Rail doc\n\nA line.");
    await openShelf(page);
    await pick(page, "Rail doc");

    // Collapsed by default, and with no comments the edge carries no count and no faces.
    const edge = page.locator(".artifact-comments-edge");
    await expect(edge).toBeVisible();
    await expect(page.getByLabel("New comment")).toHaveCount(0);
    await expect(page.getByTestId("comments-edge-count")).toHaveCount(0);
    await expect(page.getByTestId("comments-edge-seat")).toHaveCount(0);
    await shot(page, "rail-1-empty-edge");

    // Click opens, the key closes, the key opens again.
    await edge.click();
    await expect(page.getByLabel("New comment")).toBeVisible();
    await page.keyboard.press("Meta+Shift+M");
    await expect(edge).toBeVisible();
    await page.keyboard.press("Meta+Shift+M");
    await expect(page.getByLabel("New comment")).toBeVisible();

    // The operator and the seat comment: two posts, one face (the operator is not a seat).
    await page.getByLabel("New comment").click();
    await page.keyboard.type("Operator note");
    await page.keyboard.press("Meta+Enter");
    const listed = await seat.cli(["artifact", "list", "--type", "document"]);
    const docId = (JSON.parse(listed.stdout).data.artifacts as Array<{ id?: string; artifactId?: string; title: string }>).find((a) => a.title === "Rail doc");
    const id = docId?.artifactId ?? docId?.id;
    expect(id, listed.stdout.slice(0, 400)).toBeTruthy();
    const commented = await seat.cli(["artifact", "comment", id!, "Seat note"]);
    expect(JSON.parse(commented.stdout).ok, commented.stdout.slice(0, 400)).toBe(true);
    const threads = page.getByRole("list", { name: "Threads" });
    await expect(threads.locator(".artifact-thread__post")).toHaveCount(2, { timeout: 30_000 });

    await page.keyboard.press("Meta+Shift+M");
    await expect(edge).toBeVisible();
    await expect(edge).toHaveAttribute("aria-label", "Comments, 2");
    await expect(page.getByTestId("comments-edge-count")).toHaveText("2");
    await expect(page.getByTestId("comments-edge-seat")).toHaveCount(1);
    const face = page.getByTestId("comments-edge-seat").first();
    await expect(face).toHaveAttribute("data-seat-id", "scout");
    // A real portrait, not an initial: the portrait engine draws an image or svg.
    await expect(face.locator("img, svg").first()).toBeVisible();
    const edgeBox = (await edge.boundingBox())!;
    expect(edgeBox.width, "the edge is thin").toBeLessThanOrEqual(48);
    await shot(page, "rail-2-count-faces");
  } finally {
    await junto.close();
  }
});

test("sidebar and room (product-sheet): a narrow sidebar, and the open sheet and pad take the width the collapsed rail gives back", async () => {
  test.setTimeout(240_000);
  const canvas = "rebuild-room";
  const junto = await launchJunto({ windowContentSize: { width: 1500, height: 900 }, seedModels: { [canvas]: modelFixture([shelfAt(60, 60)], []) } });
  try {
    const { page } = junto;
    await openShelf(page);
    const widths = () =>
      page.evaluate(() => {
        const w = (sel: string) => Math.round(document.querySelector(sel)?.getBoundingClientRect().width ?? -1);
        return { container: w(".two-pane"), sidebar: w(".two-pane__sidebar"), rail: w(".two-pane__rail"), main: w(".two-pane__main") };
      });
    for (const noun of ["Sheet", "Pad"] as const) {
      await create(page, noun);
      await expect(page.locator(".artifact-comments-edge")).toBeVisible();
      const open = await widths();
      console.log(noun, "ROOM", JSON.stringify(open));
      expect(open.sidebar).toBeGreaterThanOrEqual(176);
      expect(open.sidebar).toBeLessThanOrEqual(208);
      expect(open.rail, "the collapsed rail is an edge").toBeLessThanOrEqual(48);
      expect(open.main, `${noun} gets the room`).toBeGreaterThanOrEqual(open.container - open.sidebar - open.rail - 2);
      await shot(page, `room-${noun.toLowerCase()}-1`);

      await page.getByRole("button", { name: "Sidebar" }).first().click();
      await expect(page.locator(".two-pane[data-sidebar='collapsed']")).toHaveCount(1);
      const wider = await widths();
      expect(wider.main, `${noun} grows when the sidebar collapses`).toBeGreaterThan(open.main + 100);
      await page.getByRole("button", { name: "Sidebar" }).first().click();
      await expect(page.locator(".two-pane[data-sidebar='collapsed']")).toHaveCount(0);
    }
  } finally {
    await junto.close();
  }
});

test("sheet (product-sheet): a typed cell saves a version and the grid fits its pane", async () => {
  test.setTimeout(240_000);
  const canvas = "rebuild-sheet";
  const junto = await launchJunto({ windowContentSize: { width: 1500, height: 900 }, seedModels: { [canvas]: modelFixture([shelfAt(60, 60)], []) } });
  try {
    const { page } = junto;
    await openShelf(page);
    await create(page, "Sheet");
    const sheet = page.getByTestId("artifact-sheet");
    await expect(sheet).toBeVisible();
    const cell = sheet.locator('input[aria-label$=" row 1"]').first();
    await cell.click();
    await page.keyboard.type("Ship 0.10.3");
    await page.keyboard.press("Enter");
    await expect(page.locator(".artifact-head__meta")).toHaveText(/Sheet, version [2-9]/, { timeout: 15_000 });
    await expect(sheet.locator('input[aria-label$=" row 1"]').first()).toHaveValue("Ship 0.10.3");
    const fit = await page.getByTestId("artifact-sheet-grid").evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
    expect(fit.scroll, "a new sheet's grid needs no sideways scroll").toBeLessThanOrEqual(fit.client + 1);
    await shot(page, "sheet-1-typed");
  } finally {
    await junto.close();
  }
});

test("pad (product-pad): draw a box, pan by space-drag, trackpad and middle drag, tool change inside budget", async () => {
  test.setTimeout(240_000);
  const canvas = "rebuild-pad";
  const junto = await launchJunto({ windowContentSize: { width: 1500, height: 900 }, seedModels: { [canvas]: modelFixture([shelfAt(60, 60)], []) } });
  try {
    const { page } = junto;
    await openShelf(page);
    await create(page, "Pad");
    const svg = page.getByTestId("pad-svg");
    await expect(svg).toBeVisible();
    const area = (await svg.boundingBox())!;
    const cx = area.x + area.width / 2;
    const cy = area.y + area.height / 2;

    // Every shape kind the pad model holds is a tool.
    for (const tool of ["select", "box", "ellipse", "triangle", "label", "ink", "image"]) await expect(page.getByTestId(`pad-tool-${tool}`)).toBeVisible();

    // Draw a box: it is selected, and it is on the pad.
    await page.getByTestId("pad-tool-box").click();
    await page.mouse.move(cx - 80, cy - 50);
    await page.mouse.down();
    await page.mouse.move(cx + 80, cy + 50, { steps: 8 });
    await page.mouse.up();
    const selection = page.getByTestId("pad-selection");
    await expect(selection).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".artifact-head__meta")).toHaveText(/Pad, version [2-9]/, { timeout: 15_000 });
    await shot(page, "pad-1-box");

    const at = async () => (await selection.boundingBox())!;
    const moved = async (label: string, pan: () => Promise<void>) => {
      const before = await at();
      await pan();
      await expect.poll(async () => Math.hypot((await at()).x - before.x, (await at()).y - before.y), { message: label, timeout: 5_000 }).toBeGreaterThan(30);
    };

    // Space-drag on empty pad.
    await page.getByTestId("pad-tool-select").click();
    await moved("space-drag pans", async () => {
      await svg.focus();
      await page.mouse.move(area.x + 40, area.y + area.height - 40);
      await page.keyboard.down("Space");
      await page.mouse.down();
      await page.mouse.move(area.x + 140, area.y + area.height - 100, { steps: 8 });
      await page.mouse.up();
      await page.keyboard.up("Space");
    });
    // Two-finger trackpad scroll arrives as wheel without Ctrl.
    await moved("trackpad scroll pans", async () => {
      await page.mouse.move(cx, cy);
      for (let i = 0; i < 6; i += 1) await page.mouse.wheel(20, 12);
    });
    // Middle-button drag.
    await moved("middle drag pans", async () => {
      await page.mouse.move(area.x + 60, area.y + 60);
      await page.mouse.down({ button: "middle" });
      await page.mouse.move(area.x + 160, area.y + 120, { steps: 8 });
      await page.mouse.up({ button: "middle" });
    });
    await shot(page, "pad-2-panned");

    // Tool change paints inside the budget: the brief's pain was about a second.
    const tools = ["box", "ellipse", "triangle", "label", "ink", "select"];
    const ms: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      for (const tool of tools) {
        const button = page.getByTestId(`pad-tool-${tool}`);
        ms.push(await frameAfter(page, () => button.click()));
        await expect(button).toHaveAttribute("aria-pressed", "true");
      }
    }
    const sorted = [...ms].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))]!;
    console.log("PAD TOOL CHANGE ms", JSON.stringify({ p50: Math.round(sorted[Math.floor(sorted.length / 2)]!), p95: Math.round(p95), max: Math.round(sorted.at(-1)!) }));
    expect(p95, `tool change p95 under ${TOOL_CHANGE_P95_MS}ms`).toBeLessThan(TOOL_CHANGE_P95_MS);
  } finally {
    await junto.close();
  }
});
