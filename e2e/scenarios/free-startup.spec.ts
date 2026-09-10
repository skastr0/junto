import { expect, launchVellum, test } from "../harness/launch";

for (const seedRetiredCommercialState of [false, true]) {
  test(`opens offline with ${seedRetiredCommercialState ? "stale commercial rows" : "fresh state"}`, async () => {
    const vellumCommand = await launchVellum({ seedRetiredCommercialState, offline: true });
    try {
      const { page } = vellumCommand;
      await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
      const connectivity = await vellumCommand.app.evaluate(async ({ app, net }) => {
        const requests = await Promise.allSettled([
          globalThis.fetch("https://offline-startup.invalid/"),
          net.fetch("https://offline-startup.invalid/"),
        ]);
        return {
          preloaded: (globalThis as typeof globalThis & {
            __vellumCommandOfflineHarness?: boolean;
          }).__vellumCommandOfflineHarness === true,
          appPath: app.getAppPath(),
          requests: requests.map((request) => request.status),
          errors: requests.map((request) =>
            request.status === "rejected" ? String(request.reason) : "",
          ),
        };
      });
      expect(connectivity.preloaded).toBe(true);
      expect(connectivity.appPath).toBe(process.cwd());
      expect(connectivity.requests).toEqual(["rejected", "rejected"]);
      // Prove harness denial, rather than accepting an unrelated DNS failure.
      expect(connectivity.errors[0]).toContain("E2E external network is offline");
      expect(connectivity.errors[1]).toContain("ERR_TUNNEL_CONNECTION_FAILED");
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
