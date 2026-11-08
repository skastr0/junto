import { readFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";

/**
 * The visible rows of the open terminal, top to bottom.
 *
 * Under the WebGL renderer xterm removes `.xterm-rows`, so the DOM carries no
 * text; the surface registers its viewport text for tests instead
 * (TerminalSurface.tsx, `__juntoTermScreenText`). The DOM rows are read only
 * when WebGL fell back and they exist. `bindingId` picks one terminal; without
 * it the first registered surface answers, which is the only one in a
 * one-terminal scenario.
 */
export const terminalRows = (
  page: Page,
  bindingId?: string,
): Promise<ReadonlyArray<string>> =>
  page.evaluate((id) => {
    const registry = (
      window as unknown as { __juntoTermScreenText?: Map<string, () => string> }
    ).__juntoTermScreenText;
    const read =
      id === null ? registry?.values().next().value : registry?.get(id);
    const rows =
      read !== undefined
        ? read().split("\n")
        : Array.from(
            document.querySelectorAll(".native-terminal-surface .xterm-rows > *"),
          ).map((el) => el.textContent ?? "");
    return rows.map((row) => row.replace(/\u00a0/g, " "));
  }, bindingId ?? null);

const rowBlob = async (page: Page): Promise<string> =>
  (await terminalRows(page)).join("\n");

/**
 * Wait until the screen shows at least `minRows` rows with text on them.
 *
 * Blank rows do not count: the screen text always spans the whole grid, so a
 * count of all rows is true before a single byte has arrived. The default of
 * one row is a surface that has shown anything at all, a shell prompt included.
 */
export const waitForTerminalPaint = async (
  page: Page,
  minRows = 1,
): Promise<void> => {
  await expect
    .poll(
      async () =>
        (await terminalRows(page)).filter((row) => row.trim().length > 0).length,
      { timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(minRows);
};

/**
 * Wait until the screen text has stopped changing: two reads in a row, 400 ms
 * apart, that agree. For output that ends (a replayed capture, a restored
 * screen), read after this; a stream that never ends never goes quiet.
 */
export const waitForTerminalQuiet = async (
  page: Page,
  timeout = 15_000,
): Promise<void> => {
  let previous: string | undefined;
  await expect
    .poll(
      async () => {
        const now = await rowBlob(page);
        const quiet = now === previous && now.trim().length > 0;
        previous = now;
        return quiet;
      },
      { timeout, intervals: [400] },
    )
    .toBe(true);
};

/** Wait until the visible screen contains `needle` (payload, marker, prompt). */
export const waitForTerminalText = async (
  page: Page,
  needle: string,
  timeout = 30_000,
): Promise<void> => {
  await expect
    .poll(async () => (await rowBlob(page)).includes(needle), { timeout })
    .toBe(true);
};

/**
 * Wait until an echo terminal (`modelEchoTerminal`) has read `needle` from its
 * PTY: the proof that typed keys arrived, independent of how the grid paints.
 */
export const waitForTerminalInput = async (
  transcript: string,
  needle: string,
  timeout = 15_000,
): Promise<void> => {
  await expect
    .poll(async () => (await readFile(transcript, "utf8").catch(() => "")).includes(needle), { timeout })
    .toBe(true);
};
