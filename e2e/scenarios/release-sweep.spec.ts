/**
 * The 0.10 release sweep, driven in the real app on a ship build:
 *   1. Tasks end to end on the new model, seats acting through the CLI.
 *   2. Deleted features stay gone; a Hermes seat opens as a terminal seat;
 *      Add item refuses the home folder in words.
 *   3. A task-change automation fires when a task goes working then done quickly.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/release-sweep.spec.ts
 * The seats' CLI is dist/junto (seat-env.ts injects JUNTO_CLI from it).
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { asNodeId, Node } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { taskNodeId, type TaskCommand } from "../../src/shared/task-model";
import type { ItemId } from "../../src/shared/work-ids";
import { oneReplyScenario, writeScenario } from "../fakes/hermes-scenario";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness, type CrewCliResult } from "../harness/crew-fixture";
import { expect, launchJunto, test, type JuntoHandle } from "../harness/launch";
import { modelFixture, modelNode, modelRegion, modelSeat, modelWire } from "../harness/model";

const SHOTS = process.env.JUNTO_SHOTS_DIR ?? join(process.cwd(), "test-results", "release-sweep");

const decode = (input: unknown): Node => Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })(input);
const at = (x: number, y: number, width: number, height: number) => ({ x, y, width, height, z: 0 });

const shot = async (page: Page, name: string): Promise<void> => {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

const envelope = (result: CrewCliResult): { ok?: boolean; data?: unknown; error?: { message?: string; type?: string } } => {
  const text = result.stdout.trim() || result.stderr.trim();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: { message: `${result.stdout}${result.stderr}` } };
  }
};

/** A seat's CLI call, logged; `expectOk` false expects a refusal and returns its words. */
const seatCli = async (junto: JuntoHandle, canvas: string, seat: string, argv: ReadonlyArray<string>, expectOk = true): Promise<string> => {
  const env = envelope(await crewSeat(junto.sandbox, canvas, seat).cli(argv));
  console.log(`CLI ${seat} ${argv.join(" ")} ->`, JSON.stringify(env).slice(0, 400));
  expect(env.ok === true, JSON.stringify(env)).toBe(expectOk);
  return env.error?.message ?? "";
};

const taskApply = (page: Page, canvas: string, board: string, taskId: ItemId, command: TaskCommand) =>
  page.evaluate(
    ({ canvas, node, taskId, opId, command }) => window.junto!.resource!.task!.apply(canvas, node, taskId, opId, command),
    { canvas, node: taskNodeId(asNodeId(board)), taskId, opId: mintOpId(), command },
  );

const applied = async (page: Page, canvas: string, board: string, taskId: ItemId, command: TaskCommand): Promise<void> => {
  const ruling = await taskApply(page, canvas, board, taskId, command);
  expect(ruling.kind, `${command.kind}: ${JSON.stringify(ruling).slice(0, 300)}`).toBe("applied");
};

const occupy = async (junto: JuntoHandle, canvas: string, seats: ReadonlyArray<{ readonly id: string }>): Promise<void> => {
  await crewPlayFactory(junto.page);
  for (const seat of seats) {
    const handle = crewSeat(junto.sandbox, canvas, seat.id);
    await crewOccupySeat(junto.page, canvas, seat, handle);
    expect((await handle.op("onboard", {})).ok, `${seat.id} onboards`).toBe(true);
  }
};

const openBoard = async (page: Page, board: string, title: string): Promise<void> => {
  await page.keyboard.press("Escape");
  await page.locator(`.react-flow__node[data-id="${board}"]`).dblclick();
  await page.getByRole("list", { name: "Tasks" }).locator("button").filter({ hasText: title }).first().click();
  await expect(page.getByTestId("task-detail")).toBeVisible({ timeout: 20_000 });
};

