/**
 * Review a session's changes and send comments to agents as mail [fake-tui].
 *   bun run test:e2e:fast e2e/scenarios/seat-git-review.spec.ts
 *
 * Two live seats, Atlas and Brook, share one region and one git repository
 * with an uncommitted edit. The operator opens Atlas's review from its git
 * line, comments on one line, comments on another with an @mention of Brook,
 * adds an overall note, closes and reopens the review, and sends.
 *
 * Asserts:
 *   - the plus in the gutter opens a composer under the line, with the keyboard in it
 *   - @ offers the region's agents; Enter picks; the comment then goes to that agent
 *   - the pending review survives closing and reopening the surface
 *   - one send delivers exactly ONE mail to each seat, each with only its own
 *     comment, the file, the line, the quoted diff line, and what was reviewed;
 *     the overall note goes to the review's own recipient
 *   - the footer then says who it was sent to, and the comments are gone
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Page } from "@playwright/test";
import type { GroupNode } from "../../src/shared/canvas";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

/** main, a branch one commit ahead, and an uncommitted edit that adds two lines. Returns HEAD's short sha. */
const makeRepository = (repo: string): string => {
  const git = (...args: string[]): string => execFileSync("git", ["-C", repo, ...args], { env, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "parser.ts"), "export const parse = (text: string) => {\n  const parts = text.split(',');\n  return parts;\n};\n");
  git("add", "parser.ts");
  git("commit", "-q", "-m", "Start");
  git("checkout", "-q", "-b", "feat/review");
  writeFileSync(
    join(repo, "parser.ts"),
    "export const parse = (text: string) => {\n  const parts = text.split(',').map((part) => part.trim());\n  return parts.filter(Boolean);\n};\n",
  );
  git("commit", "-q", "-am", "Trim the parts");
  writeFileSync(
    join(repo, "parser.ts"),
    "export const parse = (text: string) => {\n  const parts = text.split(',').map((part) => part.trim());\n  const kept = parts.filter(Boolean);\n  return kept;\n};\n",
  );
  return git("rev-parse", "--short", "HEAD");
};

