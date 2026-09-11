/**
 * Pad paint must not become renderer script. Persist a hostile fill,
 * wait for the structural thumb, assert no injected handlers.
 */
import type { Pad, PadPatch } from "../../src/shared/pad";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const CANVAS = "pad-security";
const PAD_ID = "pad-1";
const XSS_FILL =
  `"></rect><image href="x-invalid:" onerror="window.pwned=42"></image><rect fill="`;

const padNode = {
  id: PAD_ID,
  type: "text" as const,
  text: "pad",
  x: 320,
  y: 40,
  width: 240,
  height: 120,
  ether: { entity: { kind: "pad" as const } },
};

test.use({
  vellumOptions: {
    seedCanvases: {
      [CANVAS]: canvasDoc([
        agentTextNode({
          id: "seat",
          key: "local:pad-security",
          label: "seat",
          x: 40,
          y: 40,
        }),
        padNode,
      ]),
    },
  },
});

const waitForApi = async (page: import("@playwright/test").Page): Promise<void> => {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const api = window.vellumCommand;
          return typeof api?.workPadPatch === "function";
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
};

test("hostile pad fill stays data and never executes in the card thumb", async ({
  vellumCommand,
}) => {
  const { page } = vellumCommand;
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await waitForApi(page);

  const patched = await page.evaluate(
    async ([canvas, id, fill]) => {
      const api = window.vellumCommand!;
      (window as unknown as { pwned: number }).pwned = 0;
      const patches: PadPatch[] = [
        {
          op: "upsert",
          layer: "shape",
          shape: {
            id: "xss-box" as Pad["shapes"][number]["id"],
            type: "box",
            x: 0,
            y: 0,
            w: 40,
            h: 20,
            z: 0,
            fill,
            text: "safe",
          },
        },
      ];
      return api.workPadPatch(canvas, id, patches);
    },
    [CANVAS, PAD_ID, XSS_FILL] as const,
  );
  expect(patched.ok).toBe(true);
  if (!patched.ok) return;
  expect(patched.data.pad.shapes[0]?.fill).toBe(XSS_FILL);

  const thumb = page.getByTestId("pad-card-thumb");
  await expect(thumb).toBeVisible({ timeout: 15_000 });
  await expect(thumb.locator("svg")).toBeVisible();
  await expect(thumb.locator("image")).toHaveCount(0);
  await expect(thumb.locator("script")).toHaveCount(0);
  expect(await thumb.locator("[onerror]").count()).toBe(0);
  expect(await thumb.locator("[onload]").count()).toBe(0);
  expect(await thumb.locator("rect").count()).toBeGreaterThan(0);

  const pwned = await page.evaluate(() => (window as unknown as { pwned?: number }).pwned ?? 0);
  expect(pwned).toBe(0);

  const csp = await page.evaluate(() => {
    const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    return meta?.getAttribute("content") ?? "";
  });
  expect(csp).toContain("script-src 'self'");
  expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");

  await page.reload();
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await waitForApi(page);
  await expect(page.getByTestId("pad-card-thumb")).toBeVisible({ timeout: 15_000 });
  const after = await page.evaluate(() => (window as unknown as { pwned?: number }).pwned ?? 0);
  expect(after).toBe(0);
});
