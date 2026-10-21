/**
 * Canvas node redesign, step 1: every kind beside a seat, at 100% and far
 * zoom, dark and bright, plus an open modal for the same theme. Frames land
 * in test-results/node-redesign/ (disposable, never committed).
 *   bun run test:e2e:fast e2e/scenarios/node-redesign-shoot.spec.ts
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Effect, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { makeStateEngineLive } from "../../src/main/junto/state/engine";
import type { Sandbox } from "../harness/sandbox";
import { asNodeId, Node } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { taskNodeId } from "../../src/shared/task-model";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelNode, modelNote, modelRegion, modelSeat, modelTerminal } from "../harness/model";

const CANVAS = "node-redesign";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? join(process.cwd(), "test-results", "node-redesign");

const decode = (input: unknown): Node => Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })(input);
const at = (x: number, y: number, width: number, height: number) => ({ x, y, width, height, z: 0 });

const region = modelRegion({ id: "lane", label: "build lane", x: 0, y: 0, width: 1500, height: 700 });
const planner = modelSeat({ id: "planner", key: "local:nr-planner", label: "planner", harness: "claude", x: 40, y: 60 });
const builder = modelSeat({ id: "builder", key: "local:nr-builder", label: "builder", harness: "codex", x: 40, y: 200 });
const nodes: Node[] = [
  region,
  planner,
  builder,
  decode({ kind: "task", id: "board", name: "Ship 0.10", ...at(340, 40, 320, 220) }),
  decode({ kind: "task", id: "gate", name: "Release gate", ...at(980, 175, 240, 110) }),
  decode({ kind: "task", id: "intake", name: "Intake", ...at(1260, 130, 220, 150) }),
  decode({ kind: "page", id: "bad", url: "https://127.0.0.1:1/", profile: "personal", onRemove: "detach", ...at(620, 200, 240, 80) }),
  decode({ kind: "artifacts", id: "shelf", label: "Shelf", ...at(700, 40, 240, 120) }),
  decode({ kind: "automations", id: "auto", label: "Automations", ...at(980, 40, 260, 120) }),
  decode({ kind: "page", id: "docs", url: "https://example.com/docs", profile: "personal", onRemove: "detach", ...at(340, 300, 240, 80) }),
  modelTerminal({ id: "dev-server", bindingId: "local:nr-dev", label: "dev server", launch: { kind: "command", argv: ["sleep", "3600"] }, x: 620, y: 300 }),
  modelNode({ kind: "git", id: "repo", label: "junto", cwd: process.cwd(), ...at(920, 300, 280, 128) }),
  decode({ kind: "file", id: "pkg", path: join(process.cwd(), "package.json"), ...at(340, 460, 240, 80) }),
  decode({ kind: "link", id: "ref", url: "https://effect.website/docs", ...at(620, 460, 240, 80) }),
  { ...modelNote("note", "# Release notes\nShip the seat rings first, then the card pass.\n- rings move\n- crest for overseers", 900, 480), height: 100 },
  decode({ kind: "label", id: "label", text: "Staging", ...at(1260, 480, 160, 40) }),
  decode({ kind: "peer", id: "remote", label: "reviewer", host: "macbook", seatId: `seat_${"a".repeat(64)}`, ...at(40, 340, 240, 96) }),
  decode({ kind: "stub", id: "stub-git", of: "git", label: "other repo", ...at(1260, 300, 200, 80) }),
  decode({ kind: "stub", id: "stub-page", of: "page", host: "macbook", ...at(1260, 40, 200, 80) }),
];
const fixture = modelFixture(nodes);

/** Work as the task store holds it: a seat waiting on input (Blocked), and a review owed by the operator (Needs you). */
const seedWork = async (sandbox: Sandbox): Promise<void> => {
  const runtime = ManagedRuntime.make(makeStateEngineLive(join(sandbox.homeDir, ".junto", "state", "junto.db")));
  const at = Date.now() - 20 * 60_000;
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const insert = (taskId: string, number: number, node: string, title: string, state: string, reviewers: string, stamps: number) =>
          sql.unsafe(
            `INSERT INTO task_heads (canvas_name, task_id, number, node_id, title, state, assignee_node_id, epoch, stamps_required, reviewers_json, depends_on_json, checks_json, created_at, updated_at, state_since)
             VALUES (?, ?, 1, ?, ?, ?, ?, 0, ?, ?, '[]', '[]', ?, ?, ?)`,
            [CANVAS, taskId, node, title, state, "planner", stamps, reviewers, at, at, at],
          );
        yield* insert("01JZ00000000000000000000G1", 11, "gate", "Cut the 0.10 build", "input-required", "[]", 0);
        yield* insert("01JZ00000000000000000000I1", 12, "intake", "Pick the icon set", "in-review", '[{"kind":"operator"}]', 1);
      }),
    );
  } finally {
    await runtime.dispose();
  }
};

const scaleOf = (page: Page): Promise<number> =>
  page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport")!).transform).a);