test("tasks end to end: a dependency holds finish, a handoff on the closed layer, changes then approve to done", async () => {
  test.setTimeout(420_000);
  const CANVAS = "sweep-tasks";
  const folder = mkdtempSync(join(tmpdir(), "junto-sweep-seat-"));
  const builder = modelSeat({ id: "builder", key: "local:sw-builder", label: "builder", harness: "codex", cwd: folder, x: 40, y: 60 });
  const critic = modelSeat({ id: "critic", key: "local:sw-critic", label: "critic", harness: "codex", cwd: folder, x: 40, y: 260 });
  const nodes: Node[] = [
    modelRegion({ id: "lane", label: "release lane", x: 0, y: 0, width: 1300, height: 560 }),
    builder,
    critic,
    decode({ kind: "task", id: "build", name: "Build", ...at(340, 40, 320, 220) }),
    decode({ kind: "task", id: "review", name: "Review", ...at(720, 40, 320, 220) }),
    decode({ kind: "task", id: "infra", name: "Infra", ...at(340, 300, 320, 220) }),
  ];
  const junto = await launchJunto({
    seedModels: { [CANVAS]: modelFixture(nodes, [modelWire("f1", "build", "review", "flows", nodes)]) },
    afterSeed: installCrewSeatHarness,
  });
  try {
    const { page } = junto;
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "bright" } }));
    await expect(page.locator('.react-flow__node[data-id="build"]')).toBeVisible({ timeout: 30_000 });
    await occupy(junto, CANVAS, [builder, critic]);

    // Create and assign: the parser waits on the migration.
    const migration = mintItemId();
    const parser = mintItemId();
    await applied(page, CANVAS, "infra", migration, { kind: "create", taskId: migration, title: "Write the migration" } as TaskCommand);
    await applied(page, CANVAS, "build", parser, { kind: "create", taskId: parser, title: "Ship the parser" } as TaskCommand);
    await applied(page, CANVAS, "build", parser, { kind: "depend", on: migration } as TaskCommand);
    await applied(page, CANVAS, "build", parser, { kind: "reviewer-add", reviewer: { kind: "seat", seat: asNodeId("critic") } } as TaskCommand);
    await applied(page, CANVAS, "build", parser, { kind: "stamp-policy", required: 1 } as TaskCommand);
    await applied(page, CANVAS, "build", parser, { kind: "assign", seat: asNodeId("builder") } as TaskCommand);
    await applied(page, CANVAS, "infra", migration, { kind: "assign", seat: asNodeId("critic") } as TaskCommand);

    // Start; the dependency refuses finish, in words.
    await seatCli(junto, CANVAS, "builder", ["task", "start", parser]);
    const held = await seatCli(junto, CANVAS, "builder", ["task", "finish", parser, "--note", "first pass"], false);
    console.log("DEPS REFUSAL:", held);
    expect(held).toMatch(/depends on work not done yet/);
    await openBoard(page, "build", "Ship the parser");
    await expect(page.getByTestId("task-deps")).toContainText("Write the migration");
    await shot(page, "t1-depends-on");

    // The migration lands; finish now goes to review.
    await seatCli(junto, CANVAS, "critic", ["task", "start", migration]);
    await seatCli(junto, CANVAS, "critic", ["task", "finish", migration]);
    await seatCli(junto, CANVAS, "builder", ["task", "finish", parser, "--note", "first pass"]);

    // The reviewer asks for changes: a defect, back to working.
    await seatCli(junto, CANVAS, "critic", ["task", "stamp", parser, "changes", "--text", "Cover the replay path"]);
    await openBoard(page, "build", "Ship the parser");
    const reviewer = page.getByTestId("task-reviewer").filter({ has: page.locator('[data-verdict="changes"]') }).or(page.locator('[data-testid="task-reviewer"][data-verdict="changes"]'));
    await expect(reviewer.first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("task-reviewers")).toContainText("Cover the replay path");
    await shot(page, "t2-changes-asked");

    // Finish again with a handoff; the operator approves; it is sent on to Review.
    await seatCli(junto, CANVAS, "builder", ["task", "finish", parser, "--note", "Parser ships with the replay path covered"]);
    await openBoard(page, "build", "Ship the parser");
    await page.getByTestId("task-stamp-approve").click();
    await openBoard(page, "review", "Ship the parser");
    const layers = page.getByTestId("task-layers");
    await expect(layers).toBeVisible({ timeout: 15_000 });
    await expect(layers.getByRole("region", { name: "Left on Build" })).toContainText("Parser ships with the replay path covered");
    await shot(page, "t3-handoff-on-closed-layer");

    // On Review: the operator's stamp takes it to done.
    await applied(page, CANVAS, "review", parser, { kind: "reviewer-add", reviewer: { kind: "operator" } } as TaskCommand);
    await applied(page, CANVAS, "review", parser, { kind: "stamp-policy", required: 1 } as TaskCommand);
    await applied(page, CANVAS, "review", parser, { kind: "assign", seat: asNodeId("builder") } as TaskCommand);
    await seatCli(junto, CANVAS, "builder", ["task", "start", parser]);
    await seatCli(junto, CANVAS, "builder", ["task", "finish", parser, "--note", "Reviewed end to end"]);
    await openBoard(page, "review", "Ship the parser");
    await page.getByTestId("task-stamp-approve").click();
    await expect(page.getByTestId("task-detail")).toContainText(/Done/, { timeout: 15_000 });
    await shot(page, "t4-approved-done");
  } finally {
    await junto.close();
  }
});

