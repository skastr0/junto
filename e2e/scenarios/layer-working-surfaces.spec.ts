/**
 * Working layer surfaces after their move onto the layer shells.
 *
 * The independent check on each migrated working surface: Settings keeps its
 * frame and closes on Escape and on its dim; the save dialogs sit above what
 * opened them, start in the name field, trap Tab, save on Enter and close on
 * Cancel and on their dim; the agent editor's Escape closes the editor only,
 * and its name field drops typing on Escape and keeps it on a press outside;
 * a profile draft survives Escape; the tour hears its arrows through the
 * shell. Frames land in test-results/layer-working-surfaces/.
 *
 *   bun run test:e2e:fast e2e/scenarios/layer-working-surfaces.spec.ts
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { CanvasDoc } from "../../src/shared/canvas";
import { agentTextNode, terminalTextNode, verbEdge } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "layer-working-surfaces");
const CANVAS = "working";

const seats = ["ada", "bea", "cy"].map((id, index) =>
  agentTextNode({ id: `seat-${id}`, key: `local:working-${id}`, label: id, x: 60 + index * 260, y: 80 }),
);
const nodes = [
  { id: "rg-lab", type: "group" as const, label: "lab", x: 20, y: 20, width: 860, height: 220 },
  ...seats,
  terminalTextNode({
    id: "term-1",
    bindingId: "local:working-term",
    label: "shell",
    launch: { kind: "command", argv: ["/bin/sh", "-c", "exec sleep 3600"] },
    x: 680,
    y: 300,
  }),
];
const board: CanvasDoc = { nodes, edges: [verbEdge("e1", "seat-ada", "seat-bea", "messages", nodes)] };

test.use({ juntoOptions: { seedCanvases: { [CANVAS]: board } } });

const WORKING_DIALOG = '[data-layer="working-dialog"]';

const isOnTop = (target: Locator): Promise<boolean> =>
  target.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit !== null && el.contains(hit);
  });

const setTheme = async (page: Page, theme: "dark" | "bright"): Promise<void> => {
  await page.evaluate((mode) => window.junto!.settingsPatch({ appearance: { theme: mode } }), theme);
  if (theme === "bright") await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
  else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
};

const ready = async (page: Page): Promise<void> => {
  await mkdir(SHOTS, { recursive: true });
  await expect(page.locator('.react-flow__node[data-id="seat-ada"]')).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Fit all nodes" }).click();
  await page.waitForTimeout(400);
};

const seatCentre = async (page: Page, id: string): Promise<{ x: number; y: number }> => {
  const box = (await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

const openEditor = async (page: Page, id = "seat-ada"): Promise<Locator> => {
  const at = await seatCentre(page, id);
  await page.mouse.click(at.x, at.y, { button: "right" });
  await page.getByRole("menuitem", { name: "Edit soul and instructions" }).click();
  const editor = page.getByTestId("agent-editor");
  await expect(editor).toBeVisible();
  return editor;
};

/** Press the dim of the topmost shell, away from its frame. */
const pressDim = async (page: Page): Promise<void> => {
  await page.locator("[data-layer-backdrop]").last().click({ position: { x: 8, y: 8 } });
};

