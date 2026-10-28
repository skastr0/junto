/**
 * Real app, plan 0.11 05, B1 (artifacts in automations, contract ee3ca9cb7),
 * the walk product-automations asked for, dark and bright.
 *
 * The sentence: "When an artifact labelled publish in Specs is edited"; a
 * typed label nothing carries shows a note listing the labels there; "is
 * labelled" moves the label after the event. The actions: Append to the
 * artifact that fired ("## {{fired.at}}"), Label it shipped, Create an
 * artifact. End to end: an artifact labelled publish is edited, the append
 * lands at its end under a dated heading, it gains shipped, the new artifact
 * is made. Each check is reported on its own.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/automations-b1-verify.spec.ts
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { asNodeId } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelNode, modelSeat } from "../harness/model";

const CANVAS = "automations-b1";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/automations-b1-verify";

const shoot = async (page: Page, name: string): Promise<void> => {
  for (const theme of ["dark", "bright"] as const) {
    mkdirSync(join(SHOTS, theme), { recursive: true });
    await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, theme, `${name}.png`) });
  }
  await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
};

/** A design-system Select: open its trigger by name, pick the option. */
const choose = async (page: Page, scope: Locator, label: string | RegExp, option: string | RegExp): Promise<void> => {
  await scope.getByRole("button", { name: label, exact: typeof label === "string" ? true : undefined }).click();
  await page.getByRole("option", { name: option, exact: typeof option === "string" ? true : undefined }).first().click();
};

type Result = { row: string; pass: boolean; detail?: string };
type Head = { artifact: { title: string; version: number; labels: ReadonlyArray<string> }; body: { type: string; markdown?: string } | null };

