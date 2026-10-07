/**
 * Code, diffs and a commit on a needs-you signal.
 *   bun run test:e2e:fast e2e/scenarios/feed-code.spec.ts
 *
 * A fake seat whose folder is a real repository raises a signal through its
 * own CLI with a code block and a diff typed inline, two files to compare,
 * and a commit. The claims, on the built app:
 *   - the signal carries them in the fixed order: code, diff, compare, commit
 *   - the card's details draw each one in place, highlighted, under its
 *     caption and name; nothing is a bare tile
 *   - the commit is read from the seat's own folder: its subject and its diff
 *   - any of them opens large in the viewer
 *   - Review this commit opens the full review in place of the feed, and
 *     closing it comes back to the same card with its details still open
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSignal } from "../../src/shared/agent-signals";
import { expect, launchJunto, test } from "../harness/launch";
import { crewDoc, crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { agentTextNode } from "../harness/sandbox";

const SHOTS = join(process.cwd(), "test-results", "feed-code");
const CANVAS = "feed-code";
const SEAT = "seat-ada";

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Ada",
  GIT_AUTHOR_EMAIL: "ada@example.invalid",
  GIT_COMMITTER_NAME: "Ada",
  GIT_COMMITTER_EMAIL: "ada@example.invalid",
};

const BEFORE = "export const retry = async (run: () => Promise<void>) => {\n  for (let attempt = 0; attempt < 3; attempt += 1) {\n    await run();\n  }\n};\n";
const AFTER = "export const MAX_RETRIES = 5;\n\nexport const retry = async (run: () => Promise<void>) => {\n  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {\n    await run();\n  }\n};\n";

/** One file, two commits. Returns HEAD's full id. */
const makeRepository = (repo: string): string => {
  const git = (...args: string[]): string => execFileSync("git", ["-C", repo, ...args], { env, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "retry.ts"), BEFORE);
  git("add", "retry.ts");
  git("commit", "-q", "-m", "Start");
  writeFileSync(join(repo, "retry.ts"), AFTER);
  git("commit", "-q", "-am", "Name the retry limit and raise it to five");
  return git("rev-parse", "HEAD");
};

