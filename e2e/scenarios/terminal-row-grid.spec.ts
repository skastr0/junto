import { canvasDoc, terminalTextNode } from "../harness/sandbox";
import { expect, test } from "../harness/launch";
import { waitForTerminalPaint } from "../harness/term-ready";
const LABEL = "e2e rowdrift";
const LAUNCH = { kind: "command" as const, argv: ["/bin/sh","-c","i=1; while [ $i -le 200 ]; do printf 'D%04d ----------\\r\\n' $i; i=$((i+1)); done; exec sleep 3600"] };
test.use({ juntoOptions: { seedCanvases: { drift: canvasDoc([terminalTextNode({ id:"t1", bindingId:"e2e-drift-1", label:LABEL, launch:LAUNCH })]) } } });
test("row elements sit on an exact grid", async ({ junto }) => {
  const { page } = junto;
  const node = page.locator(".react-flow__node", { hasText: LABEL });
  await expect(node).toBeVisible({ timeout: 30_000 });
  await node.dblclick();
  await expect(page.locator(".native-terminal-surface")).toBeVisible({ timeout: 30_000 });
  await waitForTerminalPaint(page, 20);
  const report = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".native-terminal-surface .xterm-rows > *"));
    const tops = rows.map(r => r.getBoundingClientRect().top);
    const heights = rows.map(r => r.getBoundingClientRect().height);
    const deltas = tops.slice(1).map((t,i) => +(t - tops[i]!).toFixed(4));
    const uniq = [...new Set(deltas)];
    const first = tops[0] ?? 0;
    const worst = tops.map((t,i) => +(t - (first + i*(deltas[0]??0))).toFixed(3)).reduce((a,b)=>Math.abs(b)>Math.abs(a)?b:a,0);
    return { count: rows.length, rowHeights: [...new Set(heights.map(h=>+h.toFixed(4)))], stepDeltas: uniq, worstDriftPx: worst };
  });
  console.log("ROWGRID " + JSON.stringify(report));
  expect(report.stepDeltas.length, `row spacing is not uniform: ${JSON.stringify(report.stepDeltas)}`).toBe(1);
  expect(Math.abs(report.worstDriftPx), `rows drift ${report.worstDriftPx}px from an exact grid`).toBeLessThan(0.5);
});
