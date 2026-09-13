/**
 * Real harness bytes → the real xterm surface, compared against the app's own
 * headless model of the same bytes.
 *
 * This closes the gap between the two halves of our PTY testing:
 *   - tests/pty-e2e replays real captures into SessionObserver (a HEADLESS
 *     xterm). It proves the app UNDERSTANDS the screen.
 *   - e2e/scenarios drives the real UI, but only ever with a plain shell.
 * Neither one renders real harness bytes into the real DOM, which is exactly
 * where the reported corruption lives.
 *
 * The assertion needs no screenshots and no eyeballing: the SAME bytes go into
 * the headless terminal (ground truth — it is the reference implementation of
 * "what this stream means") and into the on-screen terminal. If the visible
 * rows disagree with the headless rows, the renderer is wrong. If they agree,
 * the corruption is not in rendering and this test says so honestly.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { canvasDoc, terminalTextNode } from "../harness/sandbox";
import { expect, test } from "../harness/launch";
import { waitForTerminalPaint } from "../harness/term-ready";

const REPO = process.cwd();
const REPLAY_DIR = "/tmp/vellum-real-bytes";

/** Harness capture used as the byte source. Grok is the heaviest redrawer. */
const CASES = [
  { harness: "grok", scenario: "working-turn" },
  { harness: "claude", scenario: "working-turn" },
] as const;

/** Decode a corpus capture to a raw byte file the shell can `cat`. */
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

const LABEL = "e2e real bytes";
const BINDING_ID = "e2e-real-bytes-1";

const LAUNCH = { kind: "command" as const, argv: ["/bin/sh", "-i"] };

/** Rendered rows, trailing blanks trimmed — what the operator sees. */
const renderedRows = async (
  page: import("@playwright/test").Page,
): Promise<ReadonlyArray<string>> =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll(".native-terminal-surface .xterm-rows > *")).map((el) =>
      (el.textContent ?? "").replace(/ /g, " ").trimEnd(),
    ),
  );

const geomOf = async (
  page: import("@playwright/test").Page,
): Promise<{ cols: number; rows: number } | undefined> =>
  page.evaluate(() => {
    const status =
      document.querySelector(".native-terminal-surface .native-terminal-surface__status")
        ?.textContent ?? "";
    const m = status.match(/(\d+)\s*[×x]\s*(\d+)/);
    return m ? { cols: Number(m[1]), rows: Number(m[2]) } : undefined;
  });

test.use({
  vellumOptions: {
    seedCanvases: {
      realbytes: canvasDoc([
        terminalTextNode({ id: "t1", bindingId: BINDING_ID, label: LABEL, launch: LAUNCH }),
      ]),
    },
  },
});

for (const { harness, scenario } of CASES) {
  test(`real ${harness}/${scenario} bytes render the same on screen as headless`, async ({
    vellumCommand,
  }) => {
    const { page } = vellumCommand;
    const raw = materialize(harness, scenario);

    const node = page.locator(".react-flow__node", { hasText: LABEL });
    await expect(node).toBeVisible({ timeout: 30_000 });
    await node.dblclick();
    const surface = page.locator(".native-terminal-surface");
    await expect(surface).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await geomOf(page)) !== undefined, { timeout: 30_000 }).toBe(true);
    await waitForTerminalPaint(page);

    const geom = (await geomOf(page))!;

    // Push the real harness stream through the real PTY into the real xterm.
    await surface.locator(".xterm-screen").click();
    await page.keyboard.type(`cat ${raw}`);
    await page.keyboard.press("Enter");
    await waitForTerminalPaint(page, 12);

    const onScreen = await renderedRows(page);
    await page.screenshot({ path: `/tmp/vellum-real-bytes-${harness}-${scenario}.png` });

    // Ground truth: the app's own headless terminal, same bytes, same geometry.
    const { SessionObserver } = (await import(
      "../../src/main/vellum-command/term/observer/index"
    )) as {
      SessionObserver: new (o: {
        bindingId: string;
        epoch: string;
        cols: number;
        rows: number;
      }) => {
        feed(d: string, seq: bigint): void;
        snapshot(): Promise<{ readonly lines: readonly string[] }>;
        dispose(): void;
      };
    };
    const headless = new SessionObserver({
      bindingId: "ref",
      epoch: "ref",
      cols: geom.cols,
      rows: geom.rows,
    });
    headless.feed(readFileSync(raw, "utf8"), 1n);
    const reference = (await headless.snapshot()).lines.map((l) => l.replace(/ /g, " ").trimEnd());
    headless.dispose();

    // Compare the harness's own content lines. The shell prompt and the `cat`
    // command line exist only on screen, so anchor on the payload: every
    // non-blank reference row must appear on screen, in order.
    const screenBlob = onScreen.join("\n");
    const missing = reference
      .filter((line) => line.trim().length > 3)
      .filter((line) => !screenBlob.includes(line.trim()));

    expect(
      missing.slice(0, 12),
      `${harness}/${scenario}: ${missing.length} of ${reference.filter((l) => l.trim().length > 3).length} content rows from the headless model are NOT on screen at ${geom.cols}x${geom.rows}. The renderer and the app's own screen model disagree.`,
    ).toEqual([]);

    // ── The reported trigger: close and reopen with a REAL TUI screen live. ──
    // Reopening re-attaches and restores by replaying a serialized VT snapshot
    // into a reset terminal. A snapshot of a plain shell restores fine (proved
    // separately); a snapshot of a harness screen carries SGR background runs,
    // hard-wrapped rows and absolute cursor state. The operator reports needing
    // three reopen cycles before the screen renders correctly.
    const contentRows = reference.filter((line) => line.trim().length > 3);
    const afterReopen: string[] = [];
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      await surface.getByRole("button", { name: "Close" }).click();
      await expect(surface).toBeHidden({ timeout: 15_000 });
      await node.dblclick();
      await expect(surface).toBeVisible({ timeout: 30_000 });
      await waitForTerminalPaint(page);

      const restored = (await renderedRows(page)).join("\n");
      await page.screenshot({ path: `/tmp/vellum-reopen-${harness}-${cycle}.png` });
      const lost = contentRows.filter((line) => !restored.includes(line.trim()));
      if (lost.length > 0) {
        afterReopen.push(
          `reopen ${cycle}: ${lost.length}/${contentRows.length} rows lost or mangled; first: ${JSON.stringify(lost[0]?.slice(0, 100))}`,
        );
      }
    }
    expect(
      afterReopen,
      `${harness}/${scenario}: the restored screen does not match the session's real content:\n${afterReopen.join("\n")}`,
    ).toEqual([]);
  });
}