/** Move to the plus the way a hand does, then press it. */
const pressPlusOn = async (page: Page, detail: ReturnType<Page["getByTestId"]>, addedLine: number): Promise<void> => {
  await detail.locator('code[data-additions] div[data-line][data-line-type="change-addition"]').nth(addedLine).hover();
  const plus = detail.getByRole("button", { name: "Add comment", exact: true }).first();
  await expect(plus).toBeVisible();
  const box = (await plus.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};

const reviewsIn = (stdin: string): number => (stdin.match(/Code review from the operator\./g) ?? []).length;

test("[fake-tui] a review's comments reach each agent as exactly one mail", async () => {
  test.setTimeout(240_000);
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "junto-e2e-review-")));
  const head = makeRepository(repo);
  const CANVAS = "review";
  const team: GroupNode = { id: "team", type: "group", label: "Team", x: 0, y: 0, width: 900, height: 400 };
  const atlas = agentTextNode({ id: "atlas", key: "local:atlas", label: "Atlas", harness: "codex", cwd: repo, x: 60, y: 80 });
  const brook = agentTextNode({ id: "brook", key: "local:brook", label: "Brook", harness: "codex", cwd: repo, x: 420, y: 80 });
  const junto = await launchJunto({ seedCanvases: { [CANVAS]: canvasDoc([team, atlas, brook]) }, afterSeed: installCrewSeatHarness });
  try {
    const { page, sandbox } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);
    const seatA = crewSeat(sandbox, CANVAS, "atlas");
    const seatB = crewSeat(sandbox, CANVAS, "brook");
    await crewOccupySeat(page, CANVAS, atlas, seatA);
    await crewOccupySeat(page, CANVAS, brook, seatB);

    // Atlas's review, from its git line.
    await page.locator('.react-flow__node[data-id="atlas"]').dblclick();
    const surface = page.locator(".workbench-pane:not(.workbench-pane--parked) .native-terminal-surface");
    const line = surface.getByTestId("seat-git-line");
    await expect(line).toBeVisible({ timeout: 20_000 });
    await line.click();
    const detail = page.getByTestId("git-detail");
    await expect(detail.getByTestId("git-review-showing")).toHaveText("Uncommitted changes in this folder");
    const footer = detail.getByTestId("git-review-footer");
    const status = footer.locator(".git-review__status");
    const send = detail.getByTestId("git-review-send");
    await expect(status).toHaveText("No comments yet");
    await expect(send).toHaveText("Send to Atlas");
    await expect(send).toBeDisabled();

    // A comment on the first added line: the composer opens under it with the keyboard in it.
    await pressPlusOn(page, detail, 0);
    const composer = detail.getByTestId("git-review-composer");
    await expect(composer.locator(".git-review__anchor")).toHaveText("parser.ts 3");
    await expect(composer.locator("textarea")).toBeFocused();
    await page.keyboard.type("Why keep a second name here?");
    await composer.getByRole("button", { name: "Add comment" }).click();
    await expect(detail.getByTestId("git-review-comment")).toHaveCount(1);
    await expect(status).toHaveText("1 comment in 1 file");
    await expect(send).toBeEnabled();

    // A comment on the next line that mentions Brook: @ offers the region's agents, Enter picks.
    await pressPlusOn(page, detail, 1);
    await page.keyboard.type("Brook should check this @Bro");
    await expect(detail.locator(".git-review__mention")).toHaveCount(1);
    await expect(detail.locator(".git-review__mention")).toContainText("Brook");
    await page.keyboard.press("Enter");
    await expect(composer.locator("textarea")).toHaveValue("Brook should check this @Brook ");
    await expect(composer.locator(".git-review__actions .git-review__to")).toHaveText("Goes to Brook");
    await composer.getByRole("button", { name: "Add comment" }).click();
    await expect(detail.getByTestId("git-review-comment")).toHaveCount(2);
    await detail.getByLabel("Overall note for the review").fill("Good direction, two small things.");
    await expect(status).toHaveText("2 comments in 1 file, and an overall note");

    // The pending review survives closing and reopening the surface.
    await detail.getByRole("button", { name: "Close git" }).click();
    await expect(detail).toHaveCount(0);
    await line.click();
    await expect(detail.getByTestId("git-review-comment")).toHaveCount(2);
    await expect(detail.getByLabel("Overall note for the review")).toHaveValue("Good direction, two small things.");

    // One send: exactly one mail to each seat.
    await send.click();
    await expect(status).toHaveText(/^Sent as one mail to Atlas, Brook at /, { timeout: 20_000 });
    await expect(detail.getByTestId("git-review-comment")).toHaveCount(0);

    const reviewed = `Reviewed: uncommitted changes in the folder, on feat/review at ${head}, repository ${basename(repo)}.`;
    const toAtlas = [
      "Code review from the operator.",
      reviewed,
      "",
      "Overall: Good direction, two small things.",
      "",
      "1. parser.ts, line 3",
      "   +  const kept = parts.filter(Boolean);",
      "   Comment: Why keep a second name here?",
      "",
      "1 comment in this review. The line numbers are from the state named above; check them against your working copy.",
    ].join("\n");
    const toBrook = [
      "Code review from the operator.",
      reviewed,
      "",
      "1. parser.ts, line 4",
      "   +  return kept;",
      "   Comment: Brook should check this @Brook",
      "",
      "1 comment in this review. The line numbers are from the state named above; check them against your working copy.",
    ].join("\n");
    await expect.poll(async () => (await seatA.stdinLog()).includes(toAtlas), { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await seatB.stdinLog()).includes(toBrook), { timeout: 20_000 }).toBe(true);
    const a = await seatA.stdinLog();
    const b = await seatB.stdinLog();
    expect(reviewsIn(a)).toBe(1);
    expect(reviewsIn(b)).toBe(1);
    // Neither seat got the other's comment, and the note went only to the review's own recipient.
    expect(a).not.toContain("Brook should check this");
    expect(b).not.toContain("Why keep a second name here?");
    expect(b).not.toContain("Overall:");
    expect(a).toContain("mail from operator");
  } finally {
    await junto.close();
    rmSync(repo, { recursive: true, force: true });
  }
});
