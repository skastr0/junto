/**
 * Terminal color probe — reads the colors xterm actually paints for SGR output.
 *
 * Real LocalSessionHost + node-pty under the sandboxed HOME. The child emits
 * explicit SGR sequences; the assertion reads inline colors off the DOM
 * renderer's row spans, so it fails when color reaches the surface as plain ink.
 */
import { canvasDoc, terminalTextNode } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const LABEL = "e2e term color";
const BINDING_ID = "e2e-term-color-1";

/**
 * Colored words before the surface attaches (replayed through the screen
 * snapshot), then more colored words well after attach (live stream).
 */
const LAUNCH = {
  kind: "command" as const,
  argv: [
    "/bin/sh",
    "-c",
    "printf '\\033[31mREDRED\\033[0m \\033[32mGRNGRN\\033[0m\\r\\n'; sleep 12; printf '\\033[31mLIVERED\\033[0m \\033[32mLIVEGRN\\033[0m\\r\\n'; exec sleep 3600",
  ],
};

type ColorProbe = {
  readonly ok: boolean;
  readonly reason?: string;
  readonly rendererRoot?: string;
  readonly text?: string;
  readonly colors?: ReadonlyArray<string>;
  readonly spanCount?: number;
};

const probeColors = async (
  page: import("@playwright/test").Page,
): Promise<ColorProbe> =>
  page.evaluate(() => {
    const surface = document.querySelector(".native-terminal-surface");
    if (!surface) return { ok: false, reason: "no .native-terminal-surface" };
    const rows = surface.querySelector(".xterm-rows");
    if (!rows) {
      const canvas = surface.querySelector("canvas");
      return {
        ok: false,
        reason: canvas ? "canvas renderer (no .xterm-rows)" : "no .xterm-rows and no canvas",
      };
    }
    const spans = Array.from(rows.querySelectorAll("span"));
    const colors = spans
      .filter((s) => (s.textContent ?? "").trim().length > 0)
      .map((s) => getComputedStyle(s).color);
    return {
      ok: true,
      rendererRoot: ".xterm-rows",
      text: (rows.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
      colors: Array.from(new Set(colors)),
      spanCount: spans.length,
    };
  });

test.use({
  juntoOptions: {
    seedCanvases: {
      term: canvasDoc([
        terminalTextNode({
          id: "t1",
          bindingId: BINDING_ID,
          label: LABEL,
          launch: LAUNCH,
        }),
      ]),
    },
  },
});

test("xterm paints SGR colors, not flat ink", async ({ junto }) => {
  const { page } = junto;

  const node = page.locator(".react-flow__node", { hasText: LABEL });
  await expect(node).toBeVisible({ timeout: 30_000 });
  await node.dblclick();

  const surface = page.locator(".native-terminal-surface");
  await expect(surface).toBeVisible({ timeout: 30_000 });

  await expect
    .poll(async () => (await probeColors(page)).text ?? "", { timeout: 30_000 })
    .toContain("REDRED");

  const replayed = await probeColors(page);
  console.log("[color-probe] after attach (replayed screen)", JSON.stringify(replayed, null, 2));

  // Second batch arrives on the live stream, long after attach.
  await expect
    .poll(async () => (await probeColors(page)).text ?? "", { timeout: 40_000 })
    .toContain("LIVERED");

  const live = await probeColors(page);
  console.log("[color-probe] after live write", JSON.stringify(live, null, 2));

  expect(live.ok, live.reason ?? "probe failed").toBe(true);
  // Flat ink means every painted span shares one color.
  expect(
    (live.colors ?? []).length,
    `distinct span colors: ${JSON.stringify(live.colors)}`,
  ).toBeGreaterThan(1);
});
