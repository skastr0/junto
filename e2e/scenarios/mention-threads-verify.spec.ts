/**
 * Plan 03 gaps 1 to 3, driven in the real app: # and @ in a seat's Threads
 * composer, a sent mention drawn as a chip that opens its target, and a task
 * comment thread's subject.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/mention-threads-verify.spec.ts
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { ElectronApplication } from "playwright-core";
import { Schema } from "effect";
import type { AgentSignal } from "../../src/shared/agent-signals";
import { asNodeId, Node } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { taskNodeId } from "../../src/shared/task-model";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelMessagesWire, modelNode, modelRegion, modelSeat } from "../harness/model";

const CANVAS = "mention-threads";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/mention-threads";

const atlas = modelSeat({ id: "atlas", key: "local:mt-atlas", label: "Atlas", harness: "claude", x: 40, y: 60 });
const bravo = modelSeat({ id: "bravo", key: "local:mt-bravo", label: "Bravo", harness: "claude", x: 40, y: 260 });
const docs = modelNode({ kind: "page", id: "docs", url: "https://example.com/", profile: "personal", onRemove: "kill-session", x: 400, y: 60, width: 240, height: 80, z: 0 });
const board = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({ kind: "task", id: "board", name: "Ship", x: 400, y: 260, width: 320, height: 220, z: 0 });
const shelf = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({ kind: "artifacts", id: "shelf", label: "Shelf", x: 780, y: 260, width: 240, height: 120, z: 0 });
const ops = modelRegion({ id: "ops", label: "Ops", x: 0, y: 0, width: 1100, height: 540 });
const nodes = [ops, atlas, bravo, docs, board, shelf];
const fixture = modelFixture(nodes, [modelMessagesWire("w1", "atlas", "bravo", nodes)]);

/** Trusted mouse input on the drawing overlay, as the operator's hand gives it. */
const drag = (app: ElectronApplication, from: { x: number; y: number }, to: { x: number; y: number }, release: boolean) =>
  app.evaluate(async ({ webContents }, input) => {
    const overlay = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith("data:text/html"));
    if (overlay === undefined) throw new Error("no drawing overlay");
    const pause = () => new Promise((resolve) => setTimeout(resolve, 30));
    if (input.release) {
      overlay.sendInputEvent({ type: "mouseUp", x: input.to.x, y: input.to.y, button: "left", clickCount: 1 });
      return;
    }
    overlay.sendInputEvent({ type: "mouseDown", x: input.from.x, y: input.from.y, button: "left", clickCount: 1 });
    for (let step = 1; step <= 8; step += 1) {
      await pause();
      overlay.sendInputEvent({
        type: "mouseMove",
        x: Math.round(input.from.x + ((input.to.x - input.from.x) * step) / 8),
        y: Math.round(input.from.y + ((input.to.y - input.from.y) * step) / 8),
        button: "left",
        modifiers: ["leftbuttondown"],
      });
    }
  }, { from, to, release });

const SIGNAL: AgentSignal = {
  signalId: "sig-compose",
  canvasName: CANVAS,
  nodeId: "atlas",
  kind: "feedback",
  text: "One more look at the onboarding copy?",
  createdAt: Date.now() - 120_000,
  state: "open",
};

