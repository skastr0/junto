/**
 * Modal frames: every dialog is one frame. Opens each ship-build modal and
 * overlay in dark and bright, captures it to test-results/modal-frames/, and
 * fails when a dialog nests a fully bordered box that covers a large share of
 * its own frame (a panel inside the panel, a boxed textarea inside a boxed
 * panel). Sections inside the one frame are divided by hairlines, not boxed.
 *
 *   bun run test:e2e:fast e2e/scenarios/modal-frames.spec.ts
 */
import type { Locator, Page } from "@playwright/test";
import type { CanvasDoc } from "../../src/shared/canvas";
import { agentTextNode, terminalTextNode } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = "test-results/modal-frames";
const CANVAS = "frames";

const seats = ["ada", "bea", "cy"].map((id, index) =>
  agentTextNode({ id: `seat-${id}`, key: `local:frames-${id}`, label: id, x: 60 + index * 260, y: 80 }),
);

const board: CanvasDoc = {
  nodes: [
    { id: "rg-lab", type: "group", label: "lab", x: 20, y: 20, width: 860, height: 220 },
    ...seats,
    { id: "note-1", type: "text", text: "# Field notes\n\nThe operator draft stays put.", x: 60, y: 300, width: 260, height: 140 },
    { id: "pad-1", type: "text", text: "pad", x: 380, y: 300, width: 240, height: 120, ether: { entity: { kind: "pad" } } },
    terminalTextNode({ id: "term-1", bindingId: "local:frames-term", label: "shell", x: 680, y: 300 }),
  ],
  edges: [],
};

/** A nested frame is a fully bordered box covering this share of the dialog's own frame. */
const NESTED_SHARE = 0.3;

type Frame = { readonly who: string; readonly share: number };

const nestedFrames = (dialog: Locator): Promise<{ frame: string; nested: Frame[] }> =>
  dialog.evaluate((root, share) => {
    const bordered = (el: Element): boolean => {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
      return (["Top", "Right", "Bottom", "Left"] as const).every((side) => {
        const width = parseFloat(cs.getPropertyValue(`border-${side.toLowerCase()}-width`));
        const style = cs.getPropertyValue(`border-${side.toLowerCase()}-style`);
        const color = cs.getPropertyValue(`border-${side.toLowerCase()}-color`);
        const clear = color === "transparent" || /rgba?\([^)]*,\s*0\)$/.test(color.replace(/\s+/g, " "));
        return width >= 1 && style !== "none" && style !== "hidden" && !clear;
      });
    };
    const area = (el: Element): number => {
      const r = el.getBoundingClientRect();
      return Math.max(0, r.width) * Math.max(0, r.height);
    };
    const name = (el: Element): string =>
      `${el.tagName.toLowerCase()}.${String(el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean).slice(0, 3).join(".")}`;
    const boxes = [root, ...root.querySelectorAll("*")].filter(bordered).sort((a, b) => area(b) - area(a));
    const outer = boxes[0];
    if (!outer) return { frame: "(none)", nested: [] };
    const outerArea = area(outer);
    const nested = boxes
      .slice(1)
      .filter((el) => outer.contains(el) && area(el) / outerArea >= share)
      .map((el) => ({ who: name(el), share: Math.round((area(el) / outerArea) * 100) / 100 }));
    return { frame: name(outer), nested };
  }, NESTED_SHARE);

const setTheme = async (page: Page, theme: "dark" | "bright") => {
  await page.evaluate(async (next) => {
    await window.junto!.settingsPatch({ appearance: { theme: next } });
  }, theme);
  if (theme === "bright") await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
  else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
};

const openDialog = (page: Page): Locator => page.locator('[role="dialog"]:visible').last();

