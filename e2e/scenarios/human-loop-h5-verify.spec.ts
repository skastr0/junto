/**
 * Real app, plan 0.11 09 H5, the operator in an automation's loop, dark and
 * bright frames.
 *
 * "Ask ship" raises an escalate, "Ship build {{fired.at|date:YYYY-MM-DD}}?".
 * Its signal step's "When answered…" makes "Review on answer", linked to it,
 * which creates "Review {{fired.at|date:YYYY-MM-DD}}" in the Reviews node with
 * the answer and prompts the lead seat. Answered in the feed, the second
 * automation fires: the document lands, the seat hears the prompt, and the
 * first one's history shows the signal with its answer. Then ten firings of
 * "Ask ship" show ten signals, none merged. Each check is reported on its own.
 *   bun run test:e2e:fast e2e/scenarios/human-loop-h5-verify.spec.ts
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { asNodeId } from "../../src/shared/model";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelNode, modelRegion, modelSeat } from "../harness/model";

const CANVAS = "human-loop-h5-verify";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/human-loop-h5-verify";

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

/** YYYY-MM-DD in this machine's zone: the answered automation has no schedule, so its zone is its machine's. */
const day = (at: number): string => {
  const d = new Date(at);
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

type Result = { row: string; pass: boolean; detail?: string };
type Signal = { signalId: string; text: string; state: string; source?: { kind: string; automationId?: string; firingId?: string } };
type Head = { artifact: { title: string }; body: { markdown?: string } | null };

test("H5: an answered escalate starts a linked automation that writes a dated review and prompts a seat; ten firings, ten signals", async () => {
  test.setTimeout(420_000);
  const lead = modelSeat({ id: "lead", key: "local:h5-lead", label: "lead", harness: "codex", cwd: mkdtempSync(join(tmpdir(), "junto-h5-lead-")), x: 40, y: 60 });
  const junto = await launchJunto({
    windowContentSize: { width: 1500, height: 900 },
    seedModels: {
      [CANVAS]: modelFixture([
        modelRegion({ id: "ops", label: "Ops", x: 0, y: 0, width: 1000, height: 420 }),
        lead,
        modelNode({ kind: "artifacts", id: "reviews", label: "Reviews", x: 320, y: 60, width: 260, height: 140, z: 0 }),
        modelNode({ kind: "automations", id: "auto", label: "Automations", x: 640, y: 60, width: 260, height: 120, z: 0 }),
      ]),
    },
    afterSeed: installCrewSeatHarness,
  });
  const results: Result[] = [];
  const check = async (row: string, run: () => void | Promise<void>): Promise<void> => {
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
    await expect(page.locator('.react-flow__node[data-id="auto"]')).toBeVisible({ timeout: 30_000 });
    const seat = crewSeat(sandbox, CANVAS, "lead");
    await crewPlayFactory(page);
    await crewOccupySeat(page, CANVAS, lead, seat);

    const signals = async (): Promise<ReadonlyArray<Signal>> => (await page.evaluate((canvas) => window.junto!.agentSignalsList(canvas), CANVAS)) as ReadonlyArray<Signal>;
    const heads = (): Promise<ReadonlyArray<Head>> =>
      page.evaluate(({ canvas, node }) => window.junto!.resource!.artifact!.list(canvas, node), { canvas: CANVAS, node: asNodeId("reviews") }) as Promise<ReadonlyArray<Head>>;

    // The first automation: an escalate, its title formatted.
    await page.locator('.react-flow__node[data-id="auto"]').dblclick();
    const pane = page.getByTestId("automations-node");
    await expect(pane).toBeVisible({ timeout: 20_000 });
    const editor = pane.getByTestId("automation-editor");
    const action = (n: number) => editor.getByRole("group", { name: `Action ${String(n)}` });
    const on = editor.getByRole("switch", { name: "Automation on" });
    const limits = async (): Promise<void> => {
      await editor.getByLabel("Quiet time between firings, minutes").fill("0");
      await editor.getByLabel("At most, per hour").fill("60");
    };
    await pane.getByRole("button", { name: "New automation" }).first().click();
    await editor.getByLabel("Automation name").fill("Ask ship");
    if ((await on.getAttribute("aria-checked")) !== "true") await on.click();
    await choose(page, action(1), "Action 1", "Raise a signal");
    await check("the signal step offers the seat kinds and no work", async () => {
      await action(1).getByRole("button", { name: "What the signal asks", exact: true }).click();
      const offered = (await page.getByRole("option").allTextContents()).map((t) => t.trim());
      console.log("H5-KINDS", JSON.stringify(offered));
      expect(offered).toEqual(expect.arrayContaining(["Escalate, a question for you", "Blocked, waiting on you", "Feedback, for your review", "Notice, only to read"]));
      expect(offered.some((t) => /^Work/u.test(t))).toBe(false);
      await page.getByRole("option", { name: "Escalate, a question for you", exact: true }).click();
    });
    await action(1).getByRole("textbox", { name: "Signal title", exact: true }).fill("Ship build {{fired.at|date:YYYY-MM-DD}}?");
    await limits();
    await shoot(page, "1-ask-ship");

    // When answered…: saves this one and starts the linked one.
    await check("When answered… starts a new automation whose trigger is the answer", async () => {
      await action(1).getByRole("group", { name: "When answered" }).getByRole("button", { name: /When answered/u }).click();
      await expect(editor.getByLabel("Automation name")).not.toHaveValue("Ask ship", { timeout: 10_000 });
      console.log("H5-TRIGGER", (await editor.getByRole("region", { name: /Trigger/u }).first().innerText().catch(async () => editor.innerText())).slice(0, 400));
    });
    await editor.getByLabel("Automation name").fill("Review on answer");
    if ((await on.getAttribute("aria-checked")) !== "true") await on.click();
    await choose(page, action(1), "Action 1", "Create an artifact");
    await choose(page, action(1), "Artifacts node", /Reviews/u);
    await action(1).getByRole("textbox", { name: "Artifact title", exact: true }).fill("Review {{fired.at|date:YYYY-MM-DD}}");
    await action(1).getByRole("textbox", { name: "Artifact body, optional", exact: true }).fill("Answer: {{answer.text}}");
    await editor.getByRole("button", { name: "Action", exact: true }).click();
    await choose(page, action(2), "Action 2", "Prompt a seat");
    const to = action(2).getByLabel("Prompt to");
    await to.click();
    await to.pressSequentially("@lea");
    await page.getByRole("option", { name: /lead/u }).first().click();
    await action(2).getByRole("textbox", { name: "Prompt text", exact: true }).fill("Review this: {{answer.text}} (for {{signal.title}})");
    await limits();
    await shoot(page, "2-review-on-answer");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await check("both save, and Ask ship lists Review on answer as run when answered", async () => {
      await expect(pane.getByRole("button", { name: /not saved/u })).toHaveCount(0, { timeout: 10_000 });
      await pane.getByRole("button", { name: /^Ask ship/u }).first().click();
      await expect(action(1).getByRole("group", { name: "When answered" })).toContainText("Review on answer", { timeout: 10_000 });
    });
    await shoot(page, "3-linked");

    // Fire Ask ship once and answer it in the feed.
    await pane.getByRole("button", { name: /Run now/iu }).first().click();
    const listed = (await page.evaluate((canvas) => window.junto!.automationList(canvas, { nodeId: "auto" as never }), CANVAS)) as { automations: ReadonlyArray<{ automationId: string; name: string }> };
    const ask = listed.automations.find((a) => a.name === "Ask ship")!;
    const review = listed.automations.find((a) => a.name === "Review on answer");
    const ours = async () => (await signals()).filter((s) => s.source?.automationId === ask.automationId);
    await expect.poll(async () => (await ours()).length, { timeout: 20_000 }).toBe(1);
    const first = (await ours())[0]!;
    console.log("H5-SIGNAL", JSON.stringify(first).slice(0, 800));
    await check("the title's date format is filled", () => expect(first.text).toMatch(/^Ship build \d{4}-\d{2}-\d{2}\?$/u));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    if ((await pane.count()) > 0) await page.keyboard.press("Escape");
    await page.getByTestId("operator-feed-trigger").click();
    const cards = page.getByTestId("operator-feed-card");
    const card = cards.filter({ hasText: first.text }).first();
    await check("the escalate is in the feed, waiting on you, from the automation", async () => {
      await expect(card).toBeVisible({ timeout: 20_000 });
      await expect(card.locator(".operator-feed__kind")).toHaveText("waiting on you");
    });
    await card.click();
    const detail = page.getByTestId("operator-feed-detail");
    const writeReply = detail.getByRole("button", { name: /^Write reply/u });
    if ((await writeReply.count()) > 0) await writeReply.first().click();
    const reply = detail.getByRole("textbox", { name: "Your reply" }).or(detail.getByRole("combobox", { name: "Your reply" })).first();
    await reply.click();
    await page.keyboard.type("Ship it after the smoke test");
    await shoot(page, "4-answering");
    const answeredAt = Date.now();
    await detail.getByRole("button", { name: "Send reply", exact: true }).click();
    await check("the card closes once answered", () => expect(cards.filter({ hasText: first.text })).toHaveCount(0, { timeout: 15_000 }));
    await check("the signal is answered with the words", async () => {
      await expect.poll(async () => (await signals()).find((s) => s.signalId === first.signalId)?.state, { timeout: 10_000 }).toBe("answered");
    });

    // The linked automation fired: the document and the prompt.
    const title = `Review ${day(answeredAt)}`;
    await check(`the document "${title}" lands in Reviews with the answer`, async () => {
      await expect.poll(async () => (await heads()).filter((h) => h.artifact.title === title).length, { timeout: 30_000 }).toBe(1);
      const body = (await heads()).find((h) => h.artifact.title === title)!.body?.markdown ?? "";
      console.log("H5-DOC", JSON.stringify(body).slice(0, 400));
      expect(body).toContain("Ship it after the smoke test");
    });
    await check("the lead seat hears the prompt with the answer and the signal's title", async () => {
      await expect.poll(async () => (await seat.stdinLog()).includes("Review this: Ship it after the smoke test"), { timeout: 30_000 }).toBe(true);
      const log = await seat.stdinLog();
      console.log("H5-PROMPT", JSON.stringify(log.slice(log.indexOf("Review this:") - 200, log.indexOf("Review this:") + 300)));
      expect(log).toContain(first.text);
    });
    if (review !== undefined) {
      const reviewFirings = (await page.evaluate(({ canvas, id }) => window.junto!.automationFirings(canvas, { automationId: id as never }), { canvas: CANVAS, id: review.automationId })) as { firings: ReadonlyArray<unknown> };
      console.log("H5-REVIEW-FIRINGS", JSON.stringify(reviewFirings.firings).slice(0, 800));
    }
    await page.keyboard.press("Escape");

    // Ask ship's history shows the signal and its answer.
    await page.locator('.react-flow__node[data-id="auto"]').dblclick();
    await expect(pane).toBeVisible({ timeout: 20_000 });
    await pane.getByRole("button", { name: /^Ask ship/u }).first().click();
    const history = pane.getByRole("region", { name: "Firing history" }).or(pane.locator('[aria-label="Firing history"]')).first();
    const rows = history.locator(".automation-history__row");
    await rows.first().scrollIntoViewIfNeeded().catch(() => undefined);
    console.log("H5-HISTORY", JSON.stringify(await rows.allTextContents()).slice(0, 1200));
    await check("Ask ship's history shows the signal with its answer", async () => {
      await expect(rows.filter({ hasText: "Ship it after the smoke test" })).toHaveCount(1, { timeout: 15_000 });
    });
    await shoot(page, "5-history-answered");

    // Ten firings, ten signals.
    for (let n = 0; n < 10; n += 1) {
      await pane.getByRole("button", { name: /Run now/iu }).first().click();
      await page.waitForTimeout(250);
    }
    await check("ten firings raise ten open signals, each its own", async () => {
      await expect.poll(async () => (await ours()).filter((s) => s.state === "open").length, { timeout: 30_000 }).toBe(10);
      const open = (await ours()).filter((s) => s.state === "open");
      expect(new Set(open.map((s) => s.signalId)).size).toBe(10);
      expect(new Set(open.map((s) => s.source?.firingId)).size).toBe(10);
    });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    if ((await pane.count()) > 0) await page.keyboard.press("Escape");
    await page.getByTestId("operator-feed-trigger").click();
    await check("the feed shows ten cards, none merged", () => expect(cards.filter({ hasText: /^.*Ship build/u })).toHaveCount(10, { timeout: 20_000 }));
    await shoot(page, "6-ten-signals");
  } finally {
    console.log("H5", JSON.stringify(results));
    await junto.close();
  }
  for (const r of results) expect.soft(r.pass, `${r.row}: ${r.detail ?? ""}`).toBe(true);
});
