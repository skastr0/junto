/**
 * Does the PTY/render width divergence actually mis-wrap real output?
 *
 * Proven separately (terminal-geometry-probe): on reopen the renderer paints a
 * grid the child PTY has not been told about — captured at 135 columns painted
 * against 120 believed. This spec asks the consequence question: if a process
 * writes while that window is open, does the text land wrapped at the wrong
 * column and stay that way?
 *
 * The probe is a line of known length. A line of exactly N characters must
 * occupy exactly one rendered row when the terminal is wider than N. If it
 * spills onto a second row, it was wrapped at a width nobody is painting.
 */
import { canvasDoc, terminalTextNode } from "../harness/sandbox";
import { expect, test } from "../harness/launch";
import { waitForTerminalPaint } from "../harness/term-ready";

const LABEL = "e2e wrap divergence";
const BINDING_ID = "e2e-wrap-1";
const LAUNCH = { kind: "command" as const, argv: ["/bin/sh", "-i"] };

const rowTexts = async (page: import("@playwright/test").Page): Promise<ReadonlyArray<string>> =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll(".native-terminal-surface .xterm-rows > *")).map((el) =>
      (el.textContent ?? "").replace(/ /g, " ").trimEnd(),
    ),
  );

test.use({
  vellumOptions: {
    seedCanvases: {
      wrap: canvasDoc([
        terminalTextNode({ id: "t1", bindingId: BINDING_ID, label: LABEL, launch: LAUNCH }),
      ]),
    },
  },
});

test("output written across a reopen is not wrapped at a stale width", async ({ vellumCommand }) => {
  const { page } = vellumCommand;
  const logs: Array<Record<string, number | boolean>> = [];
  page.on("console", (msg) => {
    const t = msg.text();
    const at = t.indexOf("[vellum:term-geom] resize ");
    if (at < 0) return;
    try {
      logs.push(JSON.parse(t.slice(at + "[vellum:term-geom] resize ".length)));
    } catch {
      /* ignore */
    }
  });

  const node = page.locator(".react-flow__node", { hasText: LABEL });
  await expect(node).toBeVisible({ timeout: 30_000 });
  await node.dblclick();
  const surface = page.locator(".native-terminal-surface");
  await expect(surface).toBeVisible({ timeout: 30_000 });
  await waitForTerminalPaint(page);

  // A continuous emitter of fixed-width 100-char lines. It keeps writing while
  // the surface is closed and reopened, so some of its output lands inside the
  // divergence window.
  await surface.locator(".xterm-screen").click();
  await page.keyboard.type(
    "i=1; while [ $i -le 4000 ]; do printf 'W%04d' $i; j=6; while [ $j -lt 130 ]; do printf '='; j=$((j+1)); done; printf '\\n'; done",
  );
  await page.keyboard.press("Enter");
  await waitForTerminalPaint(page, 4);

  // Close, resize the window while the emitter keeps running (nothing tells the
  // PTY while no surface is attached), then reopen into the race.
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await surface.getByRole("button", { name: "Close" }).click();
    await expect(surface).toBeHidden({ timeout: 15_000 });
    const base = page.viewportSize() ?? { width: 1440, height: 900 };
    await page.setViewportSize({ width: base.width - 200, height: base.height - 120 });
    await node.dblclick();
    await expect(surface).toBeVisible({ timeout: 30_000 });
    await waitForTerminalPaint(page);
    await page.setViewportSize(base);
    await waitForTerminalPaint(page);
  }

  const diverged = logs.filter(
    (l) => l.ptyDiverged === true && Math.abs((l.cols as number) - (l.ptyCols as number)) > 2,
  );
  console.log(`DIVERGENCE SAMPLES: ${diverged.length}`);
  for (const d of diverged.slice(0, 6)) console.log("  " + JSON.stringify(d));

  // Consequence: a 130-char line must never be split when the grid is wider.
  const rows = await rowTexts(page);
  const cols = (logs[logs.length - 1]?.cols as number) ?? 0;
  const orphans = rows.filter((r) => /^=+$/.test(r.trim()) && r.trim().length > 0);
  console.log(`GRID cols=${cols}; orphan continuation rows=${orphans.length}`);
  await page.screenshot({ path: "/tmp/vellum-wrap-divergence.png" });

  expect(cols, "no geometry captured").toBeGreaterThan(100);
  expect(
    orphans.slice(0, 6),
    `130-char lines were split onto continuation rows although the grid is ${cols} wide — they were wrapped at a width the renderer is not painting`,
  ).toEqual([]);
});
