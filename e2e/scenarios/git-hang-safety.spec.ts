/**
 * The git node's commit browser opens big commits without holding the
 * renderer.
 *   bun run test:e2e:fast e2e/scenarios/git-hang-safety.spec.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanvasNode } from "../../src/shared/canvas";
import { canvasDoc } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "git-hang-safety");
const CANVAS = "git-hang-safety";

const gitIn = (repo: string, ...args: string[]): string =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  }).trim();

/** A repo whose HEAD is a big commit: 80 files of 400 lines of code-like text. */
const makeBigRepo = (): string => {
  const repo = mkdtempSync(join(tmpdir(), "junto-git-e2e-"));
  gitIn(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  gitIn(repo, "add", ".");
  gitIn(repo, "commit", "-q", "-m", "first");
  for (let file = 0; file < 80; file += 1) {
    const body = Array.from(
      { length: 400 },
      (_, line) => `export const value${String(line)} = compute(${String(file)}, "${"abc".repeat(8)}", [${String(line)}, ${String(line * 2)}]);`,
    ).join("\n");
    writeFileSync(join(repo, `module-${String(file).padStart(2, "0")}.ts`), `${body}\n`);
  }
  gitIn(repo, "add", ".");
  gitIn(repo, "commit", "-q", "-m", "a very large commit");
  return repo;
};

const gitNode = (cwd: string): CanvasNode => ({
  id: "git-e2e",
  type: "text",
  text: "fixture repo",
  x: 80,
  y: 80,
  width: 176,
  height: 44,
  ether: { entity: { kind: "git" }, git: { cwd } },
});

test("the commit browser opens a big commit cut to fit, without holding the renderer", async () => {
  await mkdir(SHOTS, { recursive: true });
  const repo = makeBigRepo();
  const junto = await launchJunto({ seedCanvases: { [CANVAS]: canvasDoc([gitNode(repo)]) } });
  try {
    const { page } = junto;
    const card = page.locator('.react-flow__node[data-id="git-e2e"]');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId("instrument-seat-line")).toContainText("main", { timeout: 15_000 });

    await page.evaluate(() => {
      const w = window as unknown as { __longTasks: number[] };
      w.__longTasks = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) w.__longTasks.push(Math.round(entry.duration));
      }).observe({ type: "longtask" });
    });
    await card.dblclick();
    const detail = page.getByTestId("git-detail");
    await expect(detail).toBeVisible({ timeout: 15_000 });
    const cut = page.getByTestId("git-diff-cut");
    await expect(cut).toBeVisible({ timeout: 20_000 });
    await expect(cut).toContainText("of 80 files");
    await expect(detail.locator(".git-browser__diff")).toContainText("module-00.ts", { timeout: 20_000 });
    await page.waitForTimeout(1_500);
    const longTasks = await page.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks);
    console.log(`[git-hang-safety] long tasks while opening: ${JSON.stringify(longTasks)}`);
    // The budget keeps the diff view's synchronous work well under a beachball.
    expect(Math.max(0, ...longTasks)).toBeLessThan(1_000);

    await page.mouse.move(4, 700);
    for (const theme of ["dark", "bright"] as const) {
      await page.evaluate((mode) => window.junto!.settingsPatch({ appearance: { theme: mode } }), theme);
      if (theme === "bright") await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
      else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(SHOTS, `commit-browser-cut-${theme}.png`) });
    }

    // The first commit is small and shows whole, with no cut note.
    await detail.locator(".git-browser__row").nth(1).click();
    await expect(detail.locator(".git-browser__diff")).toContainText("README.md", { timeout: 15_000 });
    await expect(cut).toHaveCount(0);
  } finally {
    await junto.close();
    rmSync(repo, { recursive: true, force: true });
  }
});