const shot = async (page: Page, name: string): Promise<void> => {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

test("# and @ offer what is in reach, a sent mention is a chip that opens, a task thread shows its subject", async () => {
  test.setTimeout(240_000);
  const junto = await launchJunto({ seedModels: { [CANVAS]: fixture }, seedAgentSignals: [SIGNAL] });
  try {
    const { page } = junto;
    const card = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
    await expect(card("atlas")).toBeVisible({ timeout: 30_000 });

    const taskId = mintItemId();
    const taskResult = await page.evaluate(
      ({ canvas, node, taskId, opId }) => window.junto!.resource!.task!.apply(canvas, node, taskId, opId, { kind: "create", taskId, title: "Ship the wire spec" }),
      { canvas: CANVAS, node: taskNodeId(asNodeId("board")), taskId, opId: mintOpId() },
    );
    expect(taskResult.kind).toBe("applied");
    const artifactId = mintItemId();
    const artifactResult = await page.evaluate(
      ({ canvas, node, artifactId, opId }) =>
        window.junto!.resource!.artifact!.apply(canvas, node, artifactId, opId, { op: "create", title: "Wire spec notes", body: { type: "document", markdown: "# notes" } }),
      { canvas: CANVAS, node: asNodeId("shelf"), artifactId, opId: mintOpId() },
    );
    expect(artifactResult.kind).toBe("applied");

    // Gap 1: the seat's Threads composer.
    await card("atlas").dblclick();
    const button = page.getByTestId("seat-threads-button");
    await expect(button).toBeVisible({ timeout: 30_000 });
    await button.click();
    await page.getByTestId("seat-threads-new").click();
    const input = page.getByTestId("thread-composer-input");
    await expect(input).toBeVisible();
    await input.click();
    await input.pressSequentially("#");
    const options = page.getByTestId("mention-option");
    await expect(options.filter({ hasText: "Ship the wire spec" })).toBeVisible();
    await expect(options.filter({ hasText: "Wire spec notes" })).toBeVisible();
    await shot(page, "1-hash");
    console.log("HASH OPTIONS:", JSON.stringify(await options.allInnerTexts()));
    await input.fill("");
    await input.pressSequentially("@");
    await expect(options.filter({ hasText: "Bravo" })).toBeVisible();
    await expect(options.filter({ hasText: /example|docs/i })).toBeVisible();
    await shot(page, "2-at");
    console.log("AT OPTIONS:", JSON.stringify(await options.allInnerTexts()));

    // Gap 2: one message with a task, a seat and a page mention, drawn as chips.
    await input.fill("");
    await input.pressSequentially("look at #");
    await options.filter({ hasText: "Ship the wire spec" }).click();
    await input.pressSequentially("and @");
    await options.filter({ hasText: "Bravo" }).click();
    await input.pressSequentially("and @");
    await options.filter({ hasText: "example.com" }).click();
    await input.press("Enter");
    const mentions = page.getByTestId("seat-threads-mention");
    await expect(mentions).toHaveCount(3, { timeout: 20_000 });
    await shot(page, "3-chips");
    console.log("THREAD ROW:", JSON.stringify(await page.getByTestId("seat-threads-row").allInnerTexts()));
    console.log("THREAD TITLE:", await page.locator(".seat-threads__chat-title").innerText());
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    const failures: string[] = [];
    const section = async (name: string, body: () => Promise<void>): Promise<void> => {
      try {
        await body();
        console.log(`SECTION ${name}: ok`);
      } catch (error) {
        failures.push(name);
        console.log(`SECTION ${name} FAILED: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
        await shot(page, `fail-${name}`).catch(() => undefined);
        await page.keyboard.press("Escape").catch(() => undefined);
        await page.keyboard.press("Escape").catch(() => undefined);
      }
    };
    const openAtlasThread = async (): Promise<void> => {
      // A chip that opened Bravo leaves its surface up beside Atlas's, and Escape does not close a surface:
      // open Threads from whichever surface shows Atlas's, found by the popup's own name.
      const buttons = page.getByTestId("seat-threads-button");
      if ((await buttons.count()) === 0) {
        await card("atlas").dblclick();
        await expect(buttons.first()).toBeVisible({ timeout: 30_000 });
      }
      const total = await buttons.count();
      for (let index = 0; index < total; index += 1) {
        await buttons.nth(index).click();
        if (await page.getByTestId("seat-threads").filter({ hasText: "Atlas" }).isVisible()) break;
        await page.keyboard.press("Escape");
      }
      await expect(page.getByTestId("seat-threads")).toContainText("Atlas");
      await page.getByTestId("seat-threads-row").first().click();
    };
    const chipOpens = async (index: number, name: string): Promise<void> => {
      await openAtlasThread();
      await expect(mentions).toHaveCount(3, { timeout: 20_000 });
      await mentions.nth(index).click();
      await expect(page.getByTestId("seat-threads")).toHaveCount(0);
      await page.waitForTimeout(1_000);
      await shot(page, name);
    };
    await section("chip-seat", () => chipOpens(1, "6-opened-seat"));
    await section("chip-task", () => chipOpens(0, "7-opened-task"));

    // Gap 3: a comment on the task, made in the task's own thread, reaches Atlas with its subject.
    await section("task-thread", async () => {
      const field = page.getByLabel("Comment on this task");
      await field.click();
      await field.pressSequentially("ping @");
      await options.filter({ hasText: "Atlas" }).click();
      await field.pressSequentially("about this");
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      await expect(page.getByTestId("task-thread-post")).toHaveCount(1, { timeout: 20_000 });
      await shot(page, "8-task-comment");
      await page.keyboard.press("Escape");
      await openAtlasThread().catch(async () => {
        await page.getByTestId("seat-threads-button").click();
      });
      await shot(page, "9-threads-with-task-thread");
      const rows = page.getByTestId("seat-threads-row");
      console.log("ROWS:", JSON.stringify(await rows.allInnerTexts()));
      const taskRow = rows.filter({ hasText: "#1 Ship the wire spec" }).filter({ hasNotText: "look at" });
      await expect(taskRow).toHaveCount(1, { timeout: 20_000 });
      await taskRow.click();
      const subject = page.getByTestId("seat-threads-subject");
      await expect(subject).toBeVisible();
      await shot(page, "10-task-thread-subject");
      await subject.click();
      await expect(page.getByTestId("seat-threads")).toHaveCount(0);
    });

    // Gap 1, the needs-you reply composer.
    await section("needs-you-reply", async () => {
      await page.keyboard.press("Meta+I");
      const feed = page.getByTestId("operator-feed");
      await expect(feed).toBeVisible({ timeout: 10_000 });
      await page.keyboard.press("Enter");
      const reply = page.getByTestId("operator-feed-detail").getByLabel("Your reply");
      await expect(reply).toBeFocused();
      await reply.pressSequentially("#");
      await expect(options.filter({ hasText: "Ship the wire spec" })).toBeVisible();
      await shot(page, "11-reply-hash");
      await reply.fill("");
      await reply.pressSequentially("@");
      await expect(options.filter({ hasText: "Bravo" })).toBeVisible();
      await shot(page, "12-reply-at");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Meta+I");
    });

    // The page chip last: it leaves the page's surface open for the box comment.
    await section("chip-page", () => chipOpens(2, "5-opened-page"));

    // Gap 1, a box comment on a page.
    await section("page-box-comment", async () => {
      const area = page.locator('[data-testid="browser-comment-area"]');
      // The page chip opened the page's surface; it stays up, and covers the canvas.
      await expect(area).toBeVisible({ timeout: 30_000 });
      await expect.poll(
        () => junto.app.evaluate(({ webContents }) =>
          webContents.getAllWebContents().some((contents) => contents.getURL().startsWith("https://example.com/") && !contents.isLoading())),
        { timeout: 60_000 },
      ).toBe(true);
      await area.click();
      await expect.poll(
        () => junto.app.evaluate(({ webContents }) => webContents.getAllWebContents().some((contents) => contents.getURL().startsWith("data:text/html"))),
        { timeout: 10_000 },
      ).toBe(true);
      await page.waitForTimeout(300);
      await drag(junto.app, { x: 40, y: 60 }, { x: 420, y: 200 }, false);
      await drag(junto.app, { x: 420, y: 200 }, { x: 420, y: 200 }, true);
      const composer = page.getByTestId("box-comment-composer");
      await expect(composer).toBeVisible({ timeout: 20_000 });
      const comment = composer.locator('textarea[aria-label="Comment"]');
      await comment.click();
      await comment.pressSequentially("#");
      await expect(options.filter({ hasText: "Ship the wire spec" })).toBeVisible();
      await shot(page, "13-box-hash");
      await comment.fill("");
      await comment.pressSequentially("@");
      await expect(options.filter({ hasText: "Bravo" })).toBeVisible();
      await shot(page, "14-box-at");
    });

    expect(failures, `sections failed: ${failures.join(", ")}`).toEqual([]);
  } finally {
    await junto.close();
  }
});
