/**
 * Real app, plan 0.11 08 B4, briefings written as documents, dark and bright.
 *
 * A region's briefing takes a heading, a list and mentions of an artifact and
 * a seat; the app briefing and a reference take the same. `junto onboard`
 * from a seat in that region returns each text as written, never expanded,
 * with `region.mentions` and `briefing_mentions` resolved, and an artifact
 * whose node is gone listed as kind missing; `junto references read` the
 * same shape. Each check is reported on its own.
 *   bun run test:e2e:fast e2e/scenarios/briefings-verify.spec.ts
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { asNodeId } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { expect, launchJunto, test } from "../harness/launch";
import { commandModel, modelFixture, modelNode, modelRegion, modelSeat } from "../harness/model";

const CANVAS = "briefings-verify";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/briefings-verify";

const shoot = async (page: Page, name: string): Promise<void> => {
  for (const theme of ["dark", "bright"] as const) {
    mkdirSync(join(SHOTS, theme), { recursive: true });
    await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, theme, `${name}.png`) });
  }
  await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
};

type Result = { row: string; pass: boolean; detail?: string };
type Mention = { label?: string; ref?: string; kind?: string; id?: string; title?: string; reachable?: boolean };

/** Types a document into a live Markdown field: a heading, a list, then a #artifact and an @seat picked from the picker. */
const writeDocument = async (page: Page, field: Locator, heading: string, mentions: ReadonlyArray<{ sigil: "#" | "@"; name: string }>): Promise<void> => {
  await field.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText(`# ${heading}\n\n- first point\n- second point\n\nRead `);
  for (const [index, mention] of mentions.entries()) {
    if (index > 0) await page.keyboard.insertText(" and ");
    await page.keyboard.type(`${mention.sigil}${mention.name.slice(0, 3)}`);
    await page.getByRole("option", { name: new RegExp(mention.name, "u") }).first().click({ timeout: 10_000 });
  }
  await page.keyboard.insertText(" today.");
};

