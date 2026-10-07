/**
 * A plain terminal inside a region gets that region's environment.
 *
 *   bun run test:e2e:fast e2e/scenarios/region-terminal-environment.spec.ts
 *
 * Two shell terminals on one canvas: one inside a region that carries a
 * plain value source, one outside every region. Each runs `env` filtered to
 * the variable; the inside one prints it, the outside one does not. The
 * screen is read through the terminal's own text registry, since the WebGL
 * renderer puts no text in the DOM (TerminalSurface.tsx, __juntoTermScreenText).
 */
import type { Page } from "@playwright/test";
import type { GroupNode } from "../../src/shared/canvas";
import { expect, launchJunto, test } from "../harness/launch";
import { canvasDoc, terminalTextNode } from "../harness/sandbox";

const NAME = "REGION_WALK_VALUE";
const VALUE = "from-the-region";
const SURFACE = ".workbench-pane:not(.workbench-pane--parked) .native-terminal-surface";

const region: GroupNode = {
  id: "region-env",
  type: "group",
  label: "Team",
  x: 40,
  y: 40,
  width: 520,
  height: 360,
  ether: { region: { hold: true, environment: { sources: [{ id: "src-walk", kind: "value", name: NAME, value: VALUE }] } } },
};

const screenOf = (page: Page, bindingId: string): Promise<string> =>
  page.evaluate((id) => {
    const registry = (window as unknown as { __juntoTermScreenText?: Map<string, () => string> }).__juntoTermScreenText;
    return registry?.get(id)?.() ?? "";
  }, bindingId);

/** Open the terminal, run one command in its shell, and return the screen once the end mark shows. */
const runIn = async (page: Page, nodeId: string, bindingId: string, mark: string): Promise<string> => {
  await page.locator(`.react-flow__node[data-id="${nodeId}"]`).dblclick();
  const surface = page.locator(SURFACE);
  await expect(surface).toBeVisible({ timeout: 30_000 });
  await expect(surface.locator(".native-terminal-surface__status")).toContainText("control", { timeout: 30_000 });
  await surface.locator(".xterm-screen").click();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest(".native-terminal-surface") != null))
    .toBe(true);
  // The mark is assembled by the shell, so the typed command line itself never contains it.
  await page.keyboard.type(`env | grep ${NAME}; echo ${mark.slice(0, 4)}""${mark.slice(4)}`);
  await page.keyboard.press("Enter");
  await expect.poll(() => screenOf(page, bindingId), { message: `the shell ran the command in ${nodeId}`, timeout: 30_000 }).toContain(mark);
  const screen = await screenOf(page, bindingId);
  await surface.getByRole("button", { name: "Close view" }).first().click();
  await expect(page.locator(SURFACE)).toHaveCount(0);
  return screen;
};

test("a plain terminal inside a region has the region's variable, and one outside does not", async () => {
  const junto = await launchJunto({
    seedCanvases: {
      regionterm: canvasDoc([
        region,
        terminalTextNode({ id: "term-in", bindingId: "local:term-in", label: "inside", x: 120, y: 140 }),
        terminalTextNode({ id: "term-out", bindingId: "local:term-out", label: "outside", x: 700, y: 140 }),
      ]),
    },
  });
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="term-in"]')).toBeVisible({ timeout: 30_000 });

    const inside = await runIn(page, "term-in", "local:term-in", "done-inside");
    expect(inside, "the terminal inside the region prints the region's variable").toContain(`${NAME}=${VALUE}`);

    const outside = await runIn(page, "term-out", "local:term-out", "done-outside");
    expect(outside, "the terminal outside every region does not have it").not.toContain(`${NAME}=`);
  } finally {
    await junto.close();
  }
});