test("[fake-tui] a seat attaches code, a diff, a compare and a commit, and the card draws them", async () => {
  test.setTimeout(240_000);
  await mkdir(SHOTS, { recursive: true });
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "junto-feed-code-")));
  const head = makeRepository(repo);
  writeFileSync(join(repo, "before.ts"), BEFORE);
  writeFileSync(join(repo, "after.ts"), AFTER);
  const seatNode = agentTextNode({ id: SEAT, key: `local:${SEAT}`, label: "Ada", harness: "codex", cwd: repo, x: 120, y: 220 });

  const junto = await launchJunto({
    seedCanvases: { [CANVAS]: crewDoc([seatNode]) },
    afterSeed: installCrewSeatHarness,
  });
  try {
    const { page, sandbox } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await crewPlayFactory(page);
    const ada = crewSeat(sandbox, CANVAS, SEAT);
    await crewOccupySeat(page, CANVAS, seatNode, ada);

    const signalsNow = (): Promise<ReadonlyArray<AgentSignal>> =>
      page.evaluate((canvas) => window.junto!.agentSignalsList(canvas), CANVAS);

    // Code with an equals sign and a colon in it: it must not be read as a caption.
    const refused = await ada.cli(["feedback", "x", "--diff", "just some words"]);
    expect(refused.ok).toBe(false);
    expect(`${refused.stdout}${refused.stderr}`).toContain("--diff");
    expect(await signalsNow()).toEqual([]);

    const raised = await ada.cli([
      "feedback",
      "The retry limit has a name now, and it is five.",
      "--code",
      "The guard=ts:if (attempt >= MAX_RETRIES) throw new Error(`gave up: ${attempt}`);",
      "--diff",
      "As a diff=--- a/retry.ts\n+++ b/retry.ts\n@@ -1,3 +1,5 @@\n+export const MAX_RETRIES = 5;\n+\n export const retry = async (run: () => Promise<void>) => {\n-  for (let attempt = 0; attempt < 3; attempt += 1) {\n+  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {\n     await run();\n",
      "--compare",
      `Before and after=${join(repo, "before.ts")},${join(repo, "after.ts")}`,
      "--commit",
      `The commit=${head}`,
    ]);
    expect(raised.ok, `${raised.stdout}${raised.stderr}`).toBe(true);
    await expect.poll(async () => (await signalsNow()).length, { timeout: 15_000 }).toBe(1);
    const signal = (await signalsNow())[0]!;
    expect(
      signal.attachments?.map((attachment) =>
        "kind" in attachment ? [attachment.kind, attachment.caption] : ["file", attachment.caption, attachment.ref.displayName, attachment.ref.mediaType],
      ),
    ).toEqual([
      ["file", "The guard", "snippet.ts", "text/plain"],
      ["file", "As a diff", "changes.diff", "text/x-diff"],
      ["compare", "Before and after"],
      ["commit", "The commit"],
    ]);
    expect(JSON.stringify(signal)).not.toContain(repo);

    await page.keyboard.press("Meta+I");
    const feed = page.getByTestId("operator-feed");
    await expect(feed).toBeVisible({ timeout: 10_000 });
    const card = feed.locator(`[data-item-id='signal:${signal.signalId}']`);
    await card.getByRole("button", { name: /Details/ }).click();
    const blocks = card.getByTestId("preview-block");
    await expect(blocks).toHaveCount(4, { timeout: 20_000 });
    await expect(card.getByTestId("preview-thumbnail")).toHaveCount(0);
    expect(await blocks.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")))).toEqual([
      "The guard",
      "As a diff",
      "Before and after",
      "The commit",
    ]);
    // Drawn by the shared component, not as plain text.
    await expect(blocks.nth(0).locator(".code-view[data-kind='code']")).toBeVisible({ timeout: 20_000 });
    await expect(blocks.nth(0)).toContainText("MAX_RETRIES");
    await expect(blocks.nth(1).locator(".code-view[data-kind='diff']")).toBeVisible();
    await expect(blocks.nth(2).locator(".code-view[data-kind='diff']")).toBeVisible();
    // The commit, read from the seat's own folder.
    await expect(blocks.nth(3)).toContainText("Name the retry limit and raise it to five", { timeout: 20_000 });
    await expect(blocks.nth(3)).toContainText(head.slice(0, 7));
    await page.screenshot({ path: join(SHOTS, "card-code-dark.png") });
    await blocks.nth(3).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, "card-commit-dark.png") });
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "bright" } }));
    await expect(blocks.nth(3)).toContainText("Name the retry limit and raise it to five");
    await page.screenshot({ path: join(SHOTS, "card-commit-bright.png") });
    await blocks.nth(0).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, "card-code-bright.png") });
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));

    // Any of them opens large.
    await blocks.nth(2).getByRole("button", { name: /Before and after/ }).click();
    const viewer = page.getByTestId("preview-viewer");
    await expect(viewer.getByTestId("preview-viewer-title")).toHaveText("after.ts");
    await expect(viewer.locator(".code-view[data-kind='diff']")).toBeVisible({ timeout: 20_000 });
    await expect(viewer.getByTestId("preview-viewer-status")).toContainText("3 of 4");
    await page.screenshot({ path: join(SHOTS, "viewer-compare-dark.png") });
    await page.keyboard.press("ArrowRight");
    await expect(viewer.getByTestId("preview-text")).toContainText("Name the retry limit and raise it to five", { timeout: 20_000 });
    await page.screenshot({ path: join(SHOTS, "viewer-commit-dark.png") });

    // Review this commit: the full review opens in place of the feed, and closing it
    // comes back to the same card with its details still open.
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
    await blocks.nth(3).getByRole("button", { name: "Review this commit" }).click();
    await expect(feed).toHaveCount(0);
    await expect(page.getByTestId("git-detail")).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: join(SHOTS, "review-from-card-dark.png") });
    await page.keyboard.press("Escape");
    await expect(feed).toBeVisible({ timeout: 10_000 });
    await expect(card.getByTestId("preview-block")).toHaveCount(4, { timeout: 20_000 });
    await expect(card).toHaveAttribute("aria-current", "true");
  } finally {
    await junto.close();
    await rm(repo, { recursive: true, force: true });
  }
});
