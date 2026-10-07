/**
 * The Tab ring of a modal never stands on something hidden.
 *   bun run test:e2e:fast e2e/scenarios/tab-ring.spec.ts
 *
 * In Settings, Tab goes round the controls of the modal and nothing else:
 * never the dim behind it (a pointer target, hidden from the keyboard), never
 * anything marked hidden, and never out of the modal. Checked forwards and
 * backwards for more than a full turn of the ring.
 */
import type { Page } from "@playwright/test";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

type Stand = { readonly what: string; readonly hidden: boolean; readonly inside: boolean };

const stand = (page: Page): Promise<Stand> =>
  page.evaluate(() => {
    const active = document.activeElement;
    const surface = document.querySelector("[data-focus-surface]");
    return {
      what: active ? `${active.tagName.toLowerCase()}[${active.getAttribute("aria-label") ?? active.textContent?.trim().slice(0, 30) ?? ""}]` : "nothing",
      hidden:
        active === null ||
        active.matches("[data-layer-backdrop]") ||
        active.closest("[aria-hidden='true'], [inert]") !== null ||
        active.getAttribute("tabindex") === "-1",
      inside: surface !== null && surface.contains(active),
    };
  });

test("Tab in Settings never lands on the dim, on anything hidden, or outside the modal", async () => {
  const junto = await launchJunto({
    seedCanvases: {
      "tab-ring": canvasDoc([agentTextNode({ id: "one", key: "local:e2e-tab-one", label: "One", x: 40, y: 40 })], []),
    },
  });
  try {
    const { page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Open settings" }).click();
    await expect(page.locator("[data-focus-surface]")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(400);

    const wrong: string[] = [];
    const seen = new Set<string>();
    for (const key of ["Tab", "Shift+Tab"]) {
      for (let press = 1; press <= 90; press += 1) {
        await page.keyboard.press(key);
        const at = await stand(page);
        seen.add(at.what);
        if (at.hidden || !at.inside) wrong.push(`${key} ${press}: ${at.what} hidden=${at.hidden} inside=${at.inside}`);
      }
    }
    expect(wrong, "every Tab stop is a visible control of the modal").toEqual([]);
    // The ring really turned: Tab moved through several controls.
    expect(seen.size).toBeGreaterThan(3);
  } finally {
    await junto.close();
  }
});
