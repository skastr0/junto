/**
 * Real app, c8262a42d and f73fcde88, dark and bright. (1) The Artifacts
 * window list with one row open, two others picked by Cmd-click and one more
 * hovered: picked is cyan at 10%, hovered overlay-1, the open row its own;
 * then a Shift run that takes the open row in too (cyan at 18%; Cmd-click
 * never picks the open row, ArtifactsNode pickRow). The Move to picker
 * (Combobox) with the keyboard's active option and a hovered one. (2) A > blockquote in a
 * document's live editor and in rendered markdown (ArtifactMarkdown, here a
 * signal's detail, which draws the same .artifact-markdown rule): a neutral
 * 2px stroke-hi rule, not amber. Fills and rules are read as computed.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/artifacts-picked-quote-verify.spec.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { AgentSignal } from "../../src/shared/agent-signals";
import { asNodeId } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelNode, modelSeat } from "../harness/model";

const CANVAS = "picked-quote";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/artifacts-picked-quote-verify";
const QUOTE = "> Ship the wire spec before the review, not after.";
const TITLES = ["Alpha notes", "Beta plan", "Gamma review", "Delta errands", "Echo draft"];

const row = (page: Page, title: string): Locator => page.getByRole("list", { name: "Artifacts" }).locator("button").filter({ hasText: title }).first();
const fill = (target: Locator) => target.evaluate((el) => getComputedStyle(el).backgroundColor);
const rule = (target: Locator) =>
  target.evaluate((el) => {
    const s = getComputedStyle(el);
    return { left: `${s.borderLeftWidth} ${s.borderLeftStyle} ${s.borderLeftColor}`, shadow: s.boxShadow };
  });
const setTheme = (page: Page, theme: "dark" | "bright") => page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);

test("artifacts: picked, hovered and open rows read apart; the quote rule is neutral in the editor and rendered", async () => {
  test.setTimeout(300_000);
  const signal = {
    signalId: "sig-quote",
    canvasName: CANVAS,
    nodeId: "worker",
    kind: "escalate",
    text: "Does this quote read right?",
    detail: `The review said:\n\n${QUOTE}\n\nAgreed?`,
    createdAt: Date.now() - 10 * 60_000,
    state: "open",
  } as AgentSignal;
  const junto = await launchJunto({
    windowContentSize: { width: 1500, height: 900 },
    seedModels: {
      [CANVAS]: modelFixture([
        modelNode({ kind: "artifacts", id: "specs", label: "Specs", x: 60, y: 60, width: 300, height: 200, z: 0 }),
        modelNode({ kind: "artifacts", id: "shelf", label: "Shelf", x: 60, y: 320, width: 300, height: 200, z: 0 }),
        modelNode({ kind: "artifacts", id: "archive", label: "Archive", x: 400, y: 320, width: 300, height: 200, z: 0 }),
        modelNode({ kind: "artifacts", id: "drafts", label: "Drafts", x: 740, y: 320, width: 300, height: 200, z: 0 }),
        modelSeat({ id: "worker", key: "local:pq-worker", label: "worker", x: 500, y: 60 }),
      ]),
    },
    seedAgentSignals: [signal],
  });
  const out: Record<string, unknown> = {};
  const misses: string[] = [];
  const step = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      misses.push(`${name}: ${String(error).replace(/\u001b\[[0-9;]*m/gu, "").split("\n").slice(0, 3).join(" ")}`);
    }
  };
  const frames = async (name: string, read: () => Promise<unknown>): Promise<void> => {
    for (const theme of ["dark", "bright"] as const) {
      mkdirSync(join(SHOTS, theme), { recursive: true });
      await setTheme(junto.page, theme);
      await junto.page.waitForTimeout(400);
      await junto.page.screenshot({ path: join(SHOTS, theme, `${name}.png`) });
      out[`${theme}/${name}`] = await read();
    }
    await setTheme(junto.page, "dark");
  };
  try {
    const { page } = junto;
    await setTheme(page, "dark");
    await expect(page.locator('.react-flow__node[data-id="specs"]')).toBeVisible({ timeout: 30_000 });
    for (const title of TITLES) {
      const markdown = title === "Alpha notes" ? `# Alpha notes\n\n${QUOTE}\n\nA line after the quote.` : `# ${title}\n\nBody of ${title}.`;
      await page.evaluate(
        ({ canvas, node, artifactId, opId, title, markdown }) =>
          window.junto!.resource!.artifact!.apply(canvas, node, artifactId as never, opId, { op: "create", title, body: { type: "document", markdown }, labels: [] }),
        { canvas: CANVAS, node: asNodeId("specs"), artifactId: mintItemId(), opId: mintOpId(), title, markdown },
      );
    }
    await page.locator('.react-flow__node[data-id="specs"]').dblclick();
    await expect(page.getByRole("list", { name: "Artifacts" })).toBeVisible({ timeout: 20_000 });

    const fills = async () =>
      Object.fromEntries(
        await Promise.all(
          TITLES.map(async (t) => {
            const button = row(page, t);
            const item = button.locator("xpath=..");
            return [t, { fill: await fill(button), picked: await item.getAttribute("data-picked"), selected: await button.getAttribute("data-selected"), hovered: await button.evaluate((el) => el.matches(":hover")) }] as const;
          }),
        ),
      );

    await step("list: open, two picked, one hovered", async () => {
      await row(page, "Alpha notes").click();
      // Cmd held across the clicks, as the operator holds it.
      await page.keyboard.down("Meta");
      await row(page, "Gamma review").click();
      await row(page, "Delta errands").click();
      await page.keyboard.up("Meta");
      await expect(page.locator('.artifacts-list__item[data-picked="true"]')).toHaveCount(2, { timeout: 5_000 });
      await row(page, "Echo draft").hover();
      await frames("01-list-open-picked-hovered", fills);
    });

    await step("quote in the live editor", async () => {
      const quote = page.locator(".live-markdown .cm-md-quote").first();
      await expect(quote).toBeVisible({ timeout: 10_000 });
      await frames("03-quote-live-editor", () => rule(quote));
    });

    await step("list: a Shift run takes the open row in", async () => {
      await row(page, "Alpha notes").click();
      await row(page, "Gamma review").click({ modifiers: ["Shift"] });
      await row(page, "Echo draft").hover();
      await frames("02-list-open-row-picked", fills);
    });

    await step("Move to: the keyboard's active option and a hovered one", async () => {
      await row(page, "Alpha notes").click();
      await row(page, "Alpha notes").focus();
      await page.keyboard.press("m");
      const dialog = page.getByRole("dialog", { name: "Move Alpha notes" });
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      const options = dialog.getByRole("option");
      await expect(options.nth(2)).toBeVisible({ timeout: 10_000 });
      await page.keyboard.press("ArrowDown");
      await options.nth(2).hover();
      await frames("05-move-to-active-hovered", () =>
        options.evaluateAll((els) => els.map((el) => ({ text: el.textContent?.slice(0, 30), active: el.getAttribute("data-active") ?? el.id === document.querySelector("[aria-activedescendant]")?.getAttribute("aria-activedescendant"), selected: el.getAttribute("aria-selected"), hovered: el.matches(":hover"), fill: getComputedStyle(el).backgroundColor }))),
      );
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
    });

    await step("quote rendered", async () => {
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      const seat = page.locator('.react-flow__node[data-id="worker"]');
      await seat.dblclick();
      const view = page.locator(".workbench-pane:not(.workbench-pane--parked) .native-terminal-surface");
      await view.getByTestId("seat-details-button").click({ timeout: 20_000 });
      await page.getByTestId("seat-signal-row").first().click();
      const quote = page.locator(".artifact-markdown blockquote").first();
      await expect(quote).toBeVisible({ timeout: 10_000 });
      await frames("04-quote-rendered", () => rule(quote));
    });
  } finally {
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, "read.json"), JSON.stringify({ out, misses }, null, 2));
    await junto.close();
  }
  console.log("PQ", JSON.stringify(out));
  console.log("PQ-MISSES", JSON.stringify(misses));
  expect(misses).toEqual([]);
});