const zoomTo = async (page: Page, goal: number): Promise<number> => {
  await page.evaluate((target) => {
    const read = (): number =>
      new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport")!).transform).a;
    const flow = document.querySelector(".react-flow")!.getBoundingClientRect();
    for (let i = 0; i < 200; i += 1) {
      const now = read();
      if (Math.abs(now - target) / target < 0.03) break;
      document.querySelector(".react-flow__pane")?.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: now > target ? 20 : -20,
          ctrlKey: true,
          clientX: flow.x + flow.width / 2,
          clientY: flow.y + flow.height / 2,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  }, goal);
  await page.waitForTimeout(1_200);
  return scaleOf(page);
};

const setTheme = async (page: Page, theme: "dark" | "bright"): Promise<void> => {
  await page.evaluate(async (next) => {
    await window.junto!.settingsPatch({ appearance: { theme: next } });
  }, theme);
  if (theme === "bright") await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
  else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
};

test("every node kind beside a seat, near and far, dark and bright", async () => {
  test.setTimeout(240_000);
  await mkdir(SHOTS, { recursive: true });
  const junto = await launchJunto({ seedModels: { [CANVAS]: fixture }, afterSeed: seedWork, windowContentSize: { width: 1700, height: 900 } });
  try {
    const { page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.react-flow__node[data-id="planner"]')).toBeVisible({ timeout: 30_000 });

    // Content a card can show: a task, an artifact, an automation.
    const taskId = mintItemId();
    const tasks = await page.evaluate(
      ({ canvas, node, id, opId }) => window.junto!.resource!.task!.apply(canvas, node, id, opId, { kind: "create", taskId: id, title: "Ship the wire spec" }),
      { canvas: CANVAS, node: taskNodeId(asNodeId("board")), id: taskId, opId: mintOpId() },
    );
    expect(tasks.kind).toBe("applied");
    const artifactId = mintItemId();
    await page.evaluate(
      ({ canvas, node, id, opId }) => window.junto!.resource!.artifact!.apply(canvas, node, id, opId, { op: "create", title: "Wire spec notes", body: { type: "document", markdown: "# notes" } }),
      { canvas: CANVAS, node: asNodeId("shelf"), id: artifactId, opId: mintOpId() },
    );
    for (const [automationId, name, enabled] of [
      [mintItemId(), "Morning standup", true],
      [mintItemId(), "Nightly review", false],
    ] as const) {
      await page.evaluate(async ({ canvas, automationId, name, enabled }) => {
        await window.junto!.automationApply(canvas, {
          nodeId: "auto" as never,
          automationId: automationId as never,
          op: {
            kind: "create",
            automationId: automationId as never,
            enabled,
            definition: {
              name,
              trigger: { kind: "schedule", cron: "0 9 * * 1-5", timezone: "UTC" },
              then: [{ kind: "create-task", node: "board" as never, title: "Plan the day" }],
              limits: { minIntervalMs: 60_000, maxPerHour: 12 },
            },
          },
        } as never);
      }, { canvas: CANVAS, automationId, name, enabled });
    }

    await junto.app.evaluate(({ BrowserWindow }, events) => {
      for (const window of BrowserWindow.getAllWindows()) {
        for (const event of events) window.webContents.send("junto:agent-seat-state-changed", event);
      }
    }, [
      { bindingId: "local:nr-planner", epoch: "e2e", state: "working", reason: "rule:osc_title_working", confidence: "high", at: Date.now() },
      { bindingId: "local:nr-builder", epoch: "e2e", state: "idle", reason: "rule:empty_prompt_idle", confidence: "high", at: Date.now() + 1 },
    ]);

    // A page whose load fails: open it once so it tries.
    await page.getByRole("button", { name: /fit all/i }).first().click();
    await page.locator('.react-flow__node[data-id="bad"]').dblclick();
    await page.waitForTimeout(4_000);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    const ids = ["planner", "builder", "remote", "board", "gate", "intake", "shelf", "auto", "docs", "bad", "dev-server", "repo", "pkg", "ref", "note", "label", "stub-git", "stub-page"];
    for (const theme of ["dark", "bright"] as const) {
      await setTheme(page, theme);
      await page.getByRole("button", { name: /fit all/i }).first().click();
      await page.mouse.move(5, 5);
      await page.waitForTimeout(800);
      // Near: as close to 100% as the board allows.
      const near = await zoomTo(page, 1);
      await page.getByRole("button", { name: /fit all/i }).first().click();
      await page.waitForTimeout(600);
      const fit = await scaleOf(page);
      await page.locator(".react-flow").screenshot({ path: join(SHOTS, `${theme}-board-fit-${fit.toFixed(2)}.png`) });
      for (const id of ids) {
        const node = page.locator(`.react-flow__node[data-id="${id}"]`);
        if (await node.count()) await node.screenshot({ path: join(SHOTS, `${theme}-near-${id}.png`) });
      }
      const far = await zoomTo(page, 0.26);
      await page.mouse.move(5, 5);
      await page.locator(".react-flow").screenshot({ path: join(SHOTS, `${theme}-board-far-${far.toFixed(2)}.png`) });
      console.log(`${theme}: fit ${fit.toFixed(2)}, near request reached ${near.toFixed(2)}, far ${far.toFixed(2)}`);

      // An open modal for scale: a seat's, and the task board's.
      await page.getByRole("button", { name: /fit all/i }).first().click();
      await page.waitForTimeout(600);
      await page.locator('.react-flow__node[data-id="board"]').dblclick();
      await page.waitForTimeout(1_200);
      await page.screenshot({ path: join(SHOTS, `${theme}-modal-task.png`) });
      const field = page.getByLabel("Comment on this task");
      if (await field.count()) {
        await field.click();
        await field.pressSequentially("Looks right, @pla");
        const option = page.getByRole("option", { name: /planner/ }).first();
        if (await option.count()) {
          await option.click();
          await field.press("Enter");
          await page.waitForTimeout(800);
        }
        await page.screenshot({ path: join(SHOTS, `${theme}-modal-task-mention.png`) });
      }
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
    }
  } finally {
    await junto.close();
  }
});