test("briefings: region, app and reference texts are documents, onboard returns them unexpanded with mentions resolved", async () => {
  test.setTimeout(360_000);
  const scout = modelSeat({ id: "scout", key: "local:brief-scout", label: "Scout", harness: "codex", cwd: mkdtempSync(join(tmpdir(), "junto-brief-scout-")), x: 40, y: 80 });
  const ada = modelSeat({ id: "ada", key: "local:brief-ada", label: "Ada", harness: "codex", cwd: mkdtempSync(join(tmpdir(), "junto-brief-ada-")), x: 300, y: 80 });
  const junto = await launchJunto({
    windowContentSize: { width: 1500, height: 920 },
    seedModels: {
      [CANVAS]: modelFixture([
        modelRegion({ id: "ops", label: "Ops", x: 0, y: 0, width: 1100, height: 440 }),
        scout,
        ada,
        modelNode({ kind: "artifacts", id: "shelf", label: "Shelf", x: 560, y: 80, width: 240, height: 140, z: 0 }),
        modelNode({ kind: "artifacts", id: "bin", label: "Bin", x: 840, y: 80, width: 220, height: 140, z: 0 }),
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
    const make = async (node: string, title: string) => {
      const id = mintItemId();
      await page.evaluate(
        ({ canvas, node, id, opId, title }) => window.junto!.resource!.artifact!.apply(canvas, node, id, opId, { op: "create", title, body: { type: "document", markdown: `# ${title}` } }),
        { canvas: CANVAS, node: asNodeId(node), id, opId: mintOpId(), title },
      );
      return id;
    };
    const specId = await make("shelf", "Spec sheet");
    const oldId = await make("bin", "Obsolete plan");
    const seat = crewSeat(sandbox, CANVAS, "scout");
    await crewPlayFactory(page);
    await crewOccupySeat(page, CANVAS, scout, seat);

    // Region briefing.
    await page.getByRole("button", { name: "Fit all nodes" }).click();
    await page.waitForTimeout(500);
    await page.getByTestId("rf__node-ops").locator(".region-drag-handle").first().click();
    await page.getByRole("button", { name: "Region briefing" }).click();
    const regionDialog = page.getByRole("dialog", { name: "Briefing" });
    const region = regionDialog.getByRole("textbox", { name: "Region briefing" });
    await expect(region).toBeVisible({ timeout: 15_000 });
    await writeDocument(page, region, "Launch week", [{ sigil: "#", name: "Spec sheet" }, { sigil: "@", name: "Ada" }]);
    await page.keyboard.insertText("\n\nOld: ");
    await page.keyboard.type("#Obs");
    await page.getByRole("option", { name: /Obsolete plan/u }).first().click({ timeout: 10_000 });
    await page.waitForTimeout(400);
    await shoot(page, "1-region-briefing");
    await page.keyboard.press("Escape");
    if ((await regionDialog.count()) > 0) await page.keyboard.press("Escape");
    await expect(regionDialog).toHaveCount(0, { timeout: 5_000 });
    await page.locator(".react-flow__pane").click({ position: { x: 1300, y: 700 } });
    await page.waitForTimeout(1_500);

    // App briefing.
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.locator(".settings-nav__item", { hasText: /^Briefing$/u }).click();
    const app = page.locator('[aria-label="App briefing"]').first();
    await expect(app).toBeVisible({ timeout: 10_000 });
    await writeDocument(page, app, "House rules", [{ sigil: "#", name: "Spec sheet" }, { sigil: "@", name: "Ada" }]);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" }).first()).toBeVisible({ timeout: 10_000 });
    await shoot(page, "2-app-briefing");

    // A reference.
    await page.locator(".settings-nav__item", { hasText: /^References$/u }).click();
    await page.getByRole("button", { name: /New reference/u }).click();
    await page.getByLabel("Reference name").fill("release-notes");
    await page.getByLabel("Reference description").fill("How we write release notes");
    const reference = page.locator('[aria-label="Reference text"]').first();
    await writeDocument(page, reference, "Release notes", [{ sigil: "#", name: "Spec sheet" }, { sigil: "@", name: "Ada" }]);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("list", { name: "References" })).toContainText("release-notes", { timeout: 10_000 });
    await shoot(page, "3-reference");
    await page.locator(".settings-panel__close").click();

    // The Bin node goes: its artifact's link must list as missing.
    await commandModel(page, { _tag: "Remove", canvas: CANVAS, nodes: ["bin"], wires: [] });
    await expect(page.locator('.react-flow__node[data-id="bin"]')).toHaveCount(0, { timeout: 10_000 });

    const json = async (argv: ReadonlyArray<string>) => {
      const r = await seat.cli(argv);
      const out = (r.stdout.trim() === "" ? r.stderr : r.stdout).trim();
      return JSON.parse(out) as { ok?: boolean; data?: Record<string, unknown> };
    };
    const onboard = await json(["onboard"]);
    const data = (onboard.data ?? {}) as { briefing?: string; briefing_mentions?: ReadonlyArray<Mention>; region?: { instruction?: string; mentions?: ReadonlyArray<Mention> } | null };
    console.log("B4-ONBOARD", JSON.stringify({ briefing: data.briefing, briefing_mentions: data.briefing_mentions, region: data.region }).slice(0, 3000));
    const unexpanded = (text: string | undefined, heading: string) => {
      expect(text, "the text").toBeDefined();
      expect(text!).toContain(`# ${heading}`);
      expect(text!).toContain("- first point\n- second point");
      expect(text!).toMatch(/\]\(junto:\/\/[^)]+\)/u);
      expect(text!, "not expanded: the artifact's body is not inlined").not.toContain("# Spec sheet\n");
    };
    const resolved = (mentions: ReadonlyArray<Mention> | undefined) => {
      const art = mentions?.find((m) => m.kind === "artifact" && m.id === specId);
      const sea = mentions?.find((m) => m.kind === "seat");
      expect(art, JSON.stringify(mentions)).toBeDefined();
      expect(art!.title).toBe("Spec sheet");
      expect(art!.ref).toMatch(/^junto:\/\//u);
      expect(sea, JSON.stringify(mentions)).toBeDefined();
      expect(sea!.title ?? sea!.label).toMatch(/Ada/u);
    };
    await check("onboard: the region briefing is as written, heading and list, unexpanded", () => Promise.resolve(unexpanded(data.region?.instruction, "Launch week")));
    await check("onboard: region.mentions resolves the artifact and the seat", () => Promise.resolve(resolved(data.region?.mentions)));
    await check("onboard: a link whose node is gone lists as kind missing", () =>
      Promise.resolve(expect(data.region?.mentions?.some((m) => m.kind === "missing" && (m.id === oldId || (m.ref ?? "").includes(oldId))), JSON.stringify(data.region?.mentions)).toBe(true)),
    );
    await check("onboard: the app briefing is as written, unexpanded", () => Promise.resolve(unexpanded(data.briefing, "House rules")));
    await check("onboard: briefing_mentions resolves the artifact and the seat", () => Promise.resolve(resolved(data.briefing_mentions)));
    const read = await json(["references", "read", "release-notes"]);
    const ref = (read.data ?? {}) as { body?: string; text?: string; mentions?: ReadonlyArray<Mention> };
    console.log("B4-REFERENCE", JSON.stringify(read).slice(0, 1500));
    await check("references read: the body as written, unexpanded", () => Promise.resolve(unexpanded(ref.body ?? ref.text, "Release notes")));
    await check("references read: mentions resolve the artifact and the seat", () => Promise.resolve(resolved(ref.mentions)));
  } finally {
    console.log("B4", JSON.stringify(results));
    await junto.close();
  }
  for (const r of results) expect.soft(r.pass, `${r.row}: ${r.detail ?? ""}`).toBe(true);
});
