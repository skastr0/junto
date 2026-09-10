import { expect, launchVellum, test } from "../harness/launch";

for (const seedRetiredCommercialState of [false, true]) {
  test(`opens the application with ${seedRetiredCommercialState ? "stale commercial rows" : "fresh state"}`, async () => {
    const vellumCommand = await launchVellum({ seedRetiredCommercialState });
    try {
      const { page } = vellumCommand;
      await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
      const result = await page.evaluate(async () => {
        const api = window.vellumCommand;
        if (api === undefined) throw new Error("Vellum Command preload API is unavailable");
        const canvases = await api.listCanvases();
        return {
          canvasCount: canvases.length,
          commercialMethods: Object.keys(api).filter((key) => /^license/i.test(key)),
        };
      });
      expect(result.canvasCount).toBeGreaterThan(0);
      expect(result.commercialMethods).toEqual([]);
    } finally {
      await vellumCommand.close();
    }
  });
}
