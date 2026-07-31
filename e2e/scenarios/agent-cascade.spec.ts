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
        page.getByRole("button", { name: new RegExp(`${label} agent`) }),
      ).toBeVisible();
    }
    await expect(page.getByText("New managed agent")).toHaveCount(0);

    await page
      .getByRole("button", { name: /Claude Code agent/ })
      .hover();
    const models = page.getByRole("menu", { name: "Claude Code models" });
    await expect(models).toBeVisible();

    await page.screenshot({
      path: join(SHOTS, "20b-agent-cascade.png"),
      fullPage: false,
    });

    await models.getByRole("menuitem").first().click();
    const location = page.getByRole("dialog", {
      name: "Choose agent location",
    });
    await expect(location).toBeVisible();
    await expect(location.getByLabel("Agent host")).toBeVisible();
    await expect(location.getByLabel("Agent working directory")).toHaveValue(
      /^\//,
      { timeout: 10_000 },
    );
    await expect(
      location.getByRole("button", { name: "create agent" }),
    ).toBeVisible();
    await expect(
      location.getByRole("button", { name: "create agent" }),
    ).toBeEnabled();
    await page.screenshot({
      path: join(SHOTS, "20c-agent-location.png"),
      fullPage: false,
    });
    await location.getByRole("button", { name: "cancel" }).click();

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

/**
 * The path taken through the cascade has to stay readable once the pointer has
 * moved on — otherwise the effort column is a list of bare words belonging to
 * a model you can no longer see.
 */
test("the cascade shows which harness and model the open column belongs to", async () => {
  await mkdir(SHOTS, { recursive: true });
  const vellum = await launchVellum();

  try {
    const { page } = vellum;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Add canvas item" }).click();

    const harnessRow = page.getByRole("button", { name: /Claude Code agent/ });
    await harnessRow.hover();
    const models = page.getByRole("menu", { name: "Claude Code models" });
    await expect(models).toBeVisible();
    await expect(
      page.locator(".agent-cascade__caption-parent").first(),
    ).toHaveText("Claude Code");

    const model = models.getByRole("menuitem").first();
    const modelName = (await model.textContent())?.trim() ?? "";
    await model.hover();
    const efforts = page.getByRole("menu", { name: new RegExp(`${modelName} effort`) });
    await expect(efforts).toBeVisible();

    // Pointer in the effort column: both earlier steps stay lit, and the column
    // says whose efforts these are.
    await efforts.getByRole("menuitem").first().hover();
    await expect(harnessRow).toHaveAttribute("aria-expanded", "true");
    await expect(model).toHaveAttribute("aria-expanded", "true");
    await expect(
      page.locator(".agent-cascade__caption-parent").last(),
    ).toHaveText(modelName);

    await page.screenshot({
      path: join(SHOTS, "20f-agent-cascade-path.png"),
      fullPage: false,
    });
    await page.keyboard.press("Escape");
  } finally {
    await vellum.close();
  }
});

/**
 * End-to-end keyboard path: filter → actor → model (→ effort) → location.
 * Pointer hover must not be required for the cascade to be operable.
 */
test("agent cascade is fully keyboard navigable", async () => {
  const vellum = await launchVellum();

  try {
    const { page } = vellum;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: "Add canvas item" }).click();
    const filter = page.getByRole("textbox", { name: "Filter add menu" });
    await expect(filter).toBeFocused();

    await filter.fill("grok");
    // Enter opens the cascade with focus regardless of mirrored side.
    await page.keyboard.press("Enter");

    const models = page.getByRole("menu", { name: "Grok models" });
    await expect(models).toBeVisible();
    const firstModel = models.getByRole("menuitem").first();
    await expect(firstModel).toBeFocused({ timeout: 10_000 });

    // Horizontal arrows follow cascade side (→ = visual right). Deeper column
    // may sit left when the menu is mirrored — probe with the model row's
    // aria-haspopup path, then commit.
    const hasSubmenu = (await firstModel.getAttribute("aria-haspopup")) === "menu";
    if (hasSubmenu) {
      const cascade = page.locator(".agent-cascade");
      const opensLeft =
        (await cascade.evaluate((el) => getComputedStyle(el).flexDirection)) ===
        "row-reverse";
      await page.keyboard.press(opensLeft ? "ArrowLeft" : "ArrowRight");
      const effort = page.getByRole("menu", { name: /effort$/ });
      await expect(effort).toBeVisible();
      await expect(effort.getByRole("menuitem").first()).toBeFocused();
      // Retreat toward the model column (visual direction, not logical depth).
      await page.keyboard.press(opensLeft ? "ArrowRight" : "ArrowLeft");
      await expect(firstModel).toBeFocused();
    }
    await page.keyboard.press("Enter");
    const location = page.getByRole("dialog", { name: "Choose agent location" });
    await expect(location).toBeVisible({ timeout: 10_000 });
    await expect(location.getByLabel("Agent host")).toBeVisible();
    await expect(location.getByLabel("Agent working directory")).toBeVisible();

    // Form is tabbable; Escape closes the dialog without requiring the pointer.
    await page.keyboard.press("Escape");
    await expect(location).toHaveCount(0);
  } finally {
    await vellum.close();
  }
});
