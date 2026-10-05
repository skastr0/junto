/**
 * The seat git line and the keyboard, in the agent modal's header.
 *   bun run test:e2e:fast e2e/scenarios/seat-git-line-keyboard.spec.ts
 *
 * A live seat runs in a real repository. The operator is typing in the
 * terminal, presses the git line, reads the detail and closes it with
 * Escape: the next keys must reach the agent again, as they do after the
 * seat details close. Opened by keyboard, Escape leaves focus on the line.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const makeRepository = (repo: string): void => {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  const git = (...args: string[]): void => void execFileSync("git", ["-C", repo, ...args], { env });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "file.txt"), "a\n");
  git("add", "file.txt");
  git("commit", "-q", "-m", "Start");
};

test("[fake-tui] closing the git detail gives the keyboard back to the terminal it was opened from", async () => {
  test.setTimeout(240_000);
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "junto-e2e-git-keys-")));
  makeRepository(repo);
  const CANVAS = "git-keys";
  const node = agentTextNode({ id: "atlas", key: "local:atlas", label: "atlas", harness: "codex", cwd: repo, x: 40, y: 40 });
  const junto = await launchJunto({ seedCanvases: { [CANVAS]: canvasDoc([node]) }, afterSeed: installCrewSeatHarness });
  try {
    const { page, sandbox } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await crewPlayFactory(page);
    const seat = crewSeat(sandbox, CANVAS, "atlas");
    await crewOccupySeat(page, CANVAS, node, seat);
    await page.locator('.react-flow__node[data-id="atlas"]').dblclick();
    const surface = page.locator(".workbench-pane:not(.workbench-pane--parked) .native-terminal-surface");
    const line = surface.getByTestId("seat-git-line");
    await expect(line).toBeVisible({ timeout: 20_000 });
    const detail = page.getByTestId("git-detail");
    const typingInTerminal = (): Promise<boolean> =>
      page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea") === true);

    // From the terminal, by mouse.
    await surface.locator(".xterm").first().click();
    await expect.poll(typingInTerminal).toBe(true);
    await page.keyboard.type("before ");
    await line.click();
    await expect(detail).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(detail).toHaveCount(0);
    await expect(surface).toBeVisible();
    await expect.poll(typingInTerminal, { message: "after Escape closed the git detail", timeout: 3_000 }).toBe(true);
    // The next keys reach the agent, and Space does not open the detail again.
    await page.keyboard.type("after the detail");
    await expect(detail).toHaveCount(0);
    await expect.poll(() => seat.stdinLog(), { timeout: 20_000 }).toContain("before after the detail");

    // By keyboard from the line itself: Escape leaves focus on the line, never on the page.
    await line.focus();
    await page.keyboard.press("Enter");
    await expect(detail).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(detail).toHaveCount(0);
    await expect(line).toBeFocused();
  } finally {
    await junto.close();
    rmSync(repo, { recursive: true, force: true });
  }
});