const seatMenu = async (page: Page, id: string) => {
  const box = (await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  await expect(page.getByTestId("seat-menu")).toBeVisible();
};

type Surface = {
  readonly name: string;
  readonly open: (page: Page) => Promise<void>;
  readonly close?: (page: Page) => Promise<void>;
};

const SURFACES: readonly Surface[] = [
  {
    name: "note-editor",
    open: async (page) => {
      await page.locator('.react-flow__node[data-id="note-1"]').click();
      await page.getByRole("button", { name: "Expand note editor" }).click();
      await expect(page.getByRole("dialog", { name: "Edit note" })).toBeVisible();
    },
    close: async (page) => {
      await page.getByRole("dialog", { name: "Edit note" }).getByRole("button", { name: "done", exact: true }).click();
    },
  },
  {
    name: "pad",
    open: async (page) => {
      await page.locator('.react-flow__node[data-id="pad-1"]').dblclick();
      await page.waitForTimeout(600);
    },
  },
  {
    name: "terminal-focus",
    open: async (page) => {
      await page.locator('.react-flow__node[data-id="term-1"]').dblclick();
      await page.waitForTimeout(1_200);
    },
  },
  {
    name: "settings",
    open: async (page) => {
      await page.getByRole("button", { name: "Open settings" }).click();
      await page.waitForTimeout(400);
    },
    close: async (page) => {
      await page.locator(".settings-panel__close").click();
    },
  },
  {
    name: "agent-editor",
    open: async (page) => {
      await seatMenu(page, "seat-ada");
      await page.getByRole("button", { name: "Edit soul and instructions" }).click();
      await expect(page.getByTestId("agent-editor-soul")).toBeVisible();
    },
  },
  {
    name: "save-as-profile",
    open: async (page) => {
      await seatMenu(page, "seat-ada");
      await page.getByRole("button", { name: "Edit soul and instructions" }).click();
      await page.getByRole("tab", { name: "launch" }).click();
      await page.getByRole("button", { name: "Save as profile" }).click();
      await expect(page.getByRole("dialog", { name: "Save as profile" })).toBeVisible();
    },
    close: async (page) => {
      await page.getByRole("dialog", { name: "Save as profile" }).getByRole("button", { name: "Cancel" }).click();
      await page.keyboard.press("Escape");
    },
  },
  {
    name: "save-as-squad",
    open: async (page) => {
      await page.keyboard.down("Shift");
      for (const id of ["seat-ada", "seat-bea", "seat-cy"]) {
        const box = (await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox())!;
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      }
      await page.keyboard.up("Shift");
      const box = (await page.locator('.react-flow__node[data-id="seat-cy"]').boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
      await page.getByRole("button", { name: "Save 3 agents as a squad" }).click();
      await expect(page.getByRole("dialog", { name: "Save as squad" })).toBeVisible();
    },
  },
  {
    name: "operator-feed",
    open: async (page) => {
      await page.keyboard.press("Meta+i");
      await page.waitForTimeout(500);
    },
  },
  {
    name: "command-bar",
    open: async (page) => {
      await page.keyboard.press("Meta+k");
      await expect(page.getByTestId("command-bar-input")).toBeVisible();
    },
  },
  {
    name: "tour",
    open: async (page) => {
      await page.keyboard.press("Meta+k");
      await page.getByTestId("command-bar-input").fill(">tour");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog", { name: "Welcome to Junto" })).toBeVisible();
    },
  },
  {
    name: "new-canvas",
    open: async (page) => {
      await page.getByRole("button", { name: /new canvas/i }).first().click();
      await page.waitForTimeout(300);
    },
  },
  {
    name: "delete-canvas",
    open: async (page) => {
      await page.getByRole("button", { name: "Delete canvas" }).click();
      await page.waitForTimeout(300);
    },
  },
];

test("every modal and overlay is one frame", async () => {
  test.setTimeout(300_000);
  const junto = await launchJunto({ seedCanvases: { [CANVAS]: board } });
  const findings: string[] = [];
  const missing: string[] = [];
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="seat-ada"]')).toBeVisible({ timeout: 30_000 });
    for (const theme of ["dark", "bright"] as const) {
      await setTheme(page, theme);
      for (const surface of SURFACES) {
        await page.getByRole("button", { name: "Fit all nodes" }).click();
        await page.waitForTimeout(400);
        try {
          await surface.open(page);
          const dialog = openDialog(page);
          await expect(dialog).toBeVisible({ timeout: 5_000 });
          await page.waitForTimeout(300);
          await page.screenshot({ path: `${SHOTS}/${theme}-${surface.name}.png` });
          const { frame, nested } = await nestedFrames(dialog);
          console.log(`MODAL-FRAMES ${theme} ${surface.name} frame=${frame} nested=${JSON.stringify(nested)}`);
          for (const box of nested) findings.push(`${theme} ${surface.name}: ${box.who} inside ${frame} (${String(box.share)})`);
        } catch (error) {
          missing.push(`${theme} ${surface.name}: ${String(error).split("\n")[0]}`);
        }
        try {
          if (surface.close) await surface.close(page);
        } catch {
          // fall through to Escape
        }
        for (let i = 0; i < 3 && (await page.locator('[role="dialog"]:visible').count()) > 0; i += 1) {
          await page.keyboard.press("Escape");
          await page.waitForTimeout(200);
        }
        await page.mouse.click(5, 300);
      }
    }
    console.log(`MODAL-FRAMES-MISSING ${JSON.stringify(missing)}`);
    expect(findings, findings.join("\n")).toEqual([]);
  } finally {
    await junto.close();
  }
});