/** Tab and Shift+Tab stay inside `root`. */
const tabStaysInside = async (page: Page, root: Locator): Promise<boolean> => {
  for (const key of ["Tab", "Tab", "Tab", "Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    if (!(await root.evaluate((el) => el.contains(document.activeElement)))) return false;
  }
  return true;
};

test("Settings keeps its frame and closes on Escape and on its dim", async ({ junto }) => {
  const { page } = junto;
  await ready(page);
  const panel = page.locator(".settings-panel");
  const open = async (): Promise<void> => {
    await page.getByRole("button", { name: "Open settings" }).click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await expect(panel).toBeVisible();
  };
  const failures: string[] = [];

  for (const theme of ["dark", "bright"] as const) {
    await setTheme(page, theme);
    await open();
    await page.waitForTimeout(300);
    const frame = await panel.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return {
        width: Math.round(box.width),
        height: Math.round(box.height),
        offCentreX: Math.round(box.left + box.width / 2 - window.innerWidth / 2),
        offCentreY: Math.round(box.top + box.height / 2 - window.innerHeight / 2),
        window: `${String(window.innerWidth)}x${String(window.innerHeight)}`,
      };
    });
    console.log(`WORKING settings ${theme} frame ${JSON.stringify(frame)}`);
    if (frame.width !== 760) failures.push(`${theme}: Settings is ${String(frame.width)} wide, expected 760`);
    if (frame.height > 720) failures.push(`${theme}: Settings is ${String(frame.height)} high, cap is 720`);
    if (Math.abs(frame.offCentreX) > 1 || Math.abs(frame.offCentreY) > 1) failures.push(`${theme}: Settings is off centre by ${String(frame.offCentreX)}, ${String(frame.offCentreY)}`);
    if (!(await panel.evaluate((el) => el.contains(document.activeElement)))) failures.push(`${theme}: Settings does not hold the keyboard after opening`);

    // Every section scrolls inside the frame: the frame never grows or moves.
    const sections = await page.locator(".settings-nav__item").allTextContents();
    for (const section of sections) {
      await page.locator(".settings-nav__item", { hasText: section }).first().click();
      await page.waitForTimeout(120);
      const now = await panel.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const spills = [...el.querySelectorAll("*")].some((child) => {
          const inner = child.getBoundingClientRect();
          return inner.width > 0 && inner.height > 0 && getComputedStyle(child).position !== "fixed" && (inner.bottom > box.bottom + 1 || inner.right > box.right + 1) && (() => {
            for (let up = child.parentElement; up && up !== el.parentElement; up = up.parentElement) {
              const overflow = getComputedStyle(up).overflowY;
              if (overflow === "auto" || overflow === "scroll" || overflow === "hidden" || overflow === "clip") return false;
            }
            return true;
          })();
        });
        return { width: Math.round(box.width), height: Math.round(box.height), spills, pageScroll: document.scrollingElement?.scrollTop ?? 0 };
      });
      if (now.width !== frame.width || now.height !== frame.height) failures.push(`${theme}: section ${section.trim()} resized Settings to ${String(now.width)}x${String(now.height)}`);
      if (now.spills) failures.push(`${theme}: section ${section.trim()} spills outside the Settings frame`);
      if (now.pageScroll !== 0) failures.push(`${theme}: section ${section.trim()} scrolled the page`);
    }
    await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
    await page.screenshot({ path: join(SHOTS, `${theme}-settings.png`) });

    // A select or popover inside Settings opens above it.
    const trigger = panel.locator('[aria-haspopup], [role="combobox"]').first();
    if ((await trigger.count()) > 0) {
      await trigger.click();
      const floating = page.locator('[data-layer="popover"], [data-layer="flyout"], [role="listbox"]:visible, [role="menu"]:visible').last();
      const shown = await floating.waitFor({ state: "visible", timeout: 2_000 }).then(() => true, () => false);
      if (!shown) failures.push(`${theme}: the first popup control in Settings opened nothing`);
      else if (!(await isOnTop(floating))) failures.push(`${theme}: a popover opened from Settings is covered by it`);
      await page.screenshot({ path: join(SHOTS, `${theme}-settings-popover.png`) });
      await page.keyboard.press("Escape");
      if (!(await panel.isVisible())) {
        failures.push(`${theme}: Escape on a popover inside Settings closed Settings too`);
        await open();
      }
    } else {
      console.log(`WORKING settings ${theme}: Appearance has no popup control to open`);
    }

    await page.keyboard.press("Escape");
    if (await panel.waitFor({ state: "hidden", timeout: 3_000 }).then(() => false, () => true)) failures.push(`${theme}: Escape did not close Settings`);
    await open();
    await pressDim(page);
    if (await panel.waitFor({ state: "hidden", timeout: 3_000 }).then(() => false, () => true)) {
      failures.push(`${theme}: a press on the dim did not close Settings`);
      await page.locator(".settings-panel__close").click();
    }
  }
  await setTheme(page, "dark");
  expect(failures, failures.join("\n")).toEqual([]);
});

type SaveFlow = {
  readonly name: string;
  readonly dialogName: string;
  readonly field: string;
  readonly save: string;
  /** Open the dialog; returns what must still be open under it, if anything. */
  readonly open: (page: Page) => Promise<Locator | null>;
};

const selectSeat = async (page: Page, id: string): Promise<void> => {
  const at = await seatCentre(page, id);
  await page.mouse.click(at.x, at.y);
};

