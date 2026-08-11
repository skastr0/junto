/**
 * Reads the term-geom diagnostics out of the real app and asserts the two
 * contracts the code currently violates.
 *
 * 1. xterm's `open(parent)` requires the parent to be visible with real
 *    dimensions — that call is when the character cell is measured. Opening
 *    against an unlaid-out box poisons the metrics for the life of the
 *    terminal.
 * 2. xterm sizes `.xterm-screen` to exactly cols*cellWidth. CSS in this app
 *    forces it to width:100% of a box that is "pane minus 16px", which is
 *    almost never a whole number of cells — so the painted screen and the
 *    character grid disagree, and SGR background runs paint to the painted
 *    width rather than the grid width.
 *
 * Both are read from the app's own instrumentation, so this needs no human to
 * reproduce anything.
 */
import { canvasDoc, terminalTextNode } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const LABEL = "e2e geom probe";
const BINDING_ID = "e2e-geom-probe-1";
const LAUNCH = {
  kind: "command" as const,
  argv: ["/bin/sh", "-c", "printf 'geom-probe\\r\\n'; exec sleep 3600"],
};

type GeomLog = { readonly event: string; readonly data: Record<string, number | boolean> };

test.use({
  vellumOptions: {
    seedCanvases: {
      geomprobe: canvasDoc([
        terminalTextNode({ id: "t1", bindingId: BINDING_ID, label: LABEL, launch: LAUNCH }),
      ]),
    },
  },
});

test("xterm measures against a laid-out box, and the painted screen matches the grid", async ({
  vellumCommand,
}) => {
  const { page } = vellumCommand;
  const logs: GeomLog[] = [];
  page.on("console", (msg) => {
    const text = msg.text();
    const at = text.indexOf("[vellum:term-geom]");
    if (at < 0) return;
    const rest = text.slice(at + "[vellum:term-geom]".length).trim();
    const space = rest.indexOf(" ");
    if (space < 0) return;
    try {
      logs.push({ event: rest.slice(0, space), data: JSON.parse(rest.slice(space + 1)) });
    } catch {
      // ignore malformed
    }
  });

  const node = page.locator(".react-flow__node", { hasText: LABEL });
  await expect(node).toBeVisible({ timeout: 30_000 });
  await node.dblclick();
  await expect(page.locator(".native-terminal-surface")).toBeVisible({ timeout: 30_000 });
  // Let the SETTLE_FITS_MS ladder finish so we judge the settled state, not a
  // transient mid-layout sample.
  await page.waitForTimeout(4_000);

  // Exercise the paths the operator actually uses: window resize, and a
  // close/reopen (a fresh open() against a pane that is being re-mounted).
  const size = page.viewportSize() ?? { width: 1440, height: 900 };
  await page.setViewportSize({ width: size.width - 220, height: size.height - 140 });
  await page.waitForTimeout(2_000);
  await page.setViewportSize(size);
  await page.waitForTimeout(2_000);
  await page.locator(".native-terminal-surface").getByRole("button", { name: "Close" }).click();
  await page.waitForTimeout(800);
  await node.dblclick();
  await expect(page.locator(".native-terminal-surface")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(4_000);

  const opens = logs.filter((l) => l.event === "open");
  const resizes = logs.filter((l) => l.event === "resize");
  console.log(`\n=== term-geom: ${opens.length} open, ${resizes.length} resize ===`);
  for (const o of opens) console.log("  open  ", JSON.stringify(o.data));
  for (const r of resizes.slice(-8)) console.log("  resize", JSON.stringify(r.data));

  expect(opens.length, "instrumentation produced no open events").toBeGreaterThan(0);

  // CONTRACT 1 — xterm must measure against a box that has dimensions.
  const blindOpens = opens.filter((o) => o.data.hostVisible !== true);
  expect(
    blindOpens.map((o) => JSON.stringify(o.data)),
    "term.open() ran against a host with NO dimensions — xterm's documented contract is violated and the cell metrics for that terminal are a guess",
  ).toEqual([]);

  // CONTRACT 1b — the cell must be xterm's own measurement, never the fallback.
  const guessed = opens.filter((o) => o.data.cellIsFallback === true);
  expect(
    guessed.map((o) => JSON.stringify(o.data)),
    "the character cell fell back to a hardcoded guess, so cols/rows are computed from a made-up cell size",
  ).toEqual([]);

  // CONTRACT 2 — the painted screen must match the character grid.
  const mismatched = resizes.filter(
    (r) => typeof r.data.screenGridDeltaPx === "number" && Math.abs(r.data.screenGridDeltaPx as number) > 1,
  );
  expect(
    mismatched.slice(0, 5).map((r) => JSON.stringify(r.data)),
    "the painted .xterm-screen width does not equal cols*cellW — rows and SGR background runs paint to a different width than the character grid",
  ).toEqual([]);
});
