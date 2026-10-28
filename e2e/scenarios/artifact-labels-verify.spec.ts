/**
 * Real app, plan 0.11 03, across T2, T3 and T4: the claims product-lead asked
 * to be walked by hand, dark and bright.
 *
 * (1) Header: Add labels by keyboard only completes from the labels this node
 * already uses, folds mixed case, and a chip's Remove drops one; the picker is
 * the same combobox and listbox the mention list is. (2) Sidebar: two picked
 * labels are AND, project/junto matches project/junto/release, each toggle
 * carries its count, and the pick is kept across a close and reopen of the
 * node. (3) A seat's `junto artifact label <id> --add` shows as a chip in the
 * window, and `junto artifact list --label` agrees with the sidebar. (4) Cmd+P
 * ranks a title hit above a label hit.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/artifact-labels-verify.spec.ts
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { asNodeId, Node } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelRegion, modelSeat } from "../harness/model";

const CANVAS = "labels-verify";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/artifact-labels-verify";
const shelf = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({ kind: "artifacts", id: "shelf", label: "Shelf", x: 400, y: 60, width: 280, height: 160, z: 0 });

const shelfB = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({ kind: "artifacts", id: "shelf-b", label: "Shelf B", x: 400, y: 240, width: 280, height: 140, z: 0 });

const seed = (page: Page, title: string, labels: ReadonlyArray<string>, node = "shelf"): Promise<{ kind: string }> =>
  page.evaluate(
    ({ canvas, node, artifactId, opId, title, labels }) =>
      window.junto!.resource!.artifact!.apply(canvas, node, artifactId, opId, {
        op: "create",
        title,
        body: { type: "document", markdown: `# ${title}` },
        labels,
      }) as Promise<{ kind: string }>,
    { canvas: CANVAS, node: asNodeId(node), artifactId: mintItemId(), opId: mintOpId(), title, labels },
  );

const setTheme = async (page: Page, theme: "bright" | "dark"): Promise<void> => {
  await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
  if (theme === "bright") await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
  else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
};

const shoot = async (page: Page, name: string): Promise<void> => {
  for (const theme of ["dark", "bright"] as const) {
    mkdirSync(join(SHOTS, theme), { recursive: true });
    await setTheme(page, theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, theme, `${name}.png`) });
  }
  await setTheme(page, "dark");
};

const pick = async (page: Page, title: string): Promise<void> => {
  await page.getByRole("list", { name: "Artifacts" }).locator("button").filter({ hasText: title }).first().click();
  await expect(page.locator(".artifact-head__title")).toHaveValue(title, { timeout: 15_000 });
};

const listedTitles = async (page: Page): Promise<ReadonlyArray<string>> => {
  const titles = await page.getByRole("list", { name: "Artifacts" }).locator('[role="listitem"]').evaluateAll((items) =>
    items.map((item) => item.querySelector("span.font-medium")?.firstChild?.textContent ?? ""),
  );
  return titles.map((t) => t.trim());
};

type Listed = { readonly id?: string; readonly artifactId?: string; readonly title: string; readonly labels?: ReadonlyArray<string> };

test("artifact labels: header chips, the sidebar filter, a seat's label, Cmd+P ranking, dark and bright", async () => {
  test.setTimeout(360_000);
  const folder = mkdtempSync(join(tmpdir(), "junto-labels-seat-"));
  const scout = modelSeat({ id: "scout", key: "local:labels-scout", label: "Scout", harness: "codex", cwd: folder, x: 40, y: 60 });
  const ops = modelRegion({ id: "ops", label: "Ops", x: 0, y: 0, width: 800, height: 400 });
  const junto = await launchJunto({
    windowContentSize: { width: 1500, height: 900 },
    seedModels: { [CANVAS]: modelFixture([ops, scout, shelf, shelfB], []) },
    afterSeed: installCrewSeatHarness,
  });
  try {
    const { page, sandbox } = junto;
    await expect(page.locator('.react-flow__node[data-id="shelf"]')).toBeVisible({ timeout: 30_000 });
    const seat = crewSeat(sandbox, CANVAS, "scout");
    await crewPlayFactory(page);
    await crewOccupySeat(page, CANVAS, scout, seat);
    expect((await seat.op("onboard", {})).ok, "scout onboards").toBe(true);
    const cli = async (argv: ReadonlyArray<string>) => {
      const result = await seat.cli(argv);
      const out = result.stdout.trim() === "" ? result.stderr : result.stdout;
      if (!out.trim().startsWith("{")) throw new Error(`junto ${argv.join(" ")} exit ${String(result.exitCode)}:\n${result.stdout.slice(0, 1500)}\n${result.stderr.slice(0, 1500)}`);
      return { ...result, json: JSON.parse(out.trim() || "{}") as { ok?: boolean; data?: Record<string, unknown>; error?: unknown } };
    };

    expect((await seed(page, "Release notes", ["project/junto/release", "draft"])).kind).toBe("applied");
    expect((await seed(page, "Web brief", ["project/junto/web"])).kind).toBe("applied");
    expect((await seed(page, "Roadmap", ["project/junto", "planning"])).kind).toBe("applied");
    expect((await seed(page, "Launch plan", [])).kind).toBe("applied");
    expect((await seed(page, "Plain page", [])).kind).toBe("applied");
    expect((await seed(page, "Beta note", ["beta"], "shelf-b")).kind).toBe("applied");
    expect((await seed(page, "Gamma note", ["gamma"], "shelf-b")).kind).toBe("applied");

    const card = page.locator('.react-flow__node[data-id="shelf"]');
    await card.dblclick();
    await expect(page.getByRole("list", { name: "Artifacts" })).toBeVisible({ timeout: 20_000 });
    await setTheme(page, "dark");

    // (1) Header, keyboard only from the Add labels button.
    await pick(page, "Plain page");
    const head = page.locator(".artifact-labels");
    const trigger = head.getByRole("button", { name: "Add labels" });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const field = head.getByRole("combobox", { name: "Find or add labels" });
    await expect(field).toBeFocused();
    await page.keyboard.type("pla");
    const listbox = head.getByRole("listbox", { name: "Labels" });
    await expect(listbox.getByRole("option")).toHaveText(["Add \"pla\"", "planning"]);
    // Screen reader: the field owns the list, and the highlight moves by aria-activedescendant, as the mention list.
    await expect(field).toHaveAttribute("aria-expanded", "true");
    await expect(field).toHaveAttribute("aria-autocomplete", "both");
    const controls = await field.getAttribute("aria-controls");
    expect(await listbox.getAttribute("id")).toBe(controls);
    await page.keyboard.press("ArrowDown");
    const activeId = await field.getAttribute("aria-activedescendant");
    expect(activeId, "a highlighted option is announced").toBeTruthy();
    await expect(page.locator(`[id="${activeId!}"]`)).toHaveAttribute("role", "option");
    await shoot(page, "1a-header-picker-completes");
    // The highlight reached is committed by Enter.
    const highlighted = (await page.locator(`[id="${activeId!}"]`).textContent())?.trim();
    await page.keyboard.press("Enter");
    const chips = head.locator(".artifact-labels__chips .artifact-labels__word");
    const firstAdded = highlighted === "planning" ? "planning" : "pla";
    await expect(chips).toHaveText([firstAdded], { timeout: 10_000 });
    if (firstAdded !== "planning") {
      await page.keyboard.type("planning");
      await page.keyboard.press("Enter");
    }
    await page.keyboard.type("Mixed Case");
    await page.keyboard.press("Enter");
    await expect(head.locator(".artifact-labels__chips .artifact-labels__word")).toContainText(["mixed case"], { timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(field).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await shoot(page, "1b-header-chips-after-add");
    // Remove one by keyboard.
    await head.getByRole("button", { name: "Remove mixed case" }).focus();
    await page.keyboard.press("Enter");
    await expect(head.locator(".artifact-labels__chips .artifact-labels__word")).not.toContainText(["mixed case"], { timeout: 10_000 });
    const heldAfterRemove = await head.locator(".artifact-labels__chips .artifact-labels__word").allTextContents();
    expect(heldAfterRemove).toContain("planning");
    await shoot(page, "1c-header-after-remove");

    const listed = await cli(["artifact", "list"]);
    expect(listed.json.ok, listed.stdout.slice(0, 400)).toBe(true);
    const all = listed.json.data!.artifacts as ReadonlyArray<Listed>;
    const idOf = (title: string): string => {
      const row = all.find((a) => a.title === title);
      return (row?.artifactId ?? row?.id)!;
    };
    const plain = all.find((a) => a.title === "Plain page");
    expect(plain?.labels, "the header's write is the stored set").toEqual(heldAfterRemove.slice().sort());

    // (2) Sidebar filter.
    const filter = page.locator(".artifacts-filter__labels");
    const toggle = (label: string) => filter.locator(".artifacts-filter__label").filter({ has: page.locator(".artifacts-filter__label-word", { hasText: new RegExp(`^${label.replace(/[/]/gu, "\\/")}$`, "u") }) });
    const count = async (label: string) => (await toggle(label).locator(".artifacts-filter__label-count").textContent())?.trim();
    await expect(toggle("project/junto")).toHaveCount(1);
    expect(await count("project/junto"), "project/junto counts its level").toBe("3");
    expect(await count("draft")).toBe("1");
    await toggle("project/junto").click();
    await expect(toggle("project/junto")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => listedTitles(page)).toEqual(expect.arrayContaining(["Release notes", "Web brief", "Roadmap"]));
    expect((await listedTitles(page)).length).toBe(3);
    await shoot(page, "2a-sidebar-level");
    await toggle("draft").click();
    await expect.poll(() => listedTitles(page)).toEqual(["Release notes"]);
    await shoot(page, "2b-sidebar-and");

    // (3) T4 crossing, before the close and reopen: list --label agrees with the sidebar.
    const both = await cli(["artifact", "list", "--label", "project/junto", "--label", "draft"]);
    expect((both.json.data!.artifacts as ReadonlyArray<Listed>).map((a) => a.title)).toEqual(["Release notes"]);
    const level = await cli(["artifact", "list", "--label", "project/junto"]);
    expect((level.json.data!.artifacts as ReadonlyArray<Listed>).map((a) => a.title).sort()).toEqual(["Release notes", "Roadmap", "Web brief"]);

    // Kept per node across a close and reopen, the type filter with the labels (plan corrected, 9b15d9add).
    const typeRadio = (name: string) => page.locator(".artifacts-filter__type").filter({ hasText: new RegExp(`^${name}$`, "u") });
    await typeRadio("Document").click();
    await expect(typeRadio("Document")).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("list", { name: "Artifacts" })).toHaveCount(0, { timeout: 10_000 });
    await card.dblclick();
    await expect(page.getByRole("list", { name: "Artifacts" })).toBeVisible({ timeout: 20_000 });
    const keptPressed = await page.locator(".artifacts-filter__labels [aria-pressed=\"true\"]").allTextContents();
    const keptTitles = await listedTitles(page);
    await shoot(page, "2c-sidebar-after-reopen");
    expect(keptTitles, "the kept pick still filters the rows").toEqual(["Release notes"]);
    expect(keptPressed.length, `kept picks after reopen: ${JSON.stringify(keptPressed)}`).toBe(2);
    await expect(typeRadio("Document"), "the type filter is kept").toHaveAttribute("aria-checked", "true");

    // Two Artifacts nodes keep their own picks.
    const cardB = page.locator('.react-flow__node[data-id="shelf-b"]');
    const open = async (which: typeof card): Promise<void> => {
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("list", { name: "Artifacts" })).toHaveCount(0, { timeout: 10_000 });
      await which.dblclick();
      await expect(page.getByRole("list", { name: "Artifacts" })).toBeVisible({ timeout: 20_000 });
    };
    const pressed = () => page.locator('.artifacts-filter__labels [aria-pressed="true"] .artifacts-filter__label-word').allTextContents();
    await open(cardB);
    await expect.poll(() => listedTitles(page)).toEqual(expect.arrayContaining(["Beta note", "Gamma note"]));
    expect(await pressed(), "Shelf B starts with none picked").toEqual([]);
    await expect(typeRadio("All"), "Shelf B starts on All").toHaveAttribute("aria-checked", "true");
    await toggle("beta").click();
    await expect.poll(() => listedTitles(page)).toEqual(["Beta note"]);
    await open(card);
    await expect.poll(pressed, "Shelf keeps its own picks").toEqual(["draft", "project/junto"]);
    await expect(typeRadio("Document")).toHaveAttribute("aria-checked", "true");
    expect(await listedTitles(page)).toEqual(["Release notes"]);
    await open(cardB);
    await expect.poll(pressed, "Shelf B keeps beta").toEqual(["beta"]);
    expect(await listedTitles(page)).toEqual(["Beta note"]);
    await shoot(page, "2d-second-node-own-picks");
    await filter.getByRole("button", { name: "Clear" }).click();
    await open(card);

    await filter.getByRole("button", { name: "Clear" }).click();
    await typeRadio("All").click();

    // A seat adds a label: the chip appears in the window.
    const webId = idOf("Web brief");
    const added = await cli(["artifact", "label", webId, "--add", "x"]);
    expect(added.json.ok, `${added.stdout.slice(0, 400)} ${added.stderr.slice(0, 400)}`).toBe(true);
    await pick(page, "Web brief");
    await expect(page.locator(".artifact-labels__chips .artifact-labels__word")).toHaveText(["project/junto/web", "x"], { timeout: 20_000 });
    await shoot(page, "3-seat-label-chip");
    const xs = await cli(["artifact", "list", "--label", "x"]);
    expect((xs.json.data!.artifacts as ReadonlyArray<Listed>).map((a) => a.title)).toEqual(["Web brief"]);
    expect(await count("x")).toBe("1");

    // (5) Colours (03, Colours): a colour is the label's in its node, set by keyboard from the header chip,
    // by pointer from the sidebar swatch and by a seat's `junto artifact colour`; nothing inherits; it outlives the label.
    const headChip = (label: string) => page.locator(".artifact-labels__chips .artifact-labels__chip").filter({ has: page.locator(".artifact-labels__word", { hasText: new RegExp(`^${label.replace(/[/]/gu, "\\/")}$`, "u") }) });
    const pair = (label: string) => filter.locator(".artifacts-filter__label-pair").filter({ has: page.locator(".artifacts-filter__label-word", { hasText: new RegExp(`^${label.replace(/[/]/gu, "\\/")}$`, "u") }) });
    await pick(page, "Roadmap");
    await page.getByRole("button", { name: "planning, no colour", exact: true }).focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "Colour for planning" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitemradio")).toHaveText(["No colour", "Red", "Orange", "Yellow", "Green", "Teal", "Blue", "Purple", "Pink"]);
    await shoot(page, "5a-colour-menu");
    // As the label picker puts focus in its field, the menu should put it on its checked item; on 74592b630 it rests
    // on the popover, where arrows do nothing, and a Tab reaches the items.
    const focusedRole = () => page.evaluate(() => document.activeElement?.getAttribute("role"));
    expect.soft(await focusedRole(), "the keyboard-opened menu focuses an item").toBe("menuitemradio");
    if ((await focusedRole()) !== "menuitemradio") await page.keyboard.press("Tab");
    for (let step = 0; step < 12; step++) {
      if ((await page.evaluate(() => document.activeElement?.textContent?.trim())) === "Teal") break;
      await page.keyboard.press("ArrowDown");
    }
    await page.keyboard.press("Enter");
    await expect(headChip("planning")).toHaveAttribute("data-label-colour", "teal", { timeout: 10_000 });
    await expect(pair("planning")).toHaveAttribute("data-label-colour", "teal");
    await expect(headChip("project/junto")).not.toHaveAttribute("data-label-colour", /./u);
    // The same label on another artifact repaints.
    await pick(page, "Plain page");
    await expect(headChip("planning")).toHaveAttribute("data-label-colour", "teal", { timeout: 10_000 });
    // The sidebar swatch, by pointer.
    await filter.getByRole("button", { name: "Colour for draft, no colour", exact: true }).click();
    await page.getByRole("menu", { name: "Colour for draft" }).getByRole("menuitemradio", { name: "Red" }).click();
    await expect(pair("draft")).toHaveAttribute("data-label-colour", "red", { timeout: 10_000 });
    // A seat colours a level: its children keep their own (none).
    const purple = await cli(["artifact", "colour", "project/junto", "purple", "--node", "shelf"]);
    expect(purple.json.ok, `${purple.stdout.slice(0, 400)} ${purple.stderr.slice(0, 400)}`).toBe(true);
    await expect(pair("project/junto")).toHaveAttribute("data-label-colour", "purple", { timeout: 20_000 });
    await expect(pair("project/junto/release")).not.toHaveAttribute("data-label-colour", /./u);
    await pick(page, "Roadmap");
    await expect(headChip("project/junto")).toHaveAttribute("data-label-colour", "purple");
    await expect(headChip("planning")).toHaveAttribute("data-label-colour", "teal");
    await toggle("planning").click();
    await shoot(page, "5b-colours-header-and-sidebar");
    await filter.getByRole("button", { name: "Clear" }).click();
    const coloured = await cli(["artifact", "list", "--label", "planning"]);
    expect(JSON.stringify(coloured.json.data), "list names the colours").toContain("teal");
    // A colour outlives its last carrier: x goes green, is removed, comes back green.
    expect((await cli(["artifact", "colour", "x", "green", "--node", "shelf"])).json.ok).toBe(true);
    expect((await cli(["artifact", "label", webId, "--remove", "x"])).json.ok).toBe(true);
    await expect(toggle("x")).toHaveCount(0, { timeout: 20_000 });
    expect((await cli(["artifact", "label", webId, "--add", "x"])).json.ok).toBe(true);
    await pick(page, "Web brief");
    await expect(headChip("x")).toHaveAttribute("data-label-colour", "green", { timeout: 20_000 });
    // Another node's labels take none of these.
    await open(cardB);
    await expect(pair("beta")).not.toHaveAttribute("data-label-colour", /./u);
    await open(card);

    // (4) Cmd+P: a title hit above a label hit.
    const palette = page.getByTestId("quick-open");
    await page.keyboard.press("Meta+p");
    await expect(palette).toBeVisible();
    await page.getByTestId("quick-open-input").fill("plan");
    const titles = palette.locator(".quick-open__row-title");
    await expect(titles.first()).toHaveText("Launch plan");
    const ranked = await titles.allTextContents();
    expect(ranked).toEqual(expect.arrayContaining(["Launch plan", "Roadmap"]));
    expect(ranked.indexOf("Launch plan")).toBeLessThan(ranked.indexOf("Roadmap"));
    await shoot(page, "4-cmdp-title-over-label");
    console.log(JSON.stringify({ kept: { pressed: keptPressed, rows: keptTitles }, ranked, plainLabels: plain?.labels }));
  } finally {
    await junto.close();
  }
});