test("deleted features stay gone, Hermes opens as a terminal seat, Add item refuses the home folder", async () => {
  test.setTimeout(240_000);
  const CANVAS = "sweep-gone";
  const scenarioDir = mkdtempSync(join(tmpdir(), "junto-sweep-hermes-"));
  const scenarioPath = join(scenarioDir, "scenario.json");
  await writeScenario(scenarioPath, oneReplyScenario("managed-terminal"));
  const hermes = modelSeat({ id: "herm", key: "local:sw-herm", label: "Hermes seat", harness: "hermes", x: 40, y: 60 });
  const pageNode = modelNode({ kind: "page", id: "docs", url: "https://example.com/", profile: "personal", onRemove: "detach", ...at(360, 60, 240, 80) });
  const junto = await launchJunto({ extraEnv: { FAKE_HERMES_SCENARIO: scenarioPath }, seedModels: { [CANVAS]: modelFixture([hermes, pageNode]) } });
  try {
    const { page, sandbox } = junto;
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "bright" } }));
    const seatCard = page.locator('.react-flow__node[data-id="herm"]');
    await expect(seatCard).toBeVisible({ timeout: 30_000 });

    const gone = async (where: string): Promise<void> => {
      for (const name of [/Open (ACP )?chat/i, /pinned/i, /^Pin /i, /Open request inbox/i, /Open the board/i]) {
        await expect(page.getByRole("button", { name }), `${where}: ${name}`).toHaveCount(0);
      }
      for (const id of ["node-toolbar-page-pin", "requests-card", "board-card", "pad-pin-thread"]) {
        await expect(page.getByTestId(id), `${where}: ${id}`).toHaveCount(0);
      }
      await expect(page.getByLabel("Pinned work surface dock"), `${where}: dock`).toHaveCount(0);
    };
    await gone("canvas");
    await seatCard.click();
    await gone("seat selected");
    await shot(page, "g1-seat-selected");
    await page.locator('.react-flow__node[data-id="docs"]').click();
    await gone("page selected");
    await shot(page, "g2-page-selected");

    // Add item: no Requests or Board kinds; the home folder is refused in words.
    await page.getByRole("button", { name: "Add canvas item" }).click();
    const modal = page.getByRole("dialog", { name: "Add canvas item" });
    await expect(modal).toBeVisible();
    const deck = modal.getByRole("region", { name: "Add canvas item" });
    const catalog = (await deck.innerText()).split("\n").map((line) => line.trim()).filter(Boolean);
    console.log("ADD ITEM CATALOG:", JSON.stringify(catalog));
    expect(catalog).not.toContain("Requests");
    expect(catalog).not.toContain("Board");
    await gone("add item");
    const launch = deck.getByRole("region", { name: "Launch context" });
    await launch.getByRole("button", { name: "Choose starting folder" }).click();
    const picker = page.getByRole("dialog", { name: "Choose starting folder" });
    await expect(picker.locator("ul, [role='alert']").first()).toBeVisible({ timeout: 10_000 });
    await picker.getByLabel("Agent working directory").fill(sandbox.homeDir);
    await page.waitForTimeout(500);
    await picker.getByRole("button", { name: "Close folder picker" }).click();
    const home = page.getByTestId("launch-folder-home");
    await expect(home).toHaveText("Home is not a working folder: choose a project folder in it", { timeout: 10_000 });
    await shot(page, "g3-add-item-home-refused");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    // Settings: no Providers section and no Hermes host snapshots card.
    await page.getByRole("button", { name: "Open settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    console.log("SETTINGS NAV:", JSON.stringify((await settings.innerText()).split("\n").slice(0, 30)));
    await expect(settings.getByText("Hermes host snapshots")).toHaveCount(0);
    await expect(settings.getByRole("button", { name: "Providers", exact: true })).toHaveCount(0);
    await expect(settings.getByRole("tab", { name: "Providers", exact: true })).toHaveCount(0);
    await shot(page, "g4-settings");
    await page.keyboard.press("Escape");

    // Hermes opens as a terminal seat.
    await seatCard.dblclick();
    const surface = page.locator(".native-terminal-surface");
    await expect(surface).toBeVisible({ timeout: 20_000 });
    await expect(surface).toContainText("Hermes seat");
    await gone("hermes terminal");
    await shot(page, "g5-hermes-terminal");
  } finally {
    await junto.close();
  }
});

