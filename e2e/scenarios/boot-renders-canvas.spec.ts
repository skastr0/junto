import { textNode, canvasDoc } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const FIXTURE_TEXT = "Hello Junto e2e";

const rendererCanvasCount = async (): Promise<number> => {
  const runtime = globalThis as unknown as {
    readonly vellumCommand?: {
      readonly listCanvases: () => Promise<ReadonlyArray<unknown>>;
    };
  };
  return (await runtime.vellumCommand?.listCanvases())?.length ?? 0;
};

const probeCanceledNavigation = async (
  page: import("@playwright/test").Page,
  target: string,
  committedUrl: string,
) =>
  page.evaluate(
    async ({ targetUrl, expectedUrl, fixtureText }) => {
      const runtime = globalThis as unknown as {
        readonly vellumCommand?: {
          readonly listCanvases: () => Promise<ReadonlyArray<unknown>>;
        };
      };
      globalThis.location.assign(targetUrl);
      // Remain in the old execution context. If navigation commits, this
      // promise is destroyed and the test fails instead of inspecting a new
      // page after the fact.
      await new Promise((resolve) => globalThis.setTimeout(resolve, 150));
      const canvases = await runtime.vellumCommand?.listCanvases();
      return {
        href: globalThis.location.href,
        canvasCount: canvases?.length ?? 0,
        hasFixture: globalThis.document.body.textContent?.includes(fixtureText) ?? false,
        expectedUrl,
      };
    },
    { targetUrl: target, expectedUrl: committedUrl, fixtureText: FIXTURE_TEXT },
  );

test.use({
  vellumOptions: {
    seedCanvases: {
      boot: canvasDoc([textNode("n1", FIXTURE_TEXT, 0, 0)]),
    },
    extraEnv: {
      JUNTO_E2E_RENDERER_SURFACE_TIMEOUT_MS: "5000",
    },
  },
});

test("boots straight into the seeded canvas and renders its node", async ({ vellumCommand }) => {
  const { page } = vellumCommand;

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  const node = page.locator(".react-flow__node", { hasText: FIXTURE_TEXT });
  await expect(node).toBeVisible();

  // A same-authority full reload is a fresh renderer generation: trust and
  // the React surface readiness receipt must both be re-established.
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".react-flow__node", { hasText: FIXTURE_TEXT })).toBeVisible();
  await expect
    .poll(() => page.evaluate(rendererCanvasCount))
    .toBeGreaterThan(0);

  // Stay alive past both watchdog budgets. A valid mount receipt must cancel
  // the active deadline rather than merely winning a short test race.
  await page.waitForTimeout(5_500);
  await expect(page.locator(".react-flow__node", { hasText: FIXTURE_TEXT })).toBeVisible();
  expect(vellumCommand.app.process().exitCode).toBeNull();
});

test("denied off-authority navigation keeps the committed canvas trusted", async ({ vellumCommand }) => {
  const { page } = vellumCommand;
  await expect(page.locator(".react-flow__node", { hasText: FIXTURE_TEXT })).toBeVisible({
    timeout: 30_000,
  });

  const committedUrl = page.url();
  const result = await probeCanceledNavigation(page, "https://attacker.invalid/", committedUrl);
  expect(result).toMatchObject({
    href: committedUrl,
    expectedUrl: committedUrl,
    hasFixture: true,
  });
  expect(result.canvasCount).toBeGreaterThan(0);
});

test("denied redirect restores the committed canvas trust", async ({ vellumCommand }) => {
  const { page } = vellumCommand;
  await expect(page.locator(".react-flow__node", { hasText: FIXTURE_TEXT })).toBeVisible({
    timeout: 30_000,
  });
  // Same-origin redirects are outside the boot contract. Canceling one must
  // restore authority to the still-committed canvas instead of leaving it
  // visible but IPC-dead.
  const committedUrl = page.url();
  const result = await probeCanceledNavigation(page, "/__vellum_redirect", committedUrl);
  expect(result).toMatchObject({
    href: committedUrl,
    expectedUrl: committedUrl,
    hasFixture: true,
  });
  expect(result.canvasCount).toBeGreaterThan(0);
});

const waitForRecoveredCanvas = async (
  app: import("playwright-core").ElectronApplication,
  failedPage: import("@playwright/test").Page,
): Promise<void> => {
  // The recovery destroys the failed window and constructs a replacement.
  // Playwright's window event can resolve to the transient pre-load handle,
  // so assert the OUTCOME instead: the failed page is gone and some live
  // window renders the committed canvas again.
  await expect
    .poll(
      async () =>
        failedPage
          .evaluate(() => 1)
          .then(() => false)
          .catch(() => true),
      { timeout: 20_000 },
    )
    .toBe(true);
  await expect
    .poll(
      async () => {
        for (const window of app.windows()) {
          try {
            const count = await window
              .locator(".react-flow__node", { hasText: FIXTURE_TEXT })
              .count();
            if (count > 0) return true;
          } catch {
            // Window closed between enumeration and inspection.
          }
        }
        return false;
      },
      { timeout: 45_000 },
    )
    .toBe(true);
};

test("a stalled replacement document recovers instead of leaving a black window", async ({ vellumCommand }) => {
  test.setTimeout(60_000);
  const { app, page } = vellumCommand;
  await expect(page.locator(".react-flow__node", { hasText: FIXTURE_TEXT })).toBeVisible({
    timeout: 30_000,
  });

  await page.evaluate(() => {
    globalThis.setTimeout(() => globalThis.location.assign("/__vellum_stall"), 0);
  });

  await waitForRecoveredCanvas(app, page);
  expect(app.process().exitCode).toBeNull();
});

test("a committed document that never mounts recovers through the mount deadline", async ({ vellumCommand }) => {
  const { app, page } = vellumCommand;
  await expect(page.locator(".react-flow__node", { hasText: FIXTURE_TEXT })).toBeVisible({
    timeout: 30_000,
  });

  await page.evaluate(() => {
    globalThis.setTimeout(() => globalThis.location.assign("/__vellum_blank"), 0);
  });

  await waitForRecoveredCanvas(app, page);
  expect(app.process().exitCode).toBeNull();
});