const SAVE_FLOWS: readonly SaveFlow[] = [
  {
    name: "profile-from-editor-launch-tab",
    dialogName: "Save as profile",
    field: "Profile name",
    save: "Save profile",
    open: async (page) => {
      const editor = await openEditor(page);
      await page.getByRole("tab", { name: "launch" }).click();
      await editor.getByRole("button", { name: "Save as profile" }).click();
      return editor;
    },
  },
  {
    name: "profile-from-rts-bar",
    dialogName: "Save as profile",
    field: "Profile name",
    save: "Save profile",
    open: async (page) => {
      await selectSeat(page, "seat-bea");
      await page.getByTestId("rts-save-profile").click();
      return null;
    },
  },
  {
    name: "squad-from-three-seats",
    dialogName: "Save as squad",
    field: "Squad name",
    save: "Save squad",
    open: async (page) => {
      await page.keyboard.down("Shift");
      for (const id of ["seat-ada", "seat-bea", "seat-cy"]) await selectSeat(page, id);
      await page.keyboard.up("Shift");
      const at = await seatCentre(page, "seat-cy");
      await page.mouse.click(at.x, at.y, { button: "right" });
      await page.getByRole("menuitem", { name: "Save 3 agents as a squad" }).click();
      return null;
    },
  },
];

test("save dialogs sit above their opener, start in the name, and close cleanly", async ({ junto }) => {
  test.setTimeout(240_000);
  const { page } = junto;
  await ready(page);
  const failures: string[] = [];

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4 && (await page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible').count()) > 0; i += 1) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    }
    await page.mouse.click(5, 300);
    await page.getByRole("button", { name: "Fit all nodes" }).click();
    await page.waitForTimeout(400);
  };

  for (const flow of SAVE_FLOWS) {
    for (const theme of ["dark", "bright"] as const) {
      const at = `${flow.name} ${theme}`;
      await setTheme(page, theme);
      const dialog = page.getByRole("dialog", { name: flow.dialogName });
      const root = page.locator(WORKING_DIALOG);
      const field = dialog.getByRole("textbox", { name: flow.field });

      // Above its opener, in the working dialog layer, keyboard in the name field.
      const below = await flow.open(page);
      await expect(dialog).toBeVisible();
      if ((await root.count()) !== 1) failures.push(`${at}: expected one working dialog shell, found ${String(await root.count())}`);
      if (!(await isOnTop(dialog))) failures.push(`${at}: the dialog is covered`);
      if (below && !(await below.isVisible())) failures.push(`${at}: opening the dialog closed what opened it`);
      const focused = await expect(field).toBeFocused({ timeout: 2_000 }).then(() => true, () => false);
      if (!focused) failures.push(`${at}: focus did not land in the ${flow.field} field`);
      await page.screenshot({ path: join(SHOTS, `${theme}-${flow.name}.png`) });
      if (!(await tabStaysInside(page, root))) failures.push(`${at}: Tab left the dialog`);

      // Cancel closes it and leaves the opener.
      await dialog.getByRole("button", { name: "Cancel" }).click();
      if (await dialog.waitFor({ state: "hidden", timeout: 3_000 }).then(() => false, () => true)) failures.push(`${at}: Cancel did not close the dialog`);
      if (below && !(await below.isVisible())) failures.push(`${at}: Cancel also closed what opened the dialog`);
      await settle();

      // A press on the dim closes it and leaves the opener.
      const belowAgain = await flow.open(page);
      await expect(dialog).toBeVisible();
      await pressDim(page);
      if (await dialog.waitFor({ state: "hidden", timeout: 3_000 }).then(() => false, () => true)) failures.push(`${at}: a press on the dim did not close the dialog`);
      if (belowAgain && !(await belowAgain.isVisible())) failures.push(`${at}: a press on the dialog's dim also closed what opened it`);
      await settle();

      // Enter saves.
      const belowLast = await flow.open(page);
      await expect(dialog).toBeVisible();
      const saved = `${flow.name} ${theme}`;
      await field.fill(saved);
      await page.keyboard.press("Enter");
      if (await dialog.waitFor({ state: "hidden", timeout: 5_000 }).then(() => false, () => true)) failures.push(`${at}: Enter did not save and close`);
      if (belowLast && !(await belowLast.isVisible())) failures.push(`${at}: saving also closed what opened the dialog`);
      if (flow.save === "Save squad") {
        const squads = await page.evaluate(() => window.junto!.squadsList());
        if (!squads.some((squad) => squad.name === saved)) failures.push(`${at}: Enter closed the dialog but no squad named ${saved} was stored`);
      }
      await settle();
    }
  }
  await setTheme(page, "dark");
  expect(failures, failures.join("\n")).toEqual([]);
});

