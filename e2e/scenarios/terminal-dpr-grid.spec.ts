/**
 * Row grid under a FRACTIONAL display scale.
 *
 * Every other render spec runs at device-pixel-ratio 1. The operator is on a
 * scaled Retina display, and fractional scale factors are exactly where a
 * character cell stops being a whole number of device pixels — rows then land
 * on fractional offsets and the error accumulates down the screen, which is
 * what a staircase-edged artifact looks like. Taller terminals are hit harder,
 * and the operator runs 49 rows to this harness's 39.
 *
 * Correctness here is a property, not a picture: every row element must sit on
 * an exact multiple of the row height.
 */
import { canvasDoc, terminalTextNode } from "../harness/sandbox";
import { expect, test } from "../harness/launch";
import { waitForTerminalPaint } from "../harness/term-ready";

const LABEL = "e2e dpr grid";
const LAUNCH = {
  kind: "command" as const,
  argv: ["/bin/sh", "-c", "i=1; while [ $i -le 300 ]; do printf 'D%04d ----------\\r\\n' $i; i=$((i+1)); done; exec sleep 3600"],
};

test.use({
  vellumOptions: {
    electronArgs: ["--force-device-scale-factor=1.5"],
    seedCanvases: {
      dpr: canvasDoc([
        terminalTextNode({ id: "t1", bindingId: "e2e-dpr-1", label: LABEL, launch: LAUNCH }),
      ]),
    },
  },
});

test("rows sit on an exact grid at a fractional device scale factor", async ({ vellumCommand }) => {
  const { page } = vellumCommand;
  const node = page.locator(".react-flow__node", { hasText: LABEL });
  await expect(node).toBeVisible({ timeout: 30_000 });
  await node.dblclick();
  await expect(page.locator(".native-terminal-surface")).toBeVisible({ timeout: 30_000 });
  await waitForTerminalPaint(page, 20);

  const report = await page.evaluate(() => {
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>(".native-terminal-surface .xterm-rows > *"),
    );
    const tops = rows.map((r) => r.getBoundingClientRect().top);
    const heights = rows.map((r) => +r.getBoundingClientRect().height.toFixed(4));
    const deltas = tops.slice(1).map((t, i) => +(t - tops[i]!).toFixed(4));
    const step = deltas[0] ?? 0;
    const first = tops[0] ?? 0;
    const worst = tops
      .map((t, i) => +(t - (first + i * step)).toFixed(3))
      .reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
    return {
      dpr: window.devicePixelRatio,
      count: rows.length,
      rowHeights: [...new Set(heights)],
      stepDeltas: [...new Set(deltas)],
      worstDriftPx: worst,
    };
  });
  console.log("ROWGRID " + JSON.stringify(report));

  expect(report.count, "no rows rendered").toBeGreaterThan(10);
  expect(
    report.stepDeltas.length,
    `row spacing is not uniform at dpr ${report.dpr}: ${JSON.stringify(report.stepDeltas)}`,
  ).toBe(1);
  expect(
    Math.abs(report.worstDriftPx),
    `rows drift ${report.worstDriftPx}px from an exact grid at dpr ${report.dpr}`,
  ).toBeLessThan(0.5);
});
