/**
 * Layer invariants: base, working modals, operator modals.
 *
 * Holds the three layer model in the real app. An operator modal opens from
 * anywhere (the canvas, a text field, a focused terminal, any working modal)
 * and lands above it; a dialog opened from a working modal sits above that
 * modal; Escape closes only the topmost layer; the operator modal traps the
 * keyboard and hands it back to where it was; and no surface ever shows two
 * dims at once. Every open must leave the app's operator-modal-open measure;
 * its budget is held by operator-modal-latency.spec.ts. Frames land in
 * test-results/layer-invariants/.
 *
 *   bun run test:e2e:fast e2e/scenarios/layer-invariants.spec.ts
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { CanvasDoc } from "../../src/shared/canvas";
import { agentTextNode, terminalTextNode } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "layer-invariants");
const CANVAS = "layers";

const board: CanvasDoc = {
  nodes: [
    { id: "rg-lab", type: "group", label: "lab", x: 20, y: 20, width: 860, height: 220 },
    ...["ada", "bea", "cy"].map((id, index) =>
      agentTextNode({ id: `seat-${id}`, key: `local:layers-${id}`, label: id, x: 60 + index * 260, y: 80 }),
    ),
    { id: "note-1", type: "text", text: "# Field notes\n\nThe operator draft stays put.", x: 60, y: 300, width: 260, height: 140 },
    terminalTextNode({
      id: "term-1",
      bindingId: "local:layers-term",
      label: "shell",
      launch: { kind: "command", argv: ["/bin/sh", "-c", "printf 'layers-terminal-ready\\r\\n'; exec sleep 3600"] },
      x: 680,
      y: 300,
    }),
  ],
  edges: [],
};

test.use({ juntoOptions: { seedCanvases: { [CANVAS]: board } } });

const OPERATOR = '[data-layer="operator"]';
const OPENER = "data-e2e-opener";

const operatorModal = (page: Page): Locator => page.getByTestId("operator-modal");

/** The element under the centre of `target` belongs to `target`: nothing covers it. */
const isOnTop = (target: Locator): Promise<boolean> =>
  target.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit !== null && el.contains(hit);
  });

/**
 * Every dim on screen, whoever drew it: a visible positioned element covering most
 * of the window that tints or blurs what is behind it. A shell's dim carries
 * data-layer-backdrop; a hand-rolled one shows up here without it.
 */
const dims = (page: Page): Promise<Array<{ who: string; marked: boolean }>> =>
  page.evaluate(() => {
    const windowArea = window.innerWidth * window.innerHeight;
    const out: Array<{ who: string; marked: boolean }> = [];
    const ink = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    for (const el of document.body.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed" && cs.position !== "absolute") continue;
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
      const box = el.getBoundingClientRect();
      if (box.width * box.height < windowArea * 0.9) continue;
      // Paint the colour to read its alpha, whatever notation the browser reports.
      ink.clearRect(0, 0, 1, 1);
      ink.fillStyle = "rgba(0, 0, 0, 0)";
      ink.fillStyle = cs.backgroundColor;
      ink.fillRect(0, 0, 1, 1);
      const opacity = ink.getImageData(0, 0, 1, 1).data[3]! / 255;
      const tints = opacity > 0.02 && opacity < 0.98;
      const blurs = cs.backdropFilter !== "none" && cs.backdropFilter !== "";
      if (!tints && !blurs) continue;
      const cls = String(el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean).slice(0, 2).join(".");
      out.push({ who: `${el.tagName.toLowerCase()}.${cls}`, marked: el.hasAttribute("data-layer-backdrop") });
    }
    return out;
  });

/** Remember where the keyboard is, so a later check can ask if it came back. */
const markOpener = (page: Page): Promise<string> =>
  page.evaluate((attr) => {
    for (const el of document.querySelectorAll(`[${attr}]`)) el.removeAttribute(attr);
    const active = document.activeElement ?? document.body;
    active.setAttribute(attr, "true");
    const cls = String(active.getAttribute("class") ?? "").split(/\s+/).filter(Boolean).slice(0, 2).join(".");
    return `${active.tagName.toLowerCase()}.${cls}`;
  }, OPENER);

const focusIsOnOpener = (page: Page): Promise<boolean> =>
  page.evaluate((attr) => document.activeElement?.hasAttribute(attr) === true, OPENER);