test("the agent editor's Escape closes the editor only, and its name field settles", async ({ junto }) => {
  test.setTimeout(180_000);
  const { page } = junto;
  await ready(page);
  const failures: string[] = [];
  const seatTitle = (id: string): Locator => page.locator(`.react-flow__node[data-id="${id}"]`);

  // Save as profile over the editor: Escape closes the dialog and only the dialog.
  let editor = await openEditor(page);
  await page.getByRole("tab", { name: "launch" }).click();
  await editor.getByRole("button", { name: "Save as profile" }).click();
  const dialog = page.getByRole("dialog", { name: "Save as profile" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  if (!(await editor.isVisible())) {
    failures.push("Escape with Save as profile open over the editor closed the editor too");
    editor = await openEditor(page);
  }

  // Name: typing then Escape closes the editor and drops the typing.
  const name = page.getByTestId("agent-editor-name");
  const showName = async (): Promise<void> => {
    if (!(await name.isVisible())) await page.getByRole("tab", { name: "name", exact: true }).click();
    await expect(name).toBeVisible();
  };
  await showName();
  await name.fill("dropped-name");
  await page.keyboard.press("Escape");
  await expect(editor).not.toBeVisible();
  await page.waitForTimeout(300);
  if ((await seatTitle("seat-ada").textContent())?.includes("dropped-name")) failures.push("Escape in the name field kept the typed name");
  await expect(seatTitle("seat-ada")).toContainText("ada");

  // Typing then a press on the dim keeps it.
  editor = await openEditor(page);
  await showName();
  await name.fill("kept-by-dim");
  await pressDim(page);
  await expect(editor).not.toBeVisible();
  if (!(await expect(seatTitle("seat-ada")).toContainText("kept-by-dim", { timeout: 3_000 }).then(() => true, () => false))) failures.push("a press on the dim dropped the typed name");

  // Typing then Close keeps it.
  editor = await openEditor(page);
  await showName();
  await name.fill("kept-by-close");
  await editor.getByRole("button", { name: "Close customize" }).click();
  await expect(editor).not.toBeVisible();
  if (!(await expect(seatTitle("seat-ada")).toContainText("kept-by-close", { timeout: 3_000 }).then(() => true, () => false))) failures.push("Close dropped the typed name");

  // Enter commits and the editor stays.
  editor = await openEditor(page);
  await showName();
  await name.fill("kept-by-enter");
  await page.keyboard.press("Enter");
  if (!(await expect(seatTitle("seat-ada")).toContainText("kept-by-enter", { timeout: 3_000 }).then(() => true, () => false))) failures.push("Enter did not commit the typed name");
  if (!(await editor.isVisible())) failures.push("Enter in the name field closed the editor");
  else await editor.getByRole("button", { name: "Close customize" }).click();
  await page.screenshot({ path: join(SHOTS, "dark-name-committed.png") });

  expect(failures, failures.join("\n")).toEqual([]);
});

test("the tour hears its arrows through the shell, and Escape ends it", async ({ junto }) => {
  const { page } = junto;
  await ready(page);
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.locator(".settings-nav__item", { hasText: "Advanced" }).click();
  await page.getByRole("button", { name: /show again/i }).click({ timeout: 5_000 });
  const slide = page.getByTestId("first-run-intro-slide");
  await expect(slide).toBeVisible();
  const first = await slide.getAttribute("data-slide");

  await page.keyboard.press("ArrowRight");
  await expect(slide).not.toHaveAttribute("data-slide", first!);
  const second = await slide.getAttribute("data-slide");
  // Wherever focus sits in the tour: on the skip button, the arrows still work.
  await page.getByTestId("first-run-intro-skip").focus();
  await page.keyboard.press("ArrowRight");
  await expect(slide).not.toHaveAttribute("data-slide", second!);
  await page.keyboard.press("ArrowLeft");
  await expect(slide).toHaveAttribute("data-slide", second!);
  await page.keyboard.press("ArrowLeft");
  await expect(slide).toHaveAttribute("data-slide", first!);
  await page.screenshot({ path: join(SHOTS, "dark-tour.png") });

  await page.keyboard.press("Escape");
  await expect(slide).toHaveCount(0);
  await expect(page.locator("[data-layer-backdrop]")).toHaveCount(0);
});
