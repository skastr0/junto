/**
 * Terminal geometry truth — does the size the CHILD PROCESS sees match the
 * size xterm is rendering?
 *
 * Why this is the right question: every TUI harness (Claude Code, Grok, Codex…)
 * paints its status line with ABSOLUTE cursor addressing — "go to row N,
 * column 1, erase, write". N comes from the size the PTY reports to the child
 * (TIOCGWINSZ, what `stty size` prints). If the app tells the PTY one size and
 * renders xterm at another, every one of those absolute writes lands on the
 * wrong row: a spinner counter gets painted into the middle of a scrollback
 * line, background runs are drawn to the wrong width, and the screen only
 * "settles" if a later resize happens to reconcile the two.
 *
 * That is a defect provable with numbers, not screenshots — which is why this
 * test reads `stty size` from inside the real child and compares it to the
 * geometry the surface reports, at rest and across resizes.
 *
 * Every other PTY test in this repo feeds SessionObserver, the classifier's
 * model of the screen. None of them can see this.
 */
import { canvasDoc, terminalTextNode } from "../harness/sandbox";
import { expect, test } from "../harness/launch";
import { waitForTerminalPaint } from "../harness/term-ready";

const LABEL = "e2e geometry truth";
const BINDING_ID = "e2e-geom-binding-1";

/** Interactive shell: we drive `stty size` through the real PTY. */
const LAUNCH = {
  kind: "command" as const,
  argv: ["/bin/sh", "-i"],
};

type Geom = { readonly cols: number; readonly rows: number };

/** What the SURFACE says it is rendering (the status strip prints cols×rows). */
const renderedGeom = async (
  page: import("@playwright/test").Page,
): Promise<Geom | undefined> =>
  page.evaluate(() => {
    const status = document
      .querySelector(".native-terminal-surface .native-terminal-surface__status")
      ?.textContent?.trim() ?? "";
    const m = status.match(/(\d+)\s*[×x]\s*(\d+)/);
    return m ? { cols: Number(m[1]), rows: Number(m[2]) } : undefined;
  });

/** All rendered terminal text, whitespace-collapsed for matching. */
const screenText = async (page: import("@playwright/test").Page): Promise<string> =>
  page.evaluate(
    () =>
      Array.from(document.querySelectorAll(".native-terminal-surface .xterm-rows > *"))
        .map((el) => el.textContent ?? "")
        .join("\n"),
  );

/**
 * What the CHILD PROCESS sees. Runs `stty size` through a real control lease —
 * the same write path the operator's keystrokes take — and reads the answer off
 * the rendered screen. Output of `stty size` is "<rows> <cols>".
 */
const ptyGeom = async (
  page: import("@playwright/test").Page,
  marker: string,
): Promise<Geom | undefined> => {
  // Type it the way the operator does — real keystrokes through the focused
  // surface into the PTY. (A test-owned control lease competes with the lease
  // the surface itself holds and the write is dropped.)
  await page.locator(".native-terminal-surface .xterm-screen").click();
  await page.keyboard.type(`echo ${marker}-$(stty size | tr ' ' x)`);
  await page.keyboard.press("Enter");
  // The echoed command line also contains the marker, so match the ANSWER:
  // "<marker>-<rows>x<cols>" with digits, not the literal command text.
  const answer = new RegExp(`${marker}-(\\d+)x(\\d+)`);
  let found: RegExpMatchArray | null = null;
  await expect
    .poll(
      async () => {
        const text = (await screenText(page)).replace(/\s+/g, " ");
        // Skip the echoed command (contains "stty"), take a real numeric answer.
        for (const line of text.split(" ")) {
          const m = line.match(answer);
          if (m) found = m;
        }
        return found !== null;
      },
      { timeout: 20_000, intervals: [250, 250, 500] },
    )
    .toBe(true);
  if (!found) return undefined;
  return { rows: Number(found[1]), cols: Number(found[2]) };
};

