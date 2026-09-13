import { expect, type Page } from "@playwright/test";

const rowCount = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      document.querySelectorAll(".native-terminal-surface .xterm-rows > *")
        .length,
  );

const rowBlob = (page: Page): Promise<string> =>
  page.evaluate(() =>
    Array.from(
      document.querySelectorAll(".native-terminal-surface .xterm-rows > *"),
    )
      .map((el) => (el.textContent ?? "").replace(/\u00a0/g, " "))
      .join("\n"),
  );

/** Wait until xterm has painted enough rows to be a real surface, not an empty attach. */
export const waitForTerminalPaint = async (
  page: Page,
  minRows = 8,
): Promise<void> => {
  await expect
    .poll(async () => rowCount(page), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(minRows);
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
