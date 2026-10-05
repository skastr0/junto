import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

/**
 * The agent modal's header is one line. Left to right: the portrait, where
 * the seat sits (its region path), its name, and its status only when the
 * session is not simply running; then the git line; then the buttons. When
 * the header is short the git line gives way first, then the region path;
 * the status and the name are the last to go.
 */

const CANVAS = "agent-header";
const LONG_BRANCH = "feat/a-very-long-branch-name-that-would-take-the-whole-header-if-it-could";

const makeRepository = (repo: string): void => {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
    GIT_AUTHOR_DATE: at,
    GIT_COMMITTER_DATE: at,
  };
  const git = (...args: string[]): void => void execFileSync("git", ["-C", repo, ...args], { env });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "file.txt"), "a\n");
  git("add", "file.txt");
  git("commit", "-q", "-m", "Start");
  git("checkout", "-q", "-b", LONG_BRANCH);
  writeFileSync(join(repo, "file.txt"), "a\nb\n");
  git("add", "file.txt");
  git("commit", "-q", "-m", "A long subject line that also wants a great deal of room in the header");
};

test("the header is one line and the git line gives way before the seat's own words", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "junto-e2e-header-")));
  makeRepository(base);
  const junto = await launchJunto({
    seedCanvases: {
      [CANVAS]: canvasDoc([
        { id: "outer", type: "group", label: "Junto", x: -60, y: -60, width: 900, height: 500 },
        { id: "inner", type: "group", label: "Product", x: -20, y: -20, width: 700, height: 360 },
        agentTextNode({ id: "lead", key: "local:e2e-header-lead", label: "product-lead", harness: "claude", cwd: base, x: 40, y: 40 }),
        agentTextNode({ id: "loose", key: "local:e2e-header-loose", label: "loose", harness: "claude", cwd: base, x: 1400, y: 40 }),
      ]),
    },
  });
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="lead"]')).toBeVisible({ timeout: 30_000 });
    await page.locator('.react-flow__node[data-id="lead"]').dblclick();
    const surface = page.locator(".workbench-pane:not(.workbench-pane--parked) .native-terminal-surface");
    const header = surface.locator("header").first();
    await expect(header.getByTestId("terminal-header-name")).toHaveText("product-lead", { timeout: 20_000 });

    // One line, about half the old 80px, and where the seat sits said the cmd+K way.
    await expect.poll(async () => Math.round((await header.boundingBox())!.height)).toBeLessThanOrEqual(42);
    await expect(header.getByTestId("terminal-header-crumb")).toHaveText("Junto / Product");
    await expect(header).not.toContainText(/terminal\s+[—-]\s+local/i);

    // The session here never starts (no harness in the sandbox), so the header
    // says so in place; and the git line is beside it.
    const status = header.locator(".native-terminal-surface__status");
    await expect(status).not.toHaveClass(/sr-only/);
    const line = header.getByTestId("seat-git-line");
    await expect(line).toBeVisible({ timeout: 15_000 });

    // At the default window the long branch may not cut the seat's own words:
    // the name and the status read whole, and the git line starts after them.
    const whole = (testId: string | null) =>
      header
        .locator(testId ? `[data-testid="${testId}"]` : ".native-terminal-surface__status")
        .evaluate((element) =>
          [element, ...element.querySelectorAll("*")].every((part) => part.scrollWidth <= part.clientWidth + 1),
        );
    const right = async (locator: ReturnType<typeof header.locator>) => {
      const box = (await locator.boundingBox())!;
      return box.x + box.width;
    };
    // While the session is still starting, the longest thing the status says.
    await expect(status).toContainText(/starting|not installed/);
    expect(await whole("terminal-header-name")).toBe(true);
    expect(await whole(null)).toBe(true);
    expect((await line.boundingBox())!.x).toBeGreaterThanOrEqual((await right(status)) - 1);
    // Nothing reaches the buttons.
    expect(await right(line)).toBeLessThanOrEqual((await header.getByRole("button", { name: "Pin", exact: true }).boundingBox())!.x);

    // A seat in no region shows no path at all.
    await header.getByRole("button", { name: "Close view", exact: true }).click();
    await page.getByRole("button", { name: "Fit all nodes" }).click();
    await page.locator('.react-flow__node[data-id="loose"]').dblclick();
    await expect(header.getByTestId("terminal-header-name")).toHaveText("loose", { timeout: 20_000 });
    await expect(header.getByTestId("terminal-header-crumb")).toHaveCount(0);
  } finally {
    await junto.close();
    rmSync(base, { recursive: true, force: true });
  }
});
