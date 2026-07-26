import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, launchVellum, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "design-audit");

test("managed harnesses are direct palette actions with cascading choices", async () => {
  await mkdir(SHOTS, { recursive: true });
  const vellum = await launchVellum();

  try {
    const { page } = vellum;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: "Add canvas item" }).click();

    for (const label of ["Claude Code", "Codex", "Grok", "Hermes"]) {
      await expect(
        page.getByRole("button", { name: `Add ${label} agent` }),
      ).toBeVisible();
    }
    await expect(page.getByText("New managed agent")).toHaveCount(0);

    await page.getByRole("button", { name: "Add Claude Code agent" }).hover();
    await expect(
      page.getByRole("menu", { name: "Claude Code models" }),
    ).toBeVisible();

    await page.screenshot({
      path: join(SHOTS, "20b-agent-cascade.png"),
      fullPage: false,
    });

    await page.keyboard.press("Escape");
    const viewport = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    await page.evaluate(({ x, y }) => {
      document.querySelector(".react-flow__pane")?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: x,
          clientY: y,
        }),
      );
    }, { x: viewport.width - 4, y: viewport.height - 4 });
    const contextPalette = page.locator(".node-palette--context").filter({
      has: page.getByRole("textbox", { name: "Filter add menu" }),
    });
    await expect(contextPalette).toBeVisible();
    const box = await contextPalette.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(8);
    expect(box!.y).toBeGreaterThanOrEqual(8);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width - 8);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height - 8);
  } finally {
    await vellum.close();
  }
});