test("a task-change automation fires when a task goes working then done quickly", async () => {
  test.setTimeout(300_000);
  const CANVAS = "sweep-auto";
  const folder = mkdtempSync(join(tmpdir(), "junto-sweep-auto-"));
  const runner = modelSeat({ id: "runner", key: "local:sw-runner", label: "runner", harness: "codex", cwd: folder, x: 40, y: 60 });
  const nodes: Node[] = [
    modelRegion({ id: "lane", label: "auto lane", x: 0, y: 0, width: 1000, height: 400 }),
    runner,
    decode({ kind: "task", id: "board", name: "Ops", ...at(340, 40, 320, 220) }),
    modelNode({ kind: "automations", id: "auto", label: "Automations", ...at(700, 40, 260, 120) }),
  ];
  const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture(nodes) }, afterSeed: installCrewSeatHarness });
  try {
    const { page } = junto;
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "bright" } }));
    await expect(page.locator('.react-flow__node[data-id="auto"]')).toBeVisible({ timeout: 30_000 });
    await occupy(junto, CANVAS, [runner]);

    const automationId = mintItemId();
    const created = await page.evaluate(
      ({ canvas, automationId }) =>
        window.junto!.automationApply(canvas, {
          nodeId: "auto" as never,
          automationId: automationId as never,
          op: {
            kind: "create",
            automationId: automationId as never,
            enabled: true,
            definition: {
              name: "Follow a started task",
              trigger: { kind: "change", on: { kind: "task", task: { node: "board" }, becomes: "working" } },
              then: [{ kind: "create-task", node: "board" as never, title: "Check the started task" }],
              limits: { minIntervalMs: 0, maxPerHour: 12 },
            },
          },
        } as never),
      { canvas: CANVAS, automationId },
    );
    console.log("AUTOMATION CREATE:", JSON.stringify(created).slice(0, 300));
    expect((created as { kind: string }).kind).toBe("applied");
    // The runner's first pass on a canvas is its baseline; let it pass.
    await page.waitForTimeout(6_000);

    const quick = mintItemId();
    await applied(page, CANVAS, "board", quick, { kind: "create", taskId: quick, title: "Hotfix the banner" } as TaskCommand);
    await applied(page, CANVAS, "board", quick, { kind: "assign", seat: asNodeId("runner") } as TaskCommand);
    await seatCli(junto, CANVAS, "runner", ["task", "start", quick]);
    await seatCli(junto, CANVAS, "runner", ["task", "finish", quick]);

    await page.locator('.react-flow__node[data-id="auto"]').dblclick();
    const pane = page.getByTestId("automations-node");
    await expect(pane).toBeVisible({ timeout: 20_000 });
    await pane.getByRole("button", { name: /Follow a started task/ }).first().click();
    const fired = pane.locator('.automation-history__row[data-outcome="fired"]');
    await expect(fired.first()).toBeVisible({ timeout: 60_000 });
    console.log("HISTORY:", JSON.stringify(await pane.locator(".automation-history__row").allInnerTexts()));
    await expect(fired.first()).toContainText("Changed");
    await shot(page, "a1-task-trigger-fired");
  } finally {
    await junto.close();
  }
});
