/**
 * The tour's last chapter: what Junto read from the operator's shell, live.
 *   bun run test:e2e:fast e2e/scenarios/onboarding-shell.spec.ts
 *
 * Asserts:
 *   - the chapter shows the shell Junto read (zsh here), how long it took,
 *     and the agents that PATH finds; Open the canvas is right there, so the
 *     step never holds the tour up
 *   - an rc edit, then Reload shell environment: the new PATH directory shows,
 *     and the change is counted, never listed with a value
 *   - a shell that exits before printing: the step says why, that seats use
 *     the PATH Junto was started with, and offers the
 *     JUNTO_RESOLVING_ENVIRONMENT escape
 *   - no variable value from the rc appears anywhere in the step
 */
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "onboarding-shell");
const SECRET = "sk-test-not-for-the-screen-0123456789";

const openShellChapter = async (page: Page) => {
  const intro = page.getByRole("dialog", { name: "Welcome to Junto" });
  await expect(intro).toBeVisible({ timeout: 30_000 });
  await intro.getByRole("button", { name: /: Your agents get your shell$/ }).click();
  const slide = intro.getByTestId("first-run-intro-slide");
  await expect(slide).toHaveAttribute("data-slide", "shell");
  return { intro, step: slide.getByTestId("shell-environment-step") };
};

const setTheme = async (page: Page, theme: "dark" | "bright"): Promise<void> => {
  await page.evaluate((mode) => window.junto!.settingsPatch({ appearance: { theme: mode } }), theme);
  if (theme === "bright") await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
  else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
  await page.waitForTimeout(250);
};

test("the shell chapter shows what Junto read, and Reload picks up an rc edit", async () => {
  await mkdir(SHOTS, { recursive: true });
  // Its own ZDOTDIR with an rc in it: zsh with no startup files at all would
  // offer its new-user setup and wait.
  const zdotdir = await mkdtemp(join(tmpdir(), "junto-zdotdir-"));
  const zshrc = join(zdotdir, ".zshrc");
  await writeFile(zshrc, "# empty\n");
  const junto = await launchJunto({ firstRunIntro: true, offline: true, extraEnv: { SHELL: "/bin/zsh", ZDOTDIR: zdotdir } });
  try {
    const { page, sandbox } = junto;
    await setTheme(page, "dark");
    const { intro, step } = await openShellChapter(page);
    await expect(step).toHaveAttribute("data-tone", "resolved", { timeout: 15_000 });
    await expect(step).toContainText("Junto read your zsh environment");
    await expect(step).toContainText(/read in \d/);
    await expect(step).toContainText("Agents found");
    await expect(intro.getByTestId("first-run-intro-done")).toBeVisible();
    await page.screenshot({ path: join(SHOTS, "shell-resolved-dark.png") });

    // The operator edits their rc: a new tool folder and a secret. Not a
    // JUNTO_ name: the probe keeps Junto's own names out of the read.
    const tools = join(sandbox.homeDir, "tools", "bin");
    await mkdir(tools, { recursive: true });
    await writeFile(zshrc, `export PATH="${tools}:$PATH"\nexport E2E_API_TOKEN="${SECRET}"\n`);
    await step.getByTestId("shell-environment-reload").click();
    await expect(step).toContainText(tools, { timeout: 15_000 });
    await expect(step).toContainText(/variables? changed/);
    await expect(step).not.toContainText(SECRET);
    expect(await page.content()).not.toContain(SECRET);
    await page.screenshot({ path: join(SHOTS, "shell-reloaded-dark.png") });

    await setTheme(page, "bright");
    await page.screenshot({ path: join(SHOTS, "shell-reloaded-bright.png") });
  } finally {
    await junto.close();
  }
});

test("a shell that exits explains itself and offers the escape", async () => {
  await mkdir(SHOTS, { recursive: true });
  const dir = await mkdtemp(join(tmpdir(), "junto-broken-shell-"));
  const broken = join(dir, "broken-shell");
  await writeFile(broken, "#!/bin/sh\necho 'rc: command not found: nvm' >&2\nexit 3\n");
  await chmod(broken, 0o755);
  const junto = await launchJunto({ firstRunIntro: true, offline: true, extraEnv: { SHELL: broken } });
  try {
    const { page } = junto;
    await setTheme(page, "dark");
    const { intro, step } = await openShellChapter(page);
    await expect(step).toHaveAttribute("data-tone", "failed", { timeout: 15_000 });
    await expect(step).toContainText("exited with code 3 before it printed its environment");
    await expect(step).toContainText("Seats start with the PATH Junto itself was started with.");
    await expect(step).toContainText("JUNTO_RESOLVING_ENVIRONMENT=1");
    // Never a gate: the tour still finishes from here.
    await expect(intro.getByTestId("first-run-intro-done")).toBeEnabled();
    await page.screenshot({ path: join(SHOTS, "shell-failed-dark.png") });
  } finally {
    await junto.close();
  }
});