const focusIsInside = (page: Page, selector: string): Promise<boolean> =>
  page.evaluate((sel) => document.activeElement?.closest(sel) != null, selector);

const openLatencies = (page: Page): Promise<Array<{ ms: number; modal: string }>> =>
  page.evaluate(() =>
    performance.getEntriesByName("operator-modal-open").map((entry) => ({
      ms: entry.duration,
      modal: String((entry as PerformanceMeasure).detail?.modal),
    })),
  );

const fitBoard = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "Fit all nodes" }).click();
  await page.waitForTimeout(400);
};

const seatMenu = async (page: Page, id: string): Promise<void> => {
  const box = (await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  await expect(page.getByTestId("seat-menu")).toBeVisible();
};

/** Close whatever is still open, one Escape at a time. */
const closeEverything = async (page: Page): Promise<void> => {
  for (let i = 0; i < 4 && (await page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible').count()) > 0; i += 1) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }
  await page.mouse.click(5, 300);
};

type Origin = {
  readonly name: string;
  /** Open the place the chord is pressed from and put the keyboard in it. */
  readonly enter: (page: Page) => Promise<Locator | null>;
  /** One Escape closes this working modal once the operator modal is gone. */
  readonly escapeCloses: boolean;
};

const ORIGINS: readonly Origin[] = [
  { name: "canvas", enter: async () => null, escapeCloses: false },
  {
    name: "note-editor-text-field",
    enter: async (page) => {
      await page.locator('.react-flow__node[data-id="note-1"]').click();
      await page.getByRole("button", { name: "Expand note editor" }).click();
      const editor = page.getByRole("dialog", { name: "Edit note" });
      await expect(editor).toBeVisible();
      await editor.locator("textarea, [contenteditable='true']").first().click();
      return editor;
    },
    escapeCloses: true,
  },
  {
    name: "terminal-focus-view",
    enter: async (page) => {
      await page.locator('.react-flow__node[data-id="term-1"]').dblclick();
      const surface = page.locator(".native-terminal-surface");
      await expect(surface).toBeVisible({ timeout: 30_000 });
      // The grid is painted on a canvas: the status line says when the session is live.
      await expect(surface.locator(".native-terminal-surface__status")).toContainText("control", { timeout: 30_000 });
      await surface.locator(".xterm").first().click();
      return surface;
    },
    escapeCloses: false,
  },
  {
    name: "settings",
    enter: async (page) => {
      await page.getByRole("button", { name: "Open settings" }).click();
      const panel = page.locator(".settings-panel");
      await expect(panel).toBeVisible();
      return panel;
    },
    escapeCloses: true,
  },
  {
    name: "agent-editor-text-field",
    enter: async (page) => {
      await seatMenu(page, "seat-ada");
      await page.getByRole("menuitem", { name: "Edit soul and instructions" }).click();
      const soul = page.getByTestId("agent-editor-soul");
      await expect(soul).toBeVisible();
      await soul.click();
      return soul;
    },
    escapeCloses: false,
  },
];

const CHORDS = [
  { name: "cmd+K", key: "Meta+k", id: "search" },
  { name: "cmd+I", key: "Meta+i", id: "feed" },
] as const;

test("an operator modal opens above anything, and Escape gives the keyboard back", async ({ junto }) => {
  test.setTimeout(420_000);
  const { page } = junto;
  await mkdir(SHOTS, { recursive: true });
  await expect(page.locator('.react-flow__node[data-id="seat-ada"]')).toBeVisible({ timeout: 30_000 });
  expect(await dims(page), "the base layer shows no dim").toEqual([]);

  const failures: string[] = [];
  for (const origin of ORIGINS) {
    for (const chord of CHORDS) {
      const at = `${origin.name}, ${chord.name}`;
      await fitBoard(page);
      const below = await origin.enter(page);
      // A working modal holds the keyboard once it is open.
      if (below) {
        const held = await expect
          .poll(() => below.evaluate((el) => el.contains(document.activeElement) || el.closest('[role="dialog"]')?.contains(document.activeElement) === true), { timeout: 2_000 })
          .toBe(true)
          .then(() => true, () => false);
        if (!held) failures.push(`${at}: the working modal under test never took the keyboard`);
      }
      const opener = await markOpener(page);
      const dimsBelow = await dims(page);
      await page.evaluate(() => performance.clearMeasures("operator-modal-open"));

      await page.keyboard.press(chord.key);
      const modal = operatorModal(page);
      const opened = await modal.waitFor({ state: "visible", timeout: 3_000 }).then(() => true, () => false);
      if (!opened) {
        failures.push(`${at}: the chord did not open the operator modal (keyboard was on ${opener})`);
        await closeEverything(page);
        continue;
      }
      await expect(modal).toHaveAttribute("data-operator-modal", chord.id);
      await expect.poll(() => focusIsInside(page, OPERATOR), { message: `${at}: the operator modal takes the keyboard` }).toBe(true);
      await page.screenshot({ path: join(SHOTS, `${chord.id}-over-${origin.name}.png`) });

      // Above: nothing covers the operator modal, and what it opened over is still there.
      if (!(await isOnTop(modal.locator('[role="dialog"]')))) failures.push(`${at}: the operator modal is covered`);
      if (below && !(await below.isVisible())) failures.push(`${at}: opening the operator modal closed the surface under it`);
      await expect.poll(async () => (await dims(page)).length, { timeout: 2_000 }).toBeGreaterThan(dimsBelow.length).catch(() => undefined);
      const dimsOpen = await dims(page);
      const operatorDims = dimsOpen.length - dimsBelow.length;
      if (operatorDims !== 1) failures.push(`${at}: the operator modal added ${String(operatorDims)} dims, expected 1 (${JSON.stringify(dimsOpen)})`);

      // Trapped: Tab and Shift+Tab never leave the operator modal.
      for (const key of ["Tab", "Tab", "Tab", "Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"]) {
        await page.keyboard.press(key);
        if (!(await focusIsInside(page, OPERATOR))) {
          failures.push(`${at}: ${key} moved the keyboard out of the operator modal`);
          break;
        }
      }
      if (chord.id === "search") {
        // Typing lands in the modal, not in the field or terminal under it.
        const input = page.getByTestId("command-bar-input");
        await input.click();
        await page.keyboard.type("ada");
        await expect(input).toHaveValue("ada");
      }

      await expect.poll(async () => (await openLatencies(page)).length, { timeout: 2_000 }).toBeGreaterThan(0).catch(() => undefined);
      const [latency] = await openLatencies(page);
      console.log(`LAYERS open ${at} opener=${opener} latency=${latency ? `${latency.ms.toFixed(1)}ms ${latency.modal}` : "none"}`);
      if (!latency || latency.modal !== chord.id) failures.push(`${at}: no operator-modal-open measure for ${chord.id}`);

      // Escape closes only the top layer and returns the keyboard.
      await page.keyboard.press("Escape");
      const closed = await modal.waitFor({ state: "detached", timeout: 3_000 }).then(() => true, () => false);
      if (!closed) {
        const under = below ? ((await below.isVisible()) ? "still open" : "closed instead") : "none";
        failures.push(`${at}: Escape did not close the operator modal (surface under it: ${under})`);
        await page.screenshot({ path: join(SHOTS, `escape-ignored-${chord.id}-over-${origin.name}.png`) });
        await closeEverything(page);
        continue;
      }
      if (below && !(await below.isVisible())) failures.push(`${at}: Escape on the operator modal also closed the surface under it`);
      if (!(await focusIsOnOpener(page))) {
        const now = await page.evaluate(() => `${document.activeElement?.tagName.toLowerCase() ?? "none"}.${String(document.activeElement?.getAttribute("class") ?? "")}`);
        failures.push(`${at}: the keyboard did not return to ${opener}; it is on ${now}`);
      }
      const dimsAfter = await dims(page);
      if (JSON.stringify(dimsAfter) !== JSON.stringify(dimsBelow)) failures.push(`${at}: closing left dims ${JSON.stringify(dimsAfter)}, found ${JSON.stringify(dimsBelow)}`);

      if (below && origin.escapeCloses) {
        await page.keyboard.press("Escape");
        if (await below.isVisible()) failures.push(`${at}: a second Escape did not close the working modal`);
      }
      await closeEverything(page);
    }
  }
  expect(failures, failures.join("\n")).toEqual([]);
});

test("a dialog opened from a working modal sits above it, under the operator modal", async ({ junto }) => {
  const { page } = junto;
  await mkdir(SHOTS, { recursive: true });
  await expect(page.locator('.react-flow__node[data-id="seat-ada"]')).toBeVisible({ timeout: 30_000 });
  await fitBoard(page);

  await seatMenu(page, "seat-ada");
  await page.getByRole("menuitem", { name: "Edit soul and instructions" }).click();
  const soul = page.getByTestId("agent-editor-soul");
  await expect(soul).toBeVisible();
  const launchTab = page.getByRole("tab", { name: "launch" });
  await launchTab.click();
  const dialog = page.getByRole("dialog", { name: "Save as profile" });
  const openDialog = async (): Promise<void> => {
    await page.getByRole("button", { name: "Save as profile" }).click();
    await expect(dialog).toBeVisible();
  };

  await openDialog();
  expect(await isOnTop(dialog), "the dialog is above its working modal").toBe(true);
  await expect.poll(() => dialog.evaluate((el) => el.contains(document.activeElement)), { message: "the dialog holds the keyboard" }).toBe(true);
  await page.screenshot({ path: join(SHOTS, "dialog-over-working.png") });
  // Escape closes the dialog and only the dialog.
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(launchTab, "Escape on the dialog leaves its working modal open").toBeVisible();

  // The operator modal still lands above both.
  await openDialog();
  await expect.poll(() => dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await markOpener(page);
  await page.keyboard.press("Meta+k");
  const modal = operatorModal(page);
  await expect(modal).toBeVisible();
  expect(await isOnTop(modal.locator('[role="dialog"]'))).toBe(true);
  await page.screenshot({ path: join(SHOTS, "operator-over-dialog-over-working.png") });

  // Three Escapes, three layers, top first.
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  await expect(dialog).toBeVisible();
  expect(await focusIsOnOpener(page), "the keyboard returns into the dialog").toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(launchTab, "after an operator modal, Escape on the dialog still leaves its working modal open").toBeVisible();
  await page.keyboard.press("Escape");
  await expect(launchTab, "the last Escape closes the working modal").not.toBeVisible();
});

test("under an open dialog the working modal cannot take focus, and Escape closes only the dialog", async ({ junto }) => {
  const { page } = junto;
  await expect(page.locator('.react-flow__node[data-id="seat-ada"]')).toBeVisible({ timeout: 30_000 });
  await fitBoard(page);

  await seatMenu(page, "seat-ada");
  await page.getByRole("menuitem", { name: "Edit soul and instructions" }).click();
  await expect(page.getByTestId("agent-editor-soul")).toBeVisible();
  const launchTab = page.getByRole("tab", { name: "launch" });
  await launchTab.click();
  await page.getByRole("button", { name: "Save as profile" }).click();
  const dialog = page.getByRole("dialog", { name: "Save as profile" });
  await expect(dialog).toBeVisible();

  // Everything under the front modal is inert. Try to put focus back in the
  // editor, the way a late focus call or a screen reader jump would: it does
  // not land, and the dialog keeps the keyboard.
  await launchTab.evaluate((el) => (el as HTMLElement).focus());
  expect(
    await launchTab.evaluate((el) => el === document.activeElement),
    "the modal under the dialog cannot take focus",
  ).toBe(false);
  expect(
    await dialog.evaluate((el) => el.contains(document.activeElement)),
    "the dialog still holds the keyboard",
  ).toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(launchTab, "the editor under the dialog stays open").toBeVisible();

  await page.keyboard.press("Escape");
  await expect(launchTab, "the next Escape closes the editor").not.toBeVisible();
});

test("cmd+K then cmd+I swaps: one operator modal, never two", async ({ junto }) => {
  const { page } = junto;
  await mkdir(SHOTS, { recursive: true });
  await expect(page.locator('.react-flow__node[data-id="seat-ada"]')).toBeVisible({ timeout: 30_000 });
  await fitBoard(page);
  const editor = (await ORIGINS[1]!.enter(page))!;
  await markOpener(page);
  const dimsBelow = await dims(page);
  const modal = operatorModal(page);

  const holds = async (id: "search" | "feed"): Promise<void> => {
    await expect(modal).toHaveCount(1);
    await expect(modal).toHaveAttribute("data-operator-modal", id);
    await expect.poll(() => focusIsInside(page, OPERATOR), { message: `${id} takes the keyboard on a swap` }).toBe(true);
    // The dim fades in: poll until it is painted.
    await expect
      .poll(async () => (await dims(page)).length - dimsBelow.length, { message: `${id}: one operator dim` })
      .toBe(1);
  };

  await page.keyboard.press("Meta+k");
  await holds("search");
  await page.keyboard.press("Meta+i");
  await holds("feed");
  await expect(page.getByTestId("command-bar-input")).toHaveCount(0);
  await page.screenshot({ path: join(SHOTS, "swap-search-to-feed.png") });
  await page.keyboard.press("Meta+k");
  await holds("search");
  await expect(page.getByTestId("operator-feed")).toHaveCount(0);
  await page.keyboard.press("Meta+i");
  await holds("feed");

  // One Escape closes the whole operator layer, not back to the swapped-out
  // modal, and the keyboard returns to where it was before the first chord.
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  await expect(editor).toBeVisible();
  expect(await focusIsOnOpener(page), "the keyboard returns to the note editor field").toBe(true);

  // A modal's own chord closes it.
  await page.keyboard.press("Meta+i");
  await holds("feed");
  await page.keyboard.press("Meta+i");
  await expect(modal).toHaveCount(0);
  await expect(editor).toBeVisible();
  expect(await focusIsOnOpener(page)).toBe(true);
});

type Surface = { readonly name: string; readonly open: (page: Page) => Promise<void> };

const SURFACES: readonly Surface[] = [
  { name: "search", open: async (page) => { await page.keyboard.press("Meta+k"); await expect(operatorModal(page)).toBeVisible(); } },
  { name: "feed", open: async (page) => { await page.keyboard.press("Meta+i"); await expect(operatorModal(page)).toHaveAttribute("data-operator-modal", "feed"); } },
  { name: "note-editor", open: async (page) => { await ORIGINS[1]!.enter(page); } },
  { name: "terminal-focus-view", open: async (page) => { await ORIGINS[2]!.enter(page); } },
  { name: "settings", open: async (page) => { await ORIGINS[3]!.enter(page); } },
  { name: "agent-editor", open: async (page) => { await ORIGINS[4]!.enter(page); } },
  {
    name: "new-canvas",
    open: async (page) => {
      await page.getByRole("button", { name: /new canvas/i }).first().click();
      await expect(page.locator('[data-layer="working-dialog"]')).toBeVisible();
    },
  },
  {
    name: "delete-canvas",
    open: async (page) => {
      await page.getByRole("button", { name: "Delete canvas" }).click();
      await expect(page.locator('[data-layer="working-dialog"]')).toBeVisible();
    },
  },
];

test("no surface shows two dims at once", async ({ junto }) => {
  test.setTimeout(180_000);
  const { page } = junto;
  await expect(page.locator('.react-flow__node[data-id="seat-ada"]')).toBeVisible({ timeout: 30_000 });
  const doubled: string[] = [];
  const board: string[] = [];
  for (const surface of SURFACES) {
    await fitBoard(page);
    await surface.open(page);
    await page.waitForTimeout(300);
    // A content-sized working modal sits in the centre of the window.
    const fit = page.locator(".focus-surface--height-fit:not(.focus-surface--contain-parent) .focus-surface__panel").last();
    if ((await fit.count()) > 0) {
      await expect
        .poll(
          () =>
            fit.evaluate((panel) => {
              const box = panel.getBoundingClientRect();
              return Math.abs(box.top + box.height / 2 - window.innerHeight / 2);
            }),
          { message: `${surface.name}: centred within 1px` },
        )
        .toBeLessThanOrEqual(1);
      board.push(`${surface.name}: fit-height, centred`);
    }
    const found = await dims(page);
    const layer = await page.evaluate(() =>
      [...document.querySelectorAll("[data-layer]")].map((el) => el.getAttribute("data-layer")).join(","),
    );
    // Migrated: the surface renders through a shell, so its dim is the shell's.
    const migrated = found.length > 0 && found.every((dim) => dim.marked);
    board.push(`${surface.name}: dims=${String(found.length)} shell=${migrated ? "yes" : "no"} layers=[${layer}] ${JSON.stringify(found)}`);
    if (found.length > 1) doubled.push(`${surface.name}: ${JSON.stringify(found)}`);
    await closeEverything(page);
    expect(await dims(page), `${surface.name}: closing leaves no dim behind`).toEqual([]);
  }
  console.log(`LAYERS sweep\n${board.join("\n")}`);
  expect(doubled, doubled.join("\n")).toEqual([]);
});
