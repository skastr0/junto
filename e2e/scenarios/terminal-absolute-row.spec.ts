/**
 * A TUI positions output by ABSOLUTE row, using the size the PTY reports.
 *
 * This is the consequence of the PTY/render divergence that plain output can
 * never show: printf does not wrap, the terminal wraps it, so a byte stream is
 * immune. A TUI is not — it asks the PTY how tall it is (TIOCGWINSZ) and then
 * writes its status line at that row with ESC[<row>;1H.
 *
 * If the PTY says 32 rows while xterm paints 38, the status line lands six rows
 * above the bottom, on top of scrollback — which is the reported symptom of a
 * spinner counter appearing in the middle of an unrelated line.
 *
 * The probe emits STATUS at the row the PTY reports, and fills the rest with
 * numbered content. Correct behaviour: STATUS is on the last rendered row.
 */
import { canvasDoc, terminalTextNode } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const LABEL = "e2e absolute row";
const BINDING_ID = "e2e-absrow-1";
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
      absrow: canvasDoc([
        terminalTextNode({ id: "t1", bindingId: BINDING_ID, label: LABEL, launch: LAUNCH }),
      ]),
    },
  },
});

test("a TUI status line lands on the real last row, not a stale one", async ({ vellumCommand }) => {
  const { page } = vellumCommand;
  const node = page.locator(".react-flow__node", { hasText: LABEL });
  await expect(node).toBeVisible({ timeout: 30_000 });
  await node.dblclick();
  const surface = page.locator(".native-terminal-surface");
  await expect(surface).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(3_000);

  // Emit filler, then park a STATUS marker at the row the PTY claims is last —
  // re-reading the size each iteration, exactly as a TUI does on SIGWINCH.
  await surface.locator(".xterm-screen").click();
  await page.keyboard.type(
    "i=1; while [ $i -le 2000 ]; do printf 'F%04d ....\\n' $i; " +
      "R=$(stty size | cut -d\" \" -f1); printf '\\033[%d;1H\\033[2KSTATUS-ROW-%d\\033[u' \"$R\" \"$R\"; " +
      "i=$((i+1)); done",
  );
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2_000);

  // Reopen + resize: the window the divergence lives in.
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await surface.getByRole("button", { name: "Close" }).click();
    await expect(surface).toBeHidden({ timeout: 15_000 });
    const base = page.viewportSize() ?? { width: 1440, height: 900 };
    await page.setViewportSize({ width: base.width - 200, height: base.height - 160 });
    await page.waitForTimeout(700);
    await node.dblclick();
    await expect(surface).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(2_500);
    await page.setViewportSize(base);
    await page.waitForTimeout(2_500);
  }
  await page.waitForTimeout(3_000);

  const rows = await rowTexts(page);
  const statusAt = rows.map((t, i) => ({ t, i })).filter((r) => r.t.includes("STATUS-ROW-"));
  console.log(`RENDERED ROWS=${rows.length}`);
  for (const s of statusAt) console.log(`  STATUS at rendered row ${s.i}: ${JSON.stringify(s.t.slice(0, 60))}`);
  await page.screenshot({ path: "/tmp/vellum-absolute-row.png" });

  expect(statusAt.length, "status marker never rendered").toBeGreaterThan(0);
  // The status line must be on the LAST row, and there must be exactly one.
  const stray = statusAt.filter((s) => s.i < rows.length - 2);
  expect(
    stray.map((s) => `rendered row ${s.i} of ${rows.length}: ${s.t.slice(0, 60)}`),
    "a status line written at the PTY-reported last row landed in the middle of the screen — the PTY and the painted grid disagree on height",
  ).toEqual([]);
});
