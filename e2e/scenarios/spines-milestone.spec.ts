/**
 * The Spines milestone run: every node kind beside seats, near, fit and far,
 * dark and bright, with a task board a seat holds blocked and one that owes
 * the operator a stamp, seat signals open, the keyboard focus ring on a chip
 * and on a note, and each card's spoken name.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/spines-milestone.spec.ts
 * The seats' CLI is dist/junto (seat-env.ts injects JUNTO_CLI from it).
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { asNodeId, Node } from "../../src/shared/model";
import type { AgentSignal } from "../../src/shared/agent-signals";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { taskNodeId, type TaskCommand } from "../../src/shared/task-model";
import type { ItemId } from "../../src/shared/work-ids";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness, type CrewCliResult } from "../harness/crew-fixture";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelNode, modelNote, modelRegion, modelSeat, modelTerminal } from "../harness/model";

const CANVAS = "spines";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? join(process.cwd(), "test-results", "spines-milestone");

const decode = (input: unknown): Node => Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })(input);
const at = (x: number, y: number, width: number, height: number) => ({ x, y, width, height, z: 0 });

const folder = mkdtempSync(join(tmpdir(), "junto-spines-seat-"));
const region = modelRegion({ id: "lane", label: "build lane", x: 0, y: 0, width: 1500, height: 900 });
const planner = modelSeat({ id: "planner", key: "local:sp-planner", label: "planner", harness: "codex", cwd: folder, x: 40, y: 60 });
const builder = modelSeat({ id: "builder", key: "local:sp-builder", label: "builder", harness: "codex", cwd: folder, x: 40, y: 200 });
const critic = modelSeat({ id: "critic", key: "local:sp-critic", label: "critic", harness: "claude", x: 40, y: 480 });
const nodes: Node[] = [
  region,
  planner,
  builder,
  critic,
  decode({ kind: "task", id: "board", name: "Ship 0.10", ...at(340, 40, 320, 220) }),
  decode({ kind: "task", id: "board2", name: "Fixes", ...at(340, 640, 320, 220) }),
  decode({ kind: "artifacts", id: "shelf", label: "Shelf", ...at(700, 40, 240, 120) }),
  decode({ kind: "automations", id: "auto", label: "Automations", ...at(980, 40, 260, 120) }),
  decode({ kind: "page", id: "docs", url: "https://example.com/docs", profile: "personal", onRemove: "detach", ...at(340, 300, 240, 80) }),
  modelTerminal({ id: "dev-server", bindingId: "local:sp-dev", label: "dev server", launch: { kind: "command", argv: ["sleep", "3600"] }, x: 620, y: 300 }),
  modelNode({ kind: "git", id: "repo", label: "junto", cwd: process.cwd(), ...at(920, 300, 280, 128) }),
  decode({ kind: "file", id: "pkg", path: join(process.cwd(), "package.json"), ...at(340, 460, 240, 80) }),
  decode({ kind: "link", id: "ref", url: "https://effect.website/docs", ...at(620, 460, 240, 80) }),
  { ...modelNote("note", "# Release notes\nShip the seat rings first, then the card pass.\n- rings move\n- crest for overseers", 900, 480), height: 100 },
  decode({ kind: "label", id: "label", text: "Staging", ...at(1260, 480, 160, 40) }),
  decode({ kind: "peer", id: "remote", label: "reviewer", host: "macbook", seatId: `seat_${"a".repeat(64)}`, ...at(40, 340, 240, 96) }),
  decode({ kind: "stub", id: "stub-git", of: "git", label: "other repo", ...at(1260, 300, 200, 80) }),
  decode({ kind: "stub", id: "stub-page", of: "page", host: "macbook", ...at(1260, 40, 200, 80) }),
];
const IDS = ["planner", "builder", "critic", "remote", "board", "board2", "shelf", "auto", "docs", "dev-server", "repo", "pkg", "ref", "note", "label", "stub-git", "stub-page"];

const signal = (signalId: string, nodeId: string, kind: AgentSignal["kind"], text: string): AgentSignal => ({
  signalId,
  canvasName: CANVAS,
  nodeId,
  kind,
  text,
  createdAt: Date.now() - 60_000,
  state: "open",
});
const SIGNALS: ReadonlyArray<AgentSignal> = [
  signal("sig-critic", "critic", "escalate", "Which copy wins on the empty state?"),
];

const scaleOf = (page: Page): Promise<number> =>
  page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport")!).transform).a);

const zoomTo = async (page: Page, goal: number): Promise<number> => {
  await page.evaluate((target) => {
    const read = (): number => new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport")!).transform).a;
    const flow = document.querySelector(".react-flow")!.getBoundingClientRect();
    for (let i = 0; i < 200; i += 1) {
      const now = read();
      if (Math.abs(now - target) / target < 0.03) break;
      document.querySelector(".react-flow__pane")?.dispatchEvent(
        new WheelEvent("wheel", { deltaY: now > target ? 20 : -20, ctrlKey: true, clientX: flow.x + flow.width / 2, clientY: flow.y + flow.height / 2, bubbles: true, cancelable: true }),
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

const envelope = (result: CrewCliResult): { ok?: boolean; data?: unknown; error?: unknown } => {
  const text = result.stdout.trim() || result.stderr.trim();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: `${result.stdout}${result.stderr}` };
  }
};

test("spines: every kind beside seats, near, fit and far, dark and bright, blocked and needs-you, focus and names", async () => {
  test.setTimeout(420_000);
  mkdirSync(SHOTS, { recursive: true });
  const junto = await launchJunto({
    seedModels: { [CANVAS]: modelFixture(nodes) },
    seedAgentSignals: SIGNALS,
    afterSeed: installCrewSeatHarness,
    windowContentSize: { width: 1700, height: 1000 },
  });
  try {
    const { page, sandbox } = junto;
    const card = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
    await expect(card("planner")).toBeVisible({ timeout: 30_000 });

    const apply = (board: string, taskId: ItemId, command: TaskCommand) =>
      page.evaluate(
        ({ canvas, node, taskId, opId, command }) => window.junto!.resource!.task!.apply(canvas, node, taskId, opId, command),
        { canvas: CANVAS, node: taskNodeId(asNodeId(board)), taskId, opId: mintOpId(), command },
      );
    const seatCli = async (id: string, argv: ReadonlyArray<string>) => {
      const env = envelope(await crewSeat(sandbox, CANVAS, id).cli(argv));
      console.log(`CLI ${id} ${argv.join(" ")} ->`, JSON.stringify(env).slice(0, 300));
      expect(env.ok, JSON.stringify(env)).toBe(true);
    };

    // Content a card can show.
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

    // Seats take real tasks: planner pauses one (blocked), builder finishes one the operator must stamp (needs you).
    await crewPlayFactory(page);
    for (const seat of [planner, builder]) {
      const handle = crewSeat(sandbox, CANVAS, seat.id);
      await crewOccupySeat(page, CANVAS, seat, handle);
      expect((await handle.op("onboard", {})).ok, `${seat.id} onboards`).toBe(true);
    }
    const stuck = mintItemId();
    expect((await apply("board2", stuck, { kind: "create", taskId: stuck, title: "Fix the flaky reload" } as TaskCommand)).kind).toBe("applied");
    expect((await apply("board2", stuck, { kind: "assign", seat: asNodeId("planner") } as TaskCommand)).kind).toBe("applied");
    await seatCli("planner", ["task", "start", stuck]);
    await seatCli("planner", ["task", "pause", stuck]);
    const review = mintItemId();
    expect((await apply("board", review, { kind: "create", taskId: review, title: "Ship the wire spec" } as TaskCommand)).kind).toBe("applied");
    const other = mintItemId();
    expect((await apply("board", other, { kind: "create", taskId: other, title: "Draft the release notes" } as TaskCommand)).kind).toBe("applied");
    expect((await apply("board", review, { kind: "stamp-policy", required: 1 } as TaskCommand)).kind).toBe("applied");
    expect((await apply("board", review, { kind: "reviewer-add", reviewer: { kind: "operator" } } as TaskCommand)).kind).toBe("applied");
    expect((await apply("board", review, { kind: "assign", seat: asNodeId("builder") } as TaskCommand)).kind).toBe("applied");
    await seatCli("builder", ["task", "start", review]);
    await seatCli("builder", ["task", "finish", review, "--note", "Wire spec merged, ready for your stamp"]);
    await expect(card("board2")).toContainText(/Blocked/i, { timeout: 20_000 });
    await expect(card("board")).toContainText(/Needs you/i, { timeout: 20_000 });
    // A leaf line clips at its own node's box: a long path never prints over a neighbour.
    for (const id of ["pkg"]) {
      const node = await card(id).boundingBox();
      const leaf = await card(id).locator(".spine-leaf").boundingBox();
      expect(node, `${id} node`).not.toBeNull();
      expect(leaf, `${id} leaf`).not.toBeNull();
      expect(leaf!.x + leaf!.width, `${id} leaf right edge`).toBeLessThanOrEqual(node!.x + node!.width + 0.5);
    }

    // Spoken names, once: what a screen reader says for each card.
    const spoken: Record<string, string | null> = {};
    for (const id of IDS) spoken[id] = await card(id).getAttribute("aria-label");
    console.log("SPOKEN:", JSON.stringify(spoken, null, 1));

    for (const theme of ["dark", "bright"] as const) {
      await setTheme(page, theme);
      await page.getByRole("button", { name: /fit all/i }).first().click();
      await page.mouse.move(5, 5);
      await page.waitForTimeout(800);
      const near = await zoomTo(page, 1);
      await page.mouse.move(5, 5);
      for (const id of IDS) {
        if (await card(id).count()) await card(id).screenshot({ path: join(SHOTS, `${theme}-near-${id}.png`) });
      }
      await page.getByRole("button", { name: /fit all/i }).first().click();
      await page.waitForTimeout(800);
      const fit = await scaleOf(page);
      await page.locator(".react-flow").screenshot({ path: join(SHOTS, `${theme}-fit-${fit.toFixed(2)}.png`) });
      const far = await zoomTo(page, 0.26);
      await page.mouse.move(5, 5);
      await page.locator(".react-flow").screenshot({ path: join(SHOTS, `${theme}-far-${far.toFixed(2)}.png`) });
      console.log(`${theme}: near ${near.toFixed(2)}, fit ${fit.toFixed(2)}, far ${far.toFixed(2)}`);
    }

    // Keyboard focus ring, bright, near: on a chip, and on a note's text.
    await page.getByRole("button", { name: /fit all/i }).first().click();
    await page.waitForTimeout(600);
    await zoomTo(page, 1);
    for (const id of ["shelf", "note", "label"]) {
      await page.keyboard.press("Tab");
      const focused = await card(id).evaluate((element) => {
        const target = element.querySelector<HTMLElement>("[tabindex], button, a, [contenteditable]") ?? (element as HTMLElement);
        target.focus();
        return { tag: target.tagName, label: target.getAttribute("aria-label"), visible: target.matches(":focus-visible") };
      });
      console.log(`FOCUS ${id}:`, JSON.stringify(focused));
      await card(id).scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(SHOTS, `bright-focus-${id}.png`) });
    }
  } finally {
    await junto.close();
  }
});
