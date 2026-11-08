/**
 * The terminal journey: open a terminal from the canvas, type a command, and
 * see what it printed.
 *
 * The command is `echo junto-$((6*7))`, so `junto-42` appears only if the
 * shell ran it: the typed line never contains that text. It crosses every
 * process a terminal does (window, main, core, terminal process, PTY, and
 * back). The screen is read as text through the harness, as a user reads it.
 *   bun run test:e2e:fast e2e/scenarios/terminal-journey.spec.ts
 */
import { modelFixture, modelTerminal } from "../harness/model";
import { expect, test } from "../harness/launch";
import { terminalRows, waitForTerminalText } from "../harness/term-ready";

const LABEL = "Build shell";

test.use({
  juntoOptions: {
    seedModels: {
      journey: modelFixture([
        modelTerminal({
          id: "t1",
          bindingId: "e2e-journey-1",
          label: LABEL,
          launch: { kind: "command" as const, argv: ["/bin/sh", "-i"] },
        }),
      ]),
    },
  },
});

test("a terminal opened from the canvas runs what you type and shows its output", async ({ junto }) => {
  const { page } = junto;

  const terminal = page.getByRole("group", { name: `${LABEL}, terminal` });
  await expect(terminal).toBeVisible({ timeout: 30_000 });
  await terminal.click();
  await page.getByRole("toolbar", { name: "terminal actions" }).getByRole("button", { name: "Open terminal" }).click();

  const view = page.getByRole("dialog", { name: "Workbench - terminal" });
  await expect(view).toBeVisible({ timeout: 30_000 });
  await expect(view.getByText(LABEL)).toBeVisible();

  await view.getByRole("textbox", { name: "Terminal input" }).focus();
  await page.keyboard.type("echo junto-$((6*7))");
  await page.keyboard.press("Enter");
  await waitForTerminalText(page, "junto-42", 15_000);
  expect((await terminalRows(page)).some((row) => row.trim() === "junto-42"), "the output on a line of its own").toBe(true);

  await view.getByRole("button", { name: "Close view" }).click();
  await expect(view).toBeHidden({ timeout: 15_000 });
});
