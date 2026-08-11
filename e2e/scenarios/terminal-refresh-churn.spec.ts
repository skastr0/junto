/**
 * Forced repaints landing during active output.
 *
 * The reported corruption clusters in the live-redraw region — a spinner
 * counter painted into the middle of an unrelated line, a status line drawn
 * twice over a horizontal rule. That is in-place cursor-addressed redrawing
 * going wrong, not scrollback.
 *
 * pushResize() calls term.refresh(0, rows-1) unconditionally, and fires it five
 * times through SETTLE_FITS_MS plus on every ResizeObserver tick. This drives
 * that churn deliberately WHILE output is streaming, then checks the rendered
 * rows still say what was written.
 *
 * The content is strictly increasing numbered lines, so correctness is a
 * property: one marker per row, in order, no repeats.
 */
import { canvasDoc, terminalTextNode } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const LABEL = "e2e refresh churn";
const BINDING_ID = "e2e-churn-1";
const LAUNCH = { kind: "command" as const, argv: ["/bin/sh", "-i"] };

const rowTexts = async (page: import("@playwright/test").Page): Promise<ReadonlyArray<string>> =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll(".native-terminal-surface .xterm-rows > *")).map((el) =>
      (el.textContent ?? "").replace(/ /g, " ").trimEnd(),
    ),
  );

const violations = (rows: ReadonlyArray<string>): ReadonlyArray<string> => {
  const problems: string[] = [];
  const seen = new Map<number, number>();
  let previous: number | undefined;
  rows.forEach((text, index) => {
    const markers = [...text.matchAll(/C(\d{4})/g)].map((m) => Number(m[1]));
    if (markers.length === 0) return;
    if (markers.length > 1) {
      problems.push(
        `row ${index}: ${markers.length} markers on ONE row (${markers.join(",")}) — ${JSON.stringify(text.slice(0, 120))}`,
      );
      return;
    }
    const marker = markers[0]!;
    const earlier = seen.get(marker);
    if (earlier !== undefined) problems.push(`row ${index}: C${marker} already at row ${earlier}`);
    seen.set(marker, index);
    if (previous !== undefined && marker !== previous + 1) {
      problems.push(`row ${index}: expected C${previous + 1}, got C${marker}`);
    }
    previous = marker;
  });
  return problems;
};

test.use({
  vellumOptions: {
    seedCanvases: {
      churn: canvasDoc([
        terminalTextNode({ id: "t1", bindingId: BINDING_ID, label: LABEL, launch: LAUNCH }),
      ]),
    },
  },
});

test("rows survive forced repaints and resizes during live output", async ({ vellumCommand }) => {
  const { page } = vellumCommand;

  const node = page.locator(".react-flow__node", { hasText: LABEL });
  await expect(node).toBeVisible({ timeout: 30_000 });
  await node.dblclick();
  const surface = page.locator(".native-terminal-surface");
  await expect(surface).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2_500);

  // Stream slowly and continuously, with an in-place redrawn status line —
  // the shape every harness paints (write a line, then rewrite the line below
  // it via carriage return, forever).
  await surface.locator(".xterm-screen").click();
  await page.keyboard.type(
    "i=1; while [ $i -le 600 ]; do printf 'C%04d ------------------------------\\n' $i; printf 'status %d\\r' $i; i=$((i+1)); done",
  );
  await page.keyboard.press("Enter");

  // While it streams: resize the window repeatedly. Each resize triggers
  // pushResize -> term.resize + an unconditional full term.refresh().
  const base = page.viewportSize() ?? { width: 1440, height: 900 };
  const found: string[] = [];
  for (let round = 0; round < 8; round += 1) {
    await page.setViewportSize({
      width: base.width - (round % 2 === 0 ? 180 : 60),
      height: base.height - (round % 2 === 0 ? 120 : 40),
    });
    await page.waitForTimeout(350);
    for (const problem of violations(await rowTexts(page))) {
      found.push(`during resize round ${round}: ${problem}`);
    }
  }
  await page.setViewportSize(base);
  await page.waitForTimeout(3_000);

  await page.screenshot({ path: "/tmp/vellum-churn-final.png" });
  for (const problem of violations(await rowTexts(page))) {
    found.push(`after settle: ${problem}`);
  }

  expect(
    found.slice(0, 20),
    `rendered rows disagree with what was written, under repaint/resize churn:\n${found.slice(0, 20).join("\n")}`,
  ).toEqual([]);
});
