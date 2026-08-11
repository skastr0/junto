/**
 * Repaint staleness — does the terminal keep showing what it first painted,
 * even when that paint was wrong?
 *
 * The operator's report: the surface renders corrupted, and "it takes a lot of
 * scrolling up and down to settle the rendering". Scrolling is not the trigger,
 * it is the CURE — which locates the defect precisely. xterm's DOM renderer
 * only repaints rows it believes are damaged; scrolling damages every row and
 * forces a full repaint. If scrolling fixes the screen, then the terminal
 * BUFFER was correct the whole time and only the painted DOM was stale.
 *
 * That makes the bug self-proving, with no external ground truth: the same
 * scroll offset must render identical text before and after scrolling away and
 * back. The buffer cannot change (nothing is written in between), so any
 * difference is the renderer having shown something the buffer never said.
 *
 * Every other PTY test in this repo compares against a model of the screen
 * (SessionObserver, a headless xterm). All of them pass here, because the model
 * is right — the pixels are what lie.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { canvasDoc, terminalTextNode } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const REPO = process.cwd();
const REPLAY_DIR = "/tmp/vellum-real-bytes";
const LABEL = "e2e repaint";
const BINDING_ID = "e2e-repaint-1";
const LAUNCH = { kind: "command" as const, argv: ["/bin/sh", "-i"] };

const materialize = (harness: string, scenario: string): string => {
  const src = join(REPO, "tests/pty-e2e/corpus", harness, `${scenario}.jsonl`);
  const bytes = Buffer.concat(
    readFileSync(src, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => Buffer.from((JSON.parse(line) as { b64: string }).b64, "base64")),
  );
  mkdirSync(REPLAY_DIR, { recursive: true });
  const out = join(REPLAY_DIR, `${harness}-${scenario}.bin`);
  writeFileSync(out, bytes);
  return out;
};

/** Rendered rows exactly as painted, at whatever the current scroll offset is. */
const paintedRows = async (
  page: import("@playwright/test").Page,
): Promise<ReadonlyArray<string>> =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll(".native-terminal-surface .xterm-rows > *")).map((el) =>
      (el.textContent ?? "").replace(/ /g, " ").trimEnd(),
    ),
  );

/**
 * xterm 6 replaced the old `.xterm-viewport` scroller with its own scrollable
 * element, so the scroller must be discovered, not assumed: take whichever
 * descendant actually overflows.
 */
const SCROLLER = `(() => {
  const root = document.querySelector(".native-terminal-surface");
  if (!root) return null;
  const candidates = Array.from(root.querySelectorAll("*"));
  let best = null;
  for (const el of candidates) {
    const node = el;
    if (node.scrollHeight > node.clientHeight + 4) {
      if (!best || node.scrollHeight > best.scrollHeight) best = node;
    }
  }
  return best;
})()`;

/**
 * Real wheel events over the screen. xterm 6 scrolls programmatically — no DOM
 * element in the surface has scroll overflow (the viewport is overflow:hidden
 * and only the visible rows exist in .xterm-rows), so scrollTop is not the
 * mechanism and the wheel is the only honest way to drive it.
 */
