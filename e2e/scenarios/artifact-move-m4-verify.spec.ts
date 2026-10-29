/**
 * Real app, plan 0.11 10 M4, moving artifacts across regions, dark and bright.
 *
 * Product holds Scout and Specs; Release holds Ada and Shelf. Plan carries the
 * labels draft and wip, and Notes links it, so Plan has a backlink. Specs
 * colours draft green and wip teal; Shelf colours draft purple and wip not at
 * all. Plan moves from Specs to Shelf by M, read on the reach line. Then:
 * Notes' link chip still opens Plan; Plan's backlink still lists Notes; the
 * labels stay, draft in Shelf's purple and wip plain; the history reads Moved
 * from Specs to Shelf; Scout no longer lists Plan and Ada does. Last, two
 * picked rows move together. Each check is reported on its own.
 *   bun run test:e2e:fast e2e/scenarios/artifact-move-m4-verify.spec.ts
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { asNodeId } from "../../src/shared/model";
import { mintOpId } from "../../src/shared/resource-command";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelNode, modelRegion, modelSeat } from "../harness/model";

const CANVAS = "artifact-move-m4-verify";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/artifact-move-m4-verify";

const shoot = async (page: Page, name: string): Promise<void> => {
  for (const theme of ["dark", "bright"] as const) {
    mkdirSync(join(SHOTS, theme), { recursive: true });
    await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, theme, `${name}.png`) });
  }
  await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
};

const row = (page: Page, title: string) => page.getByRole("list", { name: "Artifacts" }).locator("button").filter({ hasText: title }).first();

type Result = { row: string; pass: boolean; detail?: string };
type Json = { ok?: boolean; data?: Record<string, unknown> };

test("M4: a document with a backlink and labels moves across regions; links, labels, history and reach follow; two rows move together", async () => {
  test.setTimeout(360_000);
  const scout = modelSeat({ id: "scout", key: "local:m4-scout", label: "Scout", harness: "codex", cwd: mkdtempSync(join(tmpdir(), "junto-m4-scout-")), x: 40, y: 60 });
  const ada = modelSeat({ id: "ada", key: "local:m4-ada", label: "Ada", harness: "codex", cwd: mkdtempSync(join(tmpdir(), "junto-m4-ada-")), x: 940, y: 60 });
  const junto = await launchJunto({
    windowContentSize: { width: 1500, height: 900 },
    seedModels: {
      [CANVAS]: modelFixture([
        modelRegion({ id: "product", label: "Product", x: 0, y: 0, width: 800, height: 420 }),
        modelRegion({ id: "release", label: "Release", x: 900, y: 0, width: 800, height: 420 }),
        scout,
        ada,
        modelNode({ kind: "artifacts", id: "specs", label: "Specs", x: 320, y: 60, width: 260, height: 140, z: 0 }),
        modelNode({ kind: "artifacts", id: "shelf", label: "Shelf", x: 1220, y: 60, width: 260, height: 140, z: 0 }),
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
    await expect(page.locator('.react-flow__node[data-id="specs"]')).toBeVisible({ timeout: 30_000 });
    const scoutSeat = crewSeat(sandbox, CANVAS, "scout");
    const adaSeat = crewSeat(sandbox, CANVAS, "ada");
    await crewPlayFactory(page);
    await crewOccupySeat(page, CANVAS, scout, scoutSeat);
    await crewOccupySeat(page, CANVAS, ada, adaSeat);
    const cli = async (seat: typeof scoutSeat, argv: ReadonlyArray<string>): Promise<{ json: Json; raw: string }> => {
      const r = await seat.cli(argv);
      const raw = (r.stdout.trim() === "" ? r.stderr : r.stdout).trim();
      return { json: JSON.parse(raw) as Json, raw };
    };
    const idOf = (j: Json): string => {
      const d = j.data as { artifactId?: string; id?: string; artifact?: { artifactId?: string; id?: string } } | undefined;
      return (d?.artifactId ?? d?.id ?? d?.artifact?.artifactId ?? d?.artifact?.id)!;
    };

    // Scout writes Plan (labelled) and Notes (linking Plan) in Specs, plus two for the group move.
    const plan = idOf((await cli(scoutSeat, ["artifact", "create", "Plan", "--type", "document", "--markdown", "# Plan\n\nShip it.", "--label", "draft", "--label", "wip"])).json);
    const notes = idOf((await cli(scoutSeat, ["artifact", "create", "Notes", "--type", "document", "--markdown", "See [[Plan]] first."])).json);
    for (const title of ["Beta", "Gamma"]) await cli(scoutSeat, ["artifact", "create", title, "--type", "document", "--markdown", `# ${title}`]);
    const colour = (node: string, label: string, c: string | null) =>
      page.evaluate(({ canvas, node, opId, label, c }) => window.junto!.resource!.artifact!.colour(canvas, node, opId, label, c as never), { canvas: CANVAS, node: asNodeId(node), opId: mintOpId(), label, c });
    await colour("specs", "draft", "green");
    await colour("specs", "wip", "teal");
    await colour("shelf", "draft", "purple");
    const scoutListsPlan = async () => (await cli(scoutSeat, ["artifact", "list"])).raw.includes(plan);
    const adaListsPlan = async () => (await cli(adaSeat, ["artifact", "list"])).raw.includes(plan);
    await check("before: Scout lists Plan and Ada does not", async () => {
      expect(await scoutListsPlan()).toBe(true);
      expect(await adaListsPlan()).toBe(false);
    });

    // Move Plan by M, reading the reach line.
    await page.locator('.react-flow__node[data-id="specs"]').dblclick();
    await expect(page.getByRole("list", { name: "Artifacts" })).toBeVisible({ timeout: 20_000 });
    await row(page, "Plan").click();
    await check("Plan shows its labels in Specs' colours before", async () => {
      const chips = page.locator(".artifact-labels__chip");
      await expect(chips.filter({ hasText: "draft" }).first()).toHaveAttribute("data-label-colour", "green");
      await expect(chips.filter({ hasText: "wip" }).first()).toHaveAttribute("data-label-colour", "teal");
    });
    await shoot(page, "1-plan-in-specs");
    await row(page, "Plan").focus();
    await page.keyboard.press("m");
    const dialog = page.getByRole("dialog", { name: "Move Plan" });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole("option").filter({ hasText: "Shelf" }).click();
    await check("the reach line names both regions", () => expect(dialog.locator(".artifact-move__reach")).toHaveText("Seats in Product will no longer reach this; seats in Release will."));
    await shoot(page, "2-move-plan-reach");
    await page.keyboard.press("Enter");
    await check("Plan moves to Shelf", async () => {
      await expect(dialog).toBeHidden({ timeout: 10_000 });
      await expect(page.locator(".artifacts-moved")).toHaveText("Moved Plan to Shelf.");
    });

    // Notes' link chip still opens Plan.
    await row(page, "Notes").click();
    await check("Notes' link to Plan still opens Plan, now in Shelf", async () => {
      const chip = page.getByTestId("document-mention-chip").filter({ hasText: "Plan" }).first();
      await expect(chip).not.toHaveAttribute("data-missing", "true", { timeout: 10_000 });
      await chip.click({ timeout: 10_000 });
      // Plan opens on top of Notes: the last title is the one in front.
      await expect(page.locator(".artifact-head__title").last()).toHaveValue("Plan", { timeout: 15_000 });
    });
    await shoot(page, "3-link-chip-opens-plan");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    if ((await page.getByRole("list", { name: "Artifacts" }).count()) > 0) await page.keyboard.press("Escape");

    // In Shelf: labels, history.
    await page.locator('.react-flow__node[data-id="shelf"]').dblclick();
    await expect(page.getByRole("list", { name: "Artifacts" })).toBeVisible({ timeout: 20_000 });
    await row(page, "Plan").click();
    await check("the labels stay: draft in Shelf's purple, wip plain", async () => {
      const chips = page.locator(".artifact-labels__chip");
      await expect(chips.filter({ hasText: "draft" }).first()).toHaveAttribute("data-label-colour", "purple");
      await expect(chips.filter({ hasText: "wip" }).first()).not.toHaveAttribute("data-label-colour", /./u);
    });
    await shoot(page, "4-plan-in-shelf-labels");
    await page.getByRole("button", { name: "History" }).click();
    await check("history reads Moved from Specs to Shelf", () => expect(page.locator(".artifact-history__list")).toContainText("Moved from Specs to Shelf", { timeout: 10_000 }));
    await shoot(page, "5-history-moved");
    await page.getByRole("button", { name: "History" }).click().catch(() => undefined);
    await check("the backlink holds: Plan's Linked from still lists Notes, across the regions", async () => {
      const panel = page.getByTestId("linked-from");
      if (!(await panel.isVisible())) {
        const edge = page.locator(".artifact-comments-edge");
        if ((await edge.count()) === 0) await page.locator('[data-comments-toggle][aria-expanded="true"]').first().click();
        await expect(edge).toHaveAttribute("aria-label", /linked from 1/u, { timeout: 15_000 });
        await edge.click();
      }
      await expect(panel).toBeVisible({ timeout: 10_000 });
      await expect(panel.getByTestId("linked-from-row").filter({ hasText: "Notes" })).toHaveCount(1, { timeout: 10_000 });
    });
    await shoot(page, "5a-linked-from");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    if ((await page.getByRole("list", { name: "Artifacts" }).count()) > 0) await page.keyboard.press("Escape");

    // Reach and the backlink, from the seats.
    await check("after: Scout no longer lists Plan", async () => expect(await scoutListsPlan()).toBe(false));
    await check("after: Ada lists Plan", async () => expect(await adaListsPlan()).toBe(true));
    // Ada reaches Plan but not Notes, so her linkedFrom rightly leaves Notes out; logged, not judged.
    console.log("M4-ADA-LINKEDFROM", notes, (await cli(adaSeat, ["artifact", "show", plan])).raw.match(/"linkedFrom":\{[^}]*\}/u)?.[0]);
    await check("Ada reads Plan's labels with Shelf's colour for draft only", async () => {
      const raw = (await cli(adaSeat, ["artifact", "show", plan])).raw;
      const colours = JSON.stringify((JSON.parse(raw) as Json).data?.["labelColours"] ?? (JSON.parse(raw) as { data?: { artifact?: { labelColours?: unknown } } }).data?.artifact?.labelColours);
      console.log("M4-COLOURS", colours);
      expect(colours).toContain("purple");
      expect(colours).not.toContain("teal");
    });

    // Two picked rows move together.
    await page.locator('.react-flow__node[data-id="specs"]').dblclick();
    await expect(page.getByRole("list", { name: "Artifacts" })).toBeVisible({ timeout: 20_000 });
    // Gamma sits above Beta: Shift and an arrow picks the second, as the move window has it.
    await row(page, "Gamma").click();
    await row(page, "Gamma").focus();
    await page.keyboard.press("Shift+ArrowDown");
    await check("two rows picked", () => expect(page.locator('.artifacts-list__item[data-picked="true"]')).toHaveCount(2));
    await page.keyboard.press("m");
    const two = page.getByRole("dialog", { name: "Move 2 artifacts" });
    await check("M opens the move for both", () => expect(two).toBeVisible({ timeout: 10_000 }));
    await two.getByRole("option").filter({ hasText: "Shelf" }).click();
    await page.keyboard.press("Enter");
    await check("both land in Shelf", async () => {
      await expect(page.locator(".artifacts-moved")).toHaveText("Moved 2 artifacts to Shelf.", { timeout: 10_000 });
      const titles = ((await page.evaluate(({ canvas, node }) => window.junto!.resource!.artifact!.list(canvas, node), { canvas: CANVAS, node: asNodeId("shelf") })) as ReadonlyArray<{ artifact: { title: string } }>).map((h) => h.artifact.title).sort();
      expect(titles).toEqual(["Beta", "Gamma", "Plan"]);
    });
    await shoot(page, "6-two-moved");
  } finally {
    console.log("M4", JSON.stringify(results));
    await junto.close();
  }
  for (const r of results) expect.soft(r.pass, `${r.row}: ${r.detail ?? ""}`).toBe(true);
});
