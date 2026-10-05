/**
 * Git at a glance in the agent modal header.
 *   bun run test:e2e:fast e2e/scenarios/seat-git-line.spec.ts
 *
 * A real repository is made in a temp folder: main, and a branch two commits
 * ahead of it with known line counts (7 added, 1 removed), its last commit
 * dated three hours ago. The seat is launched in that folder.
 *
 * Asserts:
 *   - the header shows exactly: branch, 2 ahead, +7, -1, the latest commit's subject, its age
 *   - uncommitted tracked work adds the quiet mark on the next read
 *   - pressing the line opens the git detail above the agent modal; Escape closes only it
 *   - a seat whose folder is not a repository shows no git line at all
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const HOUR = 3_600_000;
const env = (at: Date) => ({
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_AUTHOR_DATE: at.toISOString(),
  GIT_COMMITTER_DATE: at.toISOString(),
});

/** main, then feat/git-line two commits ahead: +7 -1 against main. */
const makeRepository = (repo: string): void => {
  const git = (at: Date, ...args: string[]): void => void execFileSync("git", ["-C", repo, ...args], { env: env(at) });
  const commit = (at: Date, file: string, body: string, subject: string): void => {
    writeFileSync(join(repo, file), body);
    git(at, "add", file);
    git(at, "commit", "-q", "-m", subject);
  };
  const day = new Date(Date.now() - 24 * HOUR);
  git(day, "init", "-q", "-b", "main");
  commit(day, "file.txt", "a\nb\nc\n", "Start");
  git(day, "checkout", "-q", "-b", "feat/git-line");
  commit(new Date(Date.now() - 5 * HOUR), "file.txt", "a\nB\nc\nd\ne\nf\n", "Grow the file");
  commit(new Date(Date.now() - 3 * HOUR - 60_000), "notes.txt", "one\ntwo\nthree\n", "Add the notes");
};

// Waits for product-shell to mount SeatGitLine in the agent modal header.
test("the agent modal header shows the seat's repository on one line and opens its git detail", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "junto-e2e-git-line-")));
  const repo = join(base, "repo");
  const plain = join(base, "plain");
  execFileSync("mkdir", ["-p", repo, plain]);
  makeRepository(repo);
  const junto = await launchJunto({
    seedCanvases: {
      "git-line": canvasDoc([
        agentTextNode({ id: "in-repo", key: "local:e2e-git-in-repo", label: "Atlas", harness: "claude", cwd: repo, x: 0, y: 0 }),
        agentTextNode({ id: "no-repo", key: "local:e2e-git-no-repo", label: "Brook", harness: "claude", cwd: plain, x: 320, y: 0 }),
      ]),
    },
  });
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="in-repo"]')).toBeVisible({ timeout: 30_000 });

    // The seat in the repository: its header says the branch against main.
    await page.locator('.react-flow__node[data-id="in-repo"]').dblclick();
    await expect(page.locator(".native-terminal-surface")).toBeVisible({ timeout: 30_000 });
    const line = page.getByTestId("seat-git-line");
    await expect(line).toBeVisible({ timeout: 15_000 });
    const said = async (): Promise<string> => (await line.locator(".seat-git-line__part").allTextContents()).join(" ");
    expect(await said()).toBe("feat/git-line ↑2 +7 -1 Add the notes 3h");

    // Uncommitted tracked work shows as the quiet mark on the next read.
    writeFileSync(join(repo, "notes.txt"), "one\ntwo\nthree\nfour\n");
    await expect.poll(said, { timeout: 20_000 }).toBe("feat/git-line * ↑2 +7 -1 Add the notes 3h");

    // Pressing it opens the git detail above the agent modal; Escape closes only it.
    await line.click();
    const detail = page.getByTestId("git-detail");
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("repo, feat/git-line");
    await expect(detail).toContainText("Add the notes");
    // Two working surfaces, the detail on top: one dim each, as the layer model has it.
    await expect(page.locator("[data-layer-backdrop]")).toHaveCount(2);
    await expect(line).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(detail).toHaveCount(0);
    await expect(page.locator(".native-terminal-surface")).toBeVisible();
    // Escape belongs to the terminal: the agent modal closes by its own button.
    await page.getByRole("button", { name: "Close view" }).first().click();
    await expect(page.locator(".native-terminal-surface")).toHaveCount(0);

    // A seat whose folder is not a repository: no git line, no placeholder.
    await page.locator('.react-flow__node[data-id="no-repo"]').dblclick();
    await expect(page.locator(".native-terminal-surface")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(2_000);
    await expect(page.getByTestId("seat-git-line")).toHaveCount(0);
  } finally {
    await junto.close();
    rmSync(base, { recursive: true, force: true });
  }
});