test("automations B1: the label watch reads as a sentence, and an edit appends, labels and creates", async () => {
  test.setTimeout(300_000);
  const lead = modelSeat({ id: "lead", key: "local:b1-lead", label: "lead", harness: "codex", cwd: mkdtempSync(join(tmpdir(), "junto-b1-seat-")), x: 40, y: 220 });
  const junto = await launchJunto({
    windowContentSize: { width: 1500, height: 900 },
    seedModels: {
      [CANVAS]: modelFixture([
        modelNode({ kind: "automations", id: "auto", label: "Automations", x: 40, y: 40, width: 260, height: 120, z: 0 }),
        modelNode({ kind: "artifacts", id: "specs", label: "Specs", x: 360, y: 40, width: 260, height: 140, z: 0 }),
        lead,
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
      results.push({ row, pass: false, detail: String(error).replace(/\u001b\[[0-9;]*m/gu, "").split("\n").slice(0, 4).join(" ") });
    }
  };
  try {
    const { page } = junto;
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await expect(page.locator('.react-flow__node[data-id="auto"]')).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);
    await crewOccupySeat(page, CANVAS, lead, crewSeat(junto.sandbox, CANVAS, "lead"));
    const specs = asNodeId("specs");
    const apply = (artifactId: ReturnType<typeof mintItemId>, op: unknown) =>
      page.evaluate(
        ({ canvas, node, artifactId, opId, op }) => window.junto!.resource!.artifact!.apply(canvas, node, artifactId, opId, op as never),
        { canvas: CANVAS, node: specs, artifactId, opId: mintOpId(), op },
      ) as Promise<{ kind: string }>;
    const heads = () => page.evaluate(({ canvas, node }) => window.junto!.resource!.artifact!.list(canvas, node), { canvas: CANVAS, node: specs }) as Promise<ReadonlyArray<Head>>;
    const head = async (title: string) => (await heads()).find((h) => h.artifact.title === title);

    const wire = mintItemId();
    expect((await apply(wire, { op: "create", title: "Wire spec", body: { type: "document", markdown: "# Wire spec" } })).kind).toBe("applied");
    expect((await apply(wire, { op: "labels", labels: ["publish"] })).kind).toBe("applied");
    expect((await apply(mintItemId(), { op: "create", title: "Old note", body: { type: "document", markdown: "# Old note" }, labels: ["draft"] })).kind).toBe("applied");

    await page.locator('.react-flow__node[data-id="auto"]').dblclick();
    const pane = page.getByTestId("automations-node");
    await expect(pane).toBeVisible({ timeout: 20_000 });
    const editor = pane.getByTestId("automation-editor");
    const trigger = editor.getByRole("region", { name: "Trigger" });
    const sentence = trigger.locator(".automation-editor__sentence");
    await pane.getByRole("button", { name: "New automation" }).first().click();
    await editor.getByLabel("Automation name").fill("Publish edit");
    const on = editor.getByRole("switch", { name: "Automation on" });
    if ((await on.getAttribute("aria-checked")) !== "true") await on.click();
    await choose(page, editor, "Trigger", "When something changes");
    await choose(page, trigger, "What it watches", "an artifact");

    // The sentence, the note for a label nothing carries, then publish.
    const only = trigger.getByLabel("Only with this label, optional");
    await only.fill("nope");
    const note = editor.locator(".automation-editor__note").filter({ hasText: /carries/u });
    await check("note for a label nothing carries lists the labels there", async () => {
      await expect(note).toBeVisible({ timeout: 5_000 });
      await expect(note).toContainText("draft");
      await expect(note).toContainText("publish");
    });
    await shoot(page, "1-label-nothing-carries");
    await only.fill("publish");
    await check("note goes once the label is carried", () => expect(note).toHaveCount(0, { timeout: 5_000 }));
    await check("sentence: When an artifact labelled publish in Specs is edited", async () => {
      await expect(sentence.first()).toContainText(/When\s*an artifact\s*labelled/u);
      await expect(trigger.getByRole("button", { name: /^(Which artifacts|Watch scope)$/u })).toContainText("Specs");
      await expect(trigger.getByRole("button", { name: "Is", exact: true })).toContainText("edited");
    });
    await shoot(page, "2-labelled-publish-is-edited");

    // "is labelled": the label field moves after the event.
    await choose(page, trigger, "Is", "labelled");
    await check("is labelled: the label moves after the event", async () => {
      await expect(trigger.getByLabel("Only with this label, optional")).toHaveCount(0);
      const gains = trigger.getByLabel("The label it gains, or any");
      await expect(gains).toHaveValue("publish");
      const order = await sentence.first().evaluate((el) => {
        const is = el.querySelector('[aria-label="Is"]');
        const field = el.querySelector('[aria-label="The label it gains, or any"]');
        return is !== null && field !== null && (is.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      });
      expect(order, "the label field follows the event").toBe(true);
    });
    await shoot(page, "3-is-labelled-publish");
    await choose(page, trigger, "Is", "edited");

    // Then: append to the artifact that fired, label it shipped, create an artifact.
    const action = (n: number) => editor.getByRole("group", { name: `Action ${String(n)}` });
    await choose(page, action(1), "Action 1", "Append to an artifact");
    await check("append offers the artifact that fired", () => choose(page, action(1), "Append to", "the artifact that fired"));
    await action(1).getByRole("textbox", { name: "Text to append", exact: true }).fill("## {{fired.at}}\nPublished edit seen.");
    await editor.getByRole("button", { name: "Action", exact: true }).click();
    await choose(page, action(2), "Action 2", "Label an artifact");
    await choose(page, action(2), "Which artifact", "the artifact that fired");
    await action(2).getByLabel("Labels to add").fill("shipped");
    await editor.getByRole("button", { name: "Action", exact: true }).click();
    await choose(page, action(3), "Action 3", "Create an artifact");
    await choose(page, action(3), "Artifacts node", /Specs/u);
    await action(3).getByRole("textbox", { name: "Artifact title", exact: true }).fill("Edit log");
    await action(3).getByLabel("Labels, optional").fill("log");
    await shoot(page, "4-actions");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await check("saves with no problem", () => expect(pane.getByRole("button", { name: /^Publish edit/u }).first()).toBeVisible({ timeout: 10_000 }));
    await shoot(page, "5-saved");

    // Control: the same watch with no label, one Create action.
    await pane.getByRole("button", { name: "New automation" }).first().click();
    await editor.getByLabel("Automation name").fill("Any edit");
    if ((await on.getAttribute("aria-checked")) !== "true") await on.click();
    await choose(page, editor, "Trigger", "When something changes");
    await choose(page, trigger, "What it watches", "an artifact");
    await choose(page, action(1), "Action 1", "Create an artifact");
    await choose(page, action(1), "Artifacts node", /Specs/u);
    await action(1).getByRole("textbox", { name: "Artifact title", exact: true }).fill("Any edit seen");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(pane.getByRole("button", { name: /^Any edit/u }).first()).toBeVisible({ timeout: 10_000 });

    // End to end: edit Wire spec, after the app has idled with the automations saved.
    await page.waitForTimeout(8_000);
    const before = (await head("Wire spec"))!;
    const edited = await apply(wire, { op: "edit", edit: { kind: "replace", baseVersion: before.artifact.version, body: { type: "document", markdown: "# Wire spec\n\nFirst draft." } } });
    expect(edited.kind, JSON.stringify(edited)).toBe("applied");
    await check("the append lands at the end under a dated heading", async () => {
      await expect.poll(async () => (await head("Wire spec"))?.body?.markdown ?? "", { timeout: 30_000 }).toContain("Published edit seen.");
      const md = (await head("Wire spec"))!.body!.markdown!;
      expect(md.trimEnd().endsWith("Published edit seen."), md).toBe(true);
      expect(md, "dated heading").toMatch(/\n## \S*\d{4}\S*[^\n]*\nPublished edit seen\.\s*$/u);
      expect(md.indexOf("First draft."), "after the edit's own text").toBeLessThan(md.indexOf("Published edit seen."));
    });
    await check("the label action adds shipped", () =>
      expect.poll(async () => (await head("Wire spec"))?.artifact.labels ?? [], { timeout: 30_000 }).toEqual(expect.arrayContaining(["publish", "shipped"])),
    );
    await check("the create action makes Edit log labelled log", () =>
      expect.poll(async () => (await head("Edit log"))?.artifact.labels ?? null, { timeout: 30_000 }).toEqual(["log"]),
    );
    await page.waitForTimeout(5_000);
    // A second edit, past the one-minute quiet time: a baseline would have taken only the first.
    if (!(((await head("Wire spec"))?.body?.markdown ?? "").includes("Published edit seen."))) {
      await page.waitForTimeout(40_000);
      const now = (await head("Wire spec"))!;
      await apply(wire, { op: "edit", edit: { kind: "replace", baseVersion: now.artifact.version, body: { type: "document", markdown: "# Wire spec\n\nSecond draft." } } });
      await check("a second edit fires", () =>
        expect.poll(async () => (await head("Wire spec"))?.body?.markdown ?? "", { timeout: 30_000 }).toContain("Published edit seen."),
      );
    }
    const md = (await head("Wire spec"))?.body?.markdown ?? "";
    const appends = md.split("Published edit seen.").length - 1;
    const logs = (await heads()).filter((h) => h.artifact.title === "Edit log").length;
    await check("control: an unlabelled edit watch fires", () => expect(head("Any edit seen")).resolves.toBeDefined());
    await check("one edit fires once (its own append does not refire it)", () => {
      expect(appends, md).toBe(1);
      expect(logs).toBe(1);
    });
    console.log("B1MD", JSON.stringify(md));
    const listed = await page.evaluate((canvas) => window.junto!.automationList(canvas, { nodeId: "auto" as never }), CANVAS);
    console.log("B1LIST", JSON.stringify(listed).slice(0, 3000));
    for (const a of (listed as { automations: ReadonlyArray<{ automationId: string }> }).automations)
      console.log("B1FIRINGS", JSON.stringify(await page.evaluate(({ canvas, id }) => window.junto!.automationFirings(canvas, { automationId: id as never }), { canvas: CANVAS, id: a.automationId })).slice(0, 2000));
    await page.keyboard.press("Escape");
    await page.locator('.react-flow__node[data-id="specs"]').dblclick();
    await expect(page.getByRole("list", { name: "Artifacts" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("list", { name: "Artifacts" }).locator("button").filter({ hasText: "Wire spec" }).first().click();
    await page.waitForTimeout(800);
    await shoot(page, "6-wire-spec-after");
  } finally {
    console.log("B1", JSON.stringify(results));
    await junto.close();
  }
  for (const r of results) expect.soft(r.pass, `${r.row}: ${r.detail ?? ""}`).toBe(true);
});