const wheel = async (
  page: import("@playwright/test").Page,
  deltaY: number,
  notches: number,
): Promise<void> => {
  const box = await page.locator(".native-terminal-surface .xterm-screen").boundingBox();
  if (!box) throw new Error("no .xterm-screen box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < notches; i += 1) {
    await page.mouse.wheel(0, deltaY);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(300);
};

/** Which line is at the top of the viewport — the rows are numbered R####. */
const topMarker = async (page: import("@playwright/test").Page): Promise<number | undefined> => {
  for (const text of await paintedRows(page)) {
    const m = text.match(/R(\d{4})/);
    if (m) return Number(m[1]);
  }
  return undefined;
};

const scrollMetrics = async (
  page: import("@playwright/test").Page,
): Promise<{ top: number; height: number; client: number; who: string }> =>
  page.evaluate((finder) => {
    const el = eval(finder) as HTMLElement | null;
    return {
      top: el?.scrollTop ?? 0,
      height: el?.scrollHeight ?? 0,
      client: el?.clientHeight ?? 0,
      who: el ? `${el.tagName}.${el.className}` : "NONE",
    };
  }, SCROLLER);

test.use({
  vellumOptions: {
    seedCanvases: {
      repaint: canvasDoc([
        terminalTextNode({ id: "t1", bindingId: BINDING_ID, label: LABEL, launch: LAUNCH }),
      ]),
    },
  },
});

test("the same scroll position renders the same before and after scrolling", async ({
  vellumCommand,
}) => {
  const { page } = vellumCommand;
  const raw = materialize("grok", "working-turn");

  const node = page.locator(".react-flow__node", { hasText: LABEL });
  await expect(node).toBeVisible({ timeout: 30_000 });
  await node.dblclick();
  const surface = page.locator(".native-terminal-surface");
  await expect(surface).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2_000);

  // Real harness bytes, plus enough plain scrollback to have somewhere to
  // scroll to.
  await surface.locator(".xterm-screen").click();
  // Plain numbered scrollback only. (Replaying a harness capture here leaves
  // the terminal in the ALTERNATE screen buffer, which has no scrollback at
  // all — scrollHeight collapses to clientHeight and there is nothing to
  // scroll. Worth a separate look; it is not what this test is measuring.)
  void raw;
  await page.keyboard.type(
    `i=1; while [ $i -le 400 ]; do printf 'R%04d ------------------------------\\n' $i; i=$((i+1)); done`,
  );
  await page.keyboard.press("Enter");
  await page.waitForTimeout(8_000);

  // Scroll up a fixed distance and record what that position renders on FIRST
  // paint, keyed by the line number at the top of the viewport.
  const atBottom = await topMarker(page);
  await wheel(page, -240, 10);
  const anchor = await topMarker(page);
  console.log(`SCROLL PROOF: top line was R${atBottom}, after wheeling up it is R${anchor}`);
  // Without this the whole test is vacuous: if the wheel moved nothing, the
  // "same position" comparison compares a screen to itself.
  expect(
    anchor,
    `the wheel did not move the viewport (top line stayed R${atBottom}) — this test would be meaningless`,
  ).not.toBe(atBottom);
  expect(anchor, "no numbered line visible after scrolling").toBeDefined();
  const firstPaint = await paintedRows(page);

  // The operator's cure: scroll up and down a lot. Nothing is written to the
  // terminal in between, so the BUFFER cannot change.
  for (let sweep = 0; sweep < 5; sweep += 1) {
    await wheel(page, -240, 12);
    await wheel(page, 240, 12);
  }

  // Return to the same anchor line and compare.
  await wheel(page, 240, 40);
  await wheel(page, -240, 10);
  let settledMarker = await topMarker(page);
  for (let nudge = 0; nudge < 30 && settledMarker !== anchor; nudge += 1) {
    await wheel(page, settledMarker! > anchor! ? -240 : 240, 1);
    settledMarker = await topMarker(page);
  }
  const settled = await paintedRows(page);

  const drift: string[] = [];
  if (settledMarker === anchor) {
    const rows = Math.max(firstPaint.length, settled.length);
    for (let row = 0; row < rows; row += 1) {
      if ((firstPaint[row] ?? "") !== (settled[row] ?? "")) {
        drift.push(
          `row ${row}:\n    first paint:     ${JSON.stringify((firstPaint[row] ?? "").slice(0, 110))}\n    after scrolling: ${JSON.stringify((settled[row] ?? "").slice(0, 110))}`,
        );
      }
    }
  }
  await page.screenshot({ path: "/tmp/vellum-repaint-settled.png" });
  expect(
    settledMarker,
    `could not return to the anchor line R${anchor} to compare`,
  ).toBe(anchor);
  expect(
    drift.slice(0, 15),
    `Same viewport position, nothing written in between, ${drift.length} row(s) painted differently. The buffer cannot have changed — the first paint was stale:\n${drift.slice(0, 15).join("\n")}`,
  ).toEqual([]);

});