test.use({
  vellumOptions: {
    seedCanvases: {
      geom: canvasDoc([
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

const MARKER = /M(\d{4})/g;

/**
 * Violations of "the screen shows what was written", as data. Two markers on
 * one rendered row is literally the reported "characters are all mixed up";
 * a repeated marker is a stale row surviving a repaint.
 */
const integrityViolations = (rows: ReadonlyArray<string>): ReadonlyArray<string> => {
  const problems: string[] = [];
  const seen = new Map<number, number>();
  let previous: number | undefined;
  rows.forEach((text, index) => {
    const markers = [...text.matchAll(MARKER)].map((m) => Number(m[1]));
    if (markers.length === 0) return;
    if (markers.length > 1) {
      problems.push(
        `row ${index}: ${markers.length} markers on ONE row (${markers.join(",")}) — ${JSON.stringify(text.slice(0, 120))}`,
      );
      return;
    }
    const marker = markers[0]!;
    const earlier = seen.get(marker);
    if (earlier !== undefined) problems.push(`row ${index}: M${marker} already rendered at row ${earlier}`);
    seen.set(marker, index);
    if (previous !== undefined && marker !== previous + 1) {
      problems.push(`row ${index}: expected M${previous + 1}, got M${marker} (out of order)`);
    }
    previous = marker;
  });
  return problems;
};

const rowTexts = async (page: import("@playwright/test").Page): Promise<ReadonlyArray<string>> =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll(".native-terminal-surface .xterm-rows > *")).map(
      (el) => el.textContent ?? "",
    ),
  );

/**
 * Close and reopen the surface — the path the operator reported having to
 * repeat three times before the screen rendered correctly. Reopening does NOT
 * respawn: it re-attaches, and the app restores the screen by replaying a
 * serialized VT snapshot into a reset terminal. Nothing else in the tree
 * exercises that.
 */
test("reopening a session with scrollback renders it intact", async ({ vellumCommand }) => {
  const { page } = vellumCommand;

  const node = page.locator(".react-flow__node", { hasText: LABEL });
  await expect(node).toBeVisible({ timeout: 30_000 });
  await node.dblclick();
  const surface = page.locator(".native-terminal-surface");
  await expect(surface).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await renderedGeom(page)) !== undefined, { timeout: 30_000 }).toBe(true);
  await waitForTerminalPaint(page);

  // Fill the session: numbered rows, every third one long enough to WRAP, so
  // the snapshot carries hard-wrapped lines (the shape that misrenders when a
  // replay lands at a different width).
  await surface.locator(".xterm-screen").click();
  await page.keyboard.type(
    `i=1; while [ $i -le 120 ]; do if [ $((i % 3)) -eq 0 ]; then printf 'M%04d ' $i; j=0; while [ $j -lt 150 ]; do printf 'x'; j=$((j+1)); done; printf '\\n'; else printf 'M%04d .\\n' $i; fi; i=$((i+1)); done`,
  );
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await rowTexts(page)).some((t) => t.includes("M0120")), { timeout: 60_000 })
    .toBe(true);

  const beforeClose = integrityViolations(await rowTexts(page));
  expect(beforeClose, `BEFORE CLOSE:\n${beforeClose.join("\n")}`).toEqual([]);

  // Three close/reopen cycles — the operator needed three before it settled.
  const found: string[] = [];
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    await surface.getByRole("button", { name: "Close" }).click();
    await expect(surface).toBeHidden({ timeout: 15_000 });

    await node.dblclick();
    await expect(surface).toBeVisible({ timeout: 30_000 });
    await waitForTerminalPaint(page);

    for (const problem of integrityViolations(await rowTexts(page))) {
      found.push(`reopen ${cycle}: ${problem}`);
    }
    await page.screenshot({ path: `/tmp/vellum-reopen-${cycle}.png` });
  }

  expect(
    found,
    `AFTER REOPEN — the restored screen does not match what was written:\n${found.join("\n")}`,
  ).toEqual([]);
});

test("the size the child process sees matches the size xterm renders", async ({
  vellumCommand,
}) => {
  const { page } = vellumCommand;

  const node = page.locator(".react-flow__node", { hasText: LABEL });
  await expect(node).toBeVisible({ timeout: 30_000 });
  await node.dblclick();

  const surface = page.locator(".native-terminal-surface");
  await expect(surface).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => (await renderedGeom(page)) !== undefined, { timeout: 30_000 })
    .toBe(true);
  await waitForTerminalPaint(page);

  const mismatches: string[] = [];

  const compare = async (where: string, marker: string): Promise<void> => {
    const rendered = await renderedGeom(page);
    const child = await ptyGeom(page, marker);
    if (!rendered || !child) {
      mismatches.push(`${where}: could not read geometry (rendered=${JSON.stringify(rendered)} child=${JSON.stringify(child)})`);
      return;
    }
    if (rendered.cols !== child.cols || rendered.rows !== child.rows) {
      mismatches.push(
        `${where}: xterm renders ${rendered.cols}x${rendered.rows} but the child process sees ${child.cols}x${child.rows} — every absolute cursor write from a TUI lands on the wrong row`,
      );
    }
  };

  await compare("at rest after attach", "G1");

  // Resize the window: the operator drags panes and toggles the dock constantly.
  const original = page.viewportSize() ?? { width: 1440, height: 900 };
  await page.setViewportSize({ width: original.width - 240, height: original.height - 160 });
  await waitForTerminalPaint(page);
  await compare("after shrinking the window", "G2");

  await page.setViewportSize(original);
  await waitForTerminalPaint(page);
  await compare("after restoring the window", "G3");

  expect(
    mismatches,
    `PTY/render geometry disagreement:\n${mismatches.join("\n")}`,
  ).toEqual([]);
});
