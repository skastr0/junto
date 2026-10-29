/**
 * Real app, plan 0.11 07 (N1 to N4), the operator's work in the needs-you
 * feed, one machine, dark and bright.
 *
 * Seat: `junto blocked "Write the post." --ask-artifact Shelf --min-words 5`
 * raises a card with the editor and a words meter; four words do not hand in,
 * five do, once, and make the document in Shelf titled from the signal; the
 * card closes and the seat gets mail. `--ask-proof` keeps its text and links.
 * Automation (N2): Run now raises work "Write 500 words, {{fired.at}}" from
 * the Automations node, urgent and due an hour after the firing; 499 words
 * do not hand in, 500 make the artifact in Shelf; the feed empties. A notice
 * has no form, shows one artifact that opens from the card, and Clear empties
 * it. Each check is reported on its own.
 *   bun run test:e2e:fast e2e/scenarios/operator-work-verify.spec.ts
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { asNodeId } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelNode, modelRegion, modelSeat } from "../harness/model";

const CANVAS = "operator-work-verify";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/operator-work-verify";

const shoot = async (page: Page, name: string): Promise<void> => {
  for (const theme of ["dark", "bright"] as const) {
    mkdirSync(join(SHOTS, theme), { recursive: true });
    await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, theme, `${name}.png`) });
  }
  await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
};

const choose = async (page: Page, scope: Locator, label: string | RegExp, option: string | RegExp): Promise<void> => {
  await scope.getByRole("button", { name: label, exact: typeof label === "string" ? true : undefined }).click();
  await page.getByRole("option", { name: option, exact: typeof option === "string" ? true : undefined }).first().click();
};

const words = (n: number): string => Array.from({ length: n }, (_, i) => `word${String(i)}`).join(" ");

type Result = { row: string; pass: boolean; detail?: string };
type Head = { artifact: { title: string; labels: ReadonlyArray<string> }; body: { markdown?: string } | null };

test("operator work: a seat's and an automation's work hand in from the feed, a notice opens and clears", async () => {
  test.setTimeout(420_000);
  const scout = modelSeat({ id: "scout", key: "local:work-scout", label: "Scout", harness: "codex", cwd: mkdtempSync(join(tmpdir(), "junto-work-scout-")), x: 40, y: 60 });
  const junto = await launchJunto({
    windowContentSize: { width: 1500, height: 900 },
    seedModels: {
      [CANVAS]: modelFixture([
        modelRegion({ id: "ops", label: "Ops", x: 0, y: 0, width: 1000, height: 420 }),
        scout,
        modelNode({ kind: "artifacts", id: "shelf", label: "Shelf", x: 320, y: 60, width: 260, height: 140, z: 0 }),
        modelNode({ kind: "automations", id: "auto", label: "Automations", x: 640, y: 60, width: 260, height: 120, z: 0 }),
      ]),
    },
    afterSeed: installCrewSeatHarness,
  });
  const results: Result[] = [];
  const check = async (row: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
      results.push({ row, pass: true });
    } catch (error) {
      results.push({ row, pass: false, detail: String(error).replace(/\u001b\[[0-9;]*m/gu, "").split("\n").slice(0, 5).join(" ") });
    }
  };
  try {
    const { page, sandbox } = junto;
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await expect(page.locator('.react-flow__node[data-id="shelf"]')).toBeVisible({ timeout: 30_000 });
    const seat = crewSeat(sandbox, CANVAS, "scout");
    await crewPlayFactory(page);
    await crewOccupySeat(page, CANVAS, scout, seat);
    expect((await seat.op("onboard", {})).ok, "scout onboards").toBe(true);
    const shelf = asNodeId("shelf");
    const heads = () => page.evaluate(({ canvas, node }) => window.junto!.resource!.artifact!.list(canvas, node), { canvas: CANVAS, node: shelf }) as Promise<ReadonlyArray<Head>>;
    const brief = mintItemId();
    await page.evaluate(
      ({ canvas, node, id, opId }) => window.junto!.resource!.artifact!.apply(canvas, node, id, opId, { op: "create", title: "Brief", body: { type: "document", markdown: "# Brief\n\nRead me." } }),
      { canvas: CANVAS, node: shelf, id: brief, opId: mintOpId() },
    );

    const trigger = page.getByTestId("operator-feed-trigger");
    const cards = page.getByTestId("operator-feed-card");
    const card = (text: string | RegExp) => cards.filter({ hasText: text });
    const openFeed = async (): Promise<void> => {
      if ((await page.getByTestId("operator-feed").count()) === 0) await trigger.click();
      await expect(page.getByTestId("operator-feed").first()).toBeVisible({ timeout: 10_000 });
    };
    const closeFeed = async (): Promise<void> => {
      for (let i = 0; i < 3 && (await page.getByTestId("operator-feed").count()) > 0; i += 1) {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(200);
      }
    };
    const detail = page.getByTestId("operator-feed-detail");
    const writing = detail.locator('[aria-label="Your writing"]').first();
    const handIn = detail.getByRole("button", { name: "Hand in", exact: true });
    const write = async (text: string): Promise<void> => {
      await writing.click();
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.press("Backspace");
      await page.keyboard.insertText(text);
    };

    // Seat: blocked, a document of at least five words.
    const raised = await seat.cli(["blocked", "Write the post.", "--ask-artifact", "Shelf", "--min-words", "5"]);
    expect(raised.stdout + raised.stderr).toContain('"ok":true');
    await openFeed();
    await check("seat work: the card has the editor and a words meter", async () => {
      await card("Write the post.").first().click();
      await expect(detail.getByTestId("signal-work-form")).toBeVisible({ timeout: 10_000 });
      await expect(writing).toBeVisible();
      await expect(detail.getByRole("progressbar", { name: "Words written" })).toBeVisible();
    });
    await write(words(4));
    await check("seat work: four words do not hand in", async () => {
      await expect(handIn).toHaveAttribute("aria-disabled", "true");
      await handIn.click({ force: true });
      await page.waitForTimeout(800);
      expect((await heads()).some((h) => h.artifact.title === "Write the post.")).toBe(false);
    });
    await shoot(page, "1-seat-work-four-words");
    await write(words(5));
    await check("seat work: five words hand in once and make the document in Shelf, titled from the signal", async () => {
      await expect(handIn).not.toHaveAttribute("aria-disabled", "true");
      await handIn.click();
      await expect.poll(async () => (await heads()).filter((h) => h.artifact.title === "Write the post.").length, { timeout: 15_000 }).toBe(1);
      await page.waitForTimeout(1_000);
      expect((await heads()).filter((h) => h.artifact.title === "Write the post.").length).toBe(1);
      expect((await heads()).find((h) => h.artifact.title === "Write the post.")?.body?.markdown).toContain("word4");
    });
    await check("seat work: the card closes", () => expect(card("Write the post.")).toHaveCount(0, { timeout: 10_000 }));
    await check("seat work: the seat gets mail", () =>
      expect.poll(async () => (await seat.stdinLog()).includes("Write the post"), { timeout: 30_000 }).toBe(true),
    );
    console.log("N-SEATMAIL", JSON.stringify((await seat.stdinLog()).slice(-600)));

    // Seat: proof keeps its text and links.
    const proofRaised = await seat.cli(["escalate", "Ship the build.", "--ask-proof"]);
    expect(proofRaised.stdout + proofRaised.stderr).toContain('"ok":true');
    await check("seat proof: the card has the proof form", async () => {
      await card("Ship the build.").first().click({ timeout: 15_000 });
      await expect(detail.locator('[data-form="proof"]')).toBeVisible({ timeout: 10_000 });
    });
    await check("seat proof: Hand in waits for a sentence", () => expect(handIn).toHaveAttribute("aria-disabled", "true"));
    await detail.getByLabel("What you did").fill("Built and signed 0.11.0.");
    await detail.getByLabel("Links, one per line").fill("not a link");
    await check("seat proof: a bad link line is called out", async () => {
      await expect(detail.getByRole("alert").first()).toBeVisible({ timeout: 5_000 });
      await expect(detail.getByLabel("Links, one per line")).toHaveAttribute("aria-invalid", "true");
      console.log("N-BADLINK", await detail.getByRole("alert").first().innerText());
    });
    await shoot(page, "2a-proof-bad-link");
    await detail.getByLabel("Links, one per line").fill("https://example.com/build/42");
    await shoot(page, "2-seat-proof");
    await check("seat proof: hand in keeps the text and links, the seat reads them", async () => {
      await handIn.click();
      await expect(card("Ship the build.")).toHaveCount(0, { timeout: 10_000 });
      await expect.poll(async () => {
        const log = await seat.stdinLog();
        return log.includes("Built and signed 0.11.0.") && log.includes("https://example.com/build/42");
      }, { timeout: 30_000 }).toBe(true);
    });
    console.log("N-PROOFMAIL", JSON.stringify((await seat.stdinLog()).slice(-900)));
    await closeFeed();

    // Automation (N2): work, 500 words, due in one hour, urgent.
    await page.locator('.react-flow__node[data-id="auto"]').dblclick();
    const pane = page.getByTestId("automations-node");
    await expect(pane).toBeVisible({ timeout: 20_000 });
    const editor = pane.getByTestId("automation-editor");
    const action1 = editor.getByRole("group", { name: "Action 1" });
    const on = editor.getByRole("switch", { name: "Automation on" });
    const build = async (name: string): Promise<void> => {
      await pane.getByRole("button", { name: "New automation" }).first().click();
      await editor.getByLabel("Automation name").fill(name);
      if ((await on.getAttribute("aria-checked")) !== "true") await on.click();
      await choose(page, action1, "Action 1", "Raise a signal");
    };
    await build("Daily words");
    await choose(page, action1, "What the signal asks", "Work, for you to do");
    await action1.getByRole("textbox", { name: "Signal title", exact: true }).fill("Write 500 words, {{fired.at}}");
    await choose(page, action1, "How you answer", "By writing a document");
    await choose(page, action1, "Artifacts node for the writing", /Shelf/u);
    await action1.getByLabel("Words at least").fill("500");
    await action1.getByLabel("Due after, in hours").fill("1");
    await action1.getByRole("switch", { name: "Urgent from the start" }).click();
    await shoot(page, "3-automation-work");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(pane.getByRole("button", { name: /^Daily words/u }).first()).toBeVisible({ timeout: 10_000 });
    await expect(pane.getByRole("button", { name: /Daily words, not saved/u })).toHaveCount(0, { timeout: 10_000 });
    await pane.getByRole("button", { name: /Run now/iu }).first().click();
    const listed = (await page.evaluate((canvas) => window.junto!.automationList(canvas, { nodeId: "auto" as never }), CANVAS)) as { automations: ReadonlyArray<{ automationId: string; name: string }> };
    const daily = listed.automations.find((a) => a.name === "Daily words")!;
    const firings = async () => ((await page.evaluate(({ canvas, id }) => window.junto!.automationFirings(canvas, { automationId: id as never }), { canvas: CANVAS, id: daily.automationId })) as { firings: ReadonlyArray<{ at: number; outcome: unknown }> }).firings;
    await expect.poll(async () => (await firings()).length, { timeout: 20_000 }).toBeGreaterThan(0);
    const firedAt = (await firings())[0]!.at;
    console.log("N-FIRING", JSON.stringify((await firings())[0]));
    await page.waitForTimeout(1_500);
    console.log("N-SIGNALS", JSON.stringify(await page.evaluate((canvas) => window.junto!.agentSignalsList(canvas), CANVAS)).slice(0, 2500));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    if ((await pane.count()) > 0) await page.keyboard.press("Escape");
    await openFeed();
    const workCard = card(/Write 500 words/u).first();
    await check("automation work: the card is in the feed from the Automations node", async () => {
      await expect(workCard).toBeVisible({ timeout: 20_000 });
      await expect(workCard.locator(".operator-feed__name")).toHaveText(/Automations|Daily words/u);
      console.log("N-CARD", await workCard.innerText());
    });
    await check("automation work: reads to do, urgent, due one hour after the firing", async () => {
      await expect(workCard.locator(".operator-feed__kind")).toHaveText("to do");
      const due = workCard.locator(".operator-feed__due");
      await expect(due).toHaveAttribute("data-urgent", "true");
      const hhmm = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(firedAt + 3_600_000);
      await expect(due).toContainText(hhmm);
    });
    await workCard.click();
    await expect(writing).toBeVisible({ timeout: 10_000 });
    await shoot(page, "4-automation-work-card");
    await write(words(499));
    await check("automation work: the count reads 499 words of 500 and Hand in says what is left", async () => {
      await expect(detail.locator(".signal-work__count")).toContainText("499 words of 500");
      await expect(handIn).toHaveAttribute("title", /1 more word\b/u);
    });
    await shoot(page, "4a-499-words");
    await check("automation work: close and reopen the feed keeps the writing", async () => {
      await closeFeed();
      await openFeed();
      await card(/Write 500 words/u).first().click();
      await expect(writing).toContainText("word498", { timeout: 10_000 });
    });
    await check("automation work: 499 words do not hand in", async () => {
      await expect(handIn).toHaveAttribute("aria-disabled", "true");
      await handIn.click({ force: true });
      await page.waitForTimeout(800);
      expect((await heads()).some((h) => h.artifact.title.startsWith("Write 500 words"))).toBe(false);
    });
    await write(words(500));
    await check("automation work: at 500 the meter is met and Hand in goes", async () => {
      await expect(detail.locator(".signal-work__progress")).toHaveAttribute("data-met", "true");
      await expect(handIn).not.toHaveAttribute("aria-disabled", "true");
    });
    await shoot(page, "4b-500-words-met");
    await check("automation work: 500 words make the artifact in Shelf, titled from the signal", async () => {
      await handIn.click();
      await expect.poll(async () => (await heads()).filter((h) => h.artifact.title.startsWith("Write 500 words, ")).length, { timeout: 15_000 }).toBe(1);
      const title = (await heads()).find((h) => h.artifact.title.startsWith("Write 500 words, "))!.artifact.title;
      expect(title, "fired.at filled").not.toContain("{{");
      console.log("N-TITLE", title);
    });
    await check("automation work: the feed empties", () => expect(cards).toHaveCount(0, { timeout: 10_000 }));
    await check("automation work: the feed reads Your work for today is done", () => expect(page.getByText("Your work for today is done")).toBeVisible({ timeout: 10_000 }));
    await shoot(page, "5-feed-empty");
    await closeFeed();

    // A notice that shows the Brief: no form, opens from the card, Clear empties it.
    await page.locator('.react-flow__node[data-id="auto"]').dblclick();
    await expect(pane).toBeVisible({ timeout: 20_000 });
    await build("Read the brief");
    await action1.getByRole("textbox", { name: "Signal title", exact: true }).fill("Read the brief");
    await check("notice: no form offered in the editor", () => expect(action1.getByRole("button", { name: "How you answer" })).toHaveCount(0));
    const show = action1.getByLabel("Artifact to show, optional");
    await show.click();
    await show.pressSequentially("#Brief");
    await page.getByRole("option", { name: /Brief/u }).first().click();
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(pane.getByRole("button", { name: /Read the brief, not saved/u })).toHaveCount(0, { timeout: 10_000 });
    await pane.getByRole("button", { name: /Run now/iu }).first().click();
    await page.waitForTimeout(800);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    if ((await pane.count()) > 0) await page.keyboard.press("Escape");
    await openFeed();
    const notice = card("Read the brief").first();
    await check("notice: the card reads notice, with no form", async () => {
      await expect(notice).toBeVisible({ timeout: 20_000 });
      await expect(notice.locator(".operator-feed__kind")).toHaveText("notice");
      await notice.click();
      await expect(detail.getByTestId("signal-work-form")).toHaveCount(0);
      await expect(detail.getByRole("button", { name: "Clear", exact: true })).toBeVisible();
    });
    await shoot(page, "6-notice");
    await check("notice: the shown artifact opens from the card", async () => {
      await detail.getByTestId("signal-resource-chips").getByRole("button").first().click();
      await expect(page.locator(".artifact-head__title")).toHaveValue("Brief", { timeout: 15_000 });
    });
    await shoot(page, "7-notice-opened-brief");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await openFeed();
    await check("notice: Clear empties it", async () => {
      await card("Read the brief").first().click();
      await detail.getByRole("button", { name: "Clear", exact: true }).click();
      await expect(cards).toHaveCount(0, { timeout: 10_000 });
    });
    await shoot(page, "8-cleared");

    // Dismiss asks first; then the smallest window with a work card open.
    expect((await seat.cli(["blocked", "Second job.", "--ask-artifact", "Shelf", "--min-words", "5"])).stdout).toContain('"ok":true');
    await check("dismiss on work asks Dismiss this work? first", async () => {
      await card("Second job.").first().click({ timeout: 15_000 });
      await detail.getByRole("button", { name: "Dismiss", exact: true }).click();
      const ask = page.getByRole("alertdialog", { name: "Dismiss this work?" }).or(page.getByRole("dialog", { name: "Dismiss this work?" }));
      await expect(ask).toBeVisible({ timeout: 5_000 });
      await ask.getByRole("button", { name: "Keep it", exact: true }).click();
      await expect(card("Second job.")).toHaveCount(1);
    });
    await shoot(page, "9-dismiss-kept");
    await (await junto.app.browserWindow(page)).evaluate((w) => w.setContentSize(960, 680));
    await page.waitForTimeout(600);
    await card("Second job.").first().click();
    await shoot(page, "10-smallest-window");
    await check("smallest window: the work form and Hand in are on screen", async () => {
      await expect(writing).toBeInViewport();
      await expect(handIn).toBeInViewport();
    });
  } finally {
    console.log("NWORK", JSON.stringify(results));
    await junto.close();
  }
  for (const r of results) expect.soft(r.pass, `${r.row}: ${r.detail ?? ""}`).toBe(true);
});
