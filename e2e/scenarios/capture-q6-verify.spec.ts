/**
 * Real app, plan 0.11 11 Q6, the quick capture walk, dark and bright.
 *
 * With no Inbox set, Cmd+T asks once and Make an Inbox works. Cmd+T from the
 * canvas, from a terminal and over a dialog puts the caret in a new document
 * and the first keystroke lands. Three lines are written and closed; the
 * capture is first in the Inbox, titled from line one. It switches to a sheet
 * and back, and routes through Move to on a suggestion. Its suggested node
 * has a long name: the name ellipsises on line one beside its place and the
 * reason is whole on line two (d422d3b24, f4e46ece7). A second capture routes
 * by M on its Inbox row. An old artifact is searched, previewed, edited in
 * place by Enter and opened in its node by Cmd+Enter. The top bar button
 * opens the same surface. Each check is reported on its own.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/capture-q6-verify.spec.ts
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { asNodeId } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelNode, modelTerminal } from "../harness/model";

const CANVAS = "capture-q6";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/capture-q6-verify";
const LONG = "Research and design notes for the quarterly roadmap and pricing review";
const BINDING = "local:capture-q6";

const shoot = async (page: Page, name: string): Promise<void> => {
  for (const theme of ["dark", "bright"] as const) {
    mkdirSync(join(SHOTS, theme), { recursive: true });
    await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, theme, `${name}.png`) });
  }
  await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
};

const surface = (page: Page): Locator => page.getByRole("dialog", { name: "Quick capture" });
const search = (page: Page): Locator => page.getByLabel("Search every artifact", { exact: true });
const entry = (page: Page): Locator => page.locator("[data-capture-entry] .cm-content").first();
const rows = (page: Page): Locator => page.locator(".quick-capture__row");
const askHeading = (page: Page): Locator => page.getByRole("heading", { name: "Where do captures go?", exact: true });

type Result = { row: string; pass: boolean; detail?: string };
type Head = { artifact: { artifactId: string; title: string; nodeId: string; archived?: boolean }; body: { type: string; markdown?: string } | null };

test("quick capture Q6: ask once, Cmd+T anywhere writes at once, Inbox first, type switch, routing by Move to and M, search and edit in place, the top bar button", async () => {
  test.setTimeout(600_000);
  const junto = await launchJunto({
    windowContentSize: { width: 1500, height: 900 },
    seedModels: {
      [CANVAS]: modelFixture([
        modelNode({ kind: "artifacts", id: "research", label: LONG, x: 60, y: 60, width: 300, height: 160, z: 0 }),
        modelNode({ kind: "artifacts", id: "errands", label: "Errands", x: 400, y: 60, width: 260, height: 160, z: 0 }),
        modelTerminal({ id: "term", bindingId: BINDING, label: "Shell", x: 720, y: 60 }),
      ]),
    },
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
    const { page } = junto;
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await expect(page.locator('.react-flow__node[data-id="research"]')).toBeVisible({ timeout: 30_000 });
    const create = (node: string, title: string, markdown: string) =>
      page.evaluate(
        ({ canvas, node, artifactId, opId, title, markdown }) =>
          window.junto!.resource!.artifact!.apply(canvas, node, artifactId as never, opId, { op: "create", title, body: { type: "document", markdown }, labels: [] }),
        { canvas: CANVAS, node: asNodeId(node), artifactId: mintItemId(), opId: mintOpId(), title, markdown },
      );
    const list = (node: string): Promise<ReadonlyArray<Head>> =>
      page.evaluate(({ canvas, node }) => window.junto!.resource!.artifact!.list(canvas, node) as never, { canvas: CANVAS, node: asNodeId(node) });
    // The old artifacts the captures will look like.
    await create("research", "Roadmap pricing tiers", "# Roadmap pricing tiers\n\nQuarterly roadmap pricing tiers for the launch review.");
    await create("errands", "Errands for the week", "# Errands for the week\n\nMilk, eggs, bread and the shopping errands before Friday.");
    // One Escape closes the surface, the writing saved (237d89c8e). A miss is recorded, and Cmd+T closes it so the walk goes on.
    const close = async (where: string): Promise<void> => {
      await page.keyboard.press("Escape");
      await check(`${where}: one Escape closes the surface`, () => expect(surface(page)).toBeHidden({ timeout: 3_000 }));
      if (await surface(page).isVisible()) await page.keyboard.press("Meta+t");
      await expect(surface(page)).toBeHidden({ timeout: 5_000 });
    };

    // With no Inbox, the first Cmd+T asks once, and Make an Inbox works.
    await page.locator(".react-flow__pane").click({ position: { x: 1200, y: 700 } });
    await page.keyboard.press("Meta+t");
    await check("no Inbox: the first Cmd+T asks where captures go", () => expect(askHeading(page)).toBeVisible({ timeout: 10_000 }));
    await shoot(page, "01-ask");
    await check("Make an Inbox makes one and opens the editor with the caret in it", async () => {
      await surface(page).getByRole("button", { name: "Make an Inbox", exact: true }).click();
      await expect(page.locator(".react-flow__node").filter({ has: page.getByText("Inbox", { exact: true }) })).toHaveCount(1, { timeout: 15_000 });
      await expect(entry(page)).toBeFocused({ timeout: 10_000 });
    });
    const inboxId = await page.locator(".react-flow__node").filter({ has: page.getByText("Inbox", { exact: true }) }).first().getAttribute("data-id");

    // Three lines, written at once; the first keystroke lands.
    await page.keyboard.type("R");
    await check("from the canvas, the first keystroke lands", () => expect(entry(page)).toContainText("R", { timeout: 5_000 }));
    await page.keyboard.type("oadmap pricing notes");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Quarterly roadmap pricing tiers for launch.");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Ask about the review.");
    await check("three lines are in the editor", () => expect(entry(page)).toContainText("Ask about the review.", { timeout: 5_000 }));
    await shoot(page, "02-three-lines");
    await page.waitForTimeout(2500);
    await check("after a rest, the header title is line one", () => expect(page.locator(".capture-editor .artifact-head__title")).toHaveValue("Roadmap pricing notes", { timeout: 5_000 }));
    await shoot(page, "02a-title-after-rest");
    await close("from the editor");
    await check("the capture is saved in the Inbox, titled from line one, all three lines kept", async () => {
      await expect.poll(async () => (await list(inboxId!)).length, { timeout: 10_000 }).toBeGreaterThan(0);
      console.log("Q6-INBOX", JSON.stringify((await list(inboxId!)).map((h) => [h.artifact.title, h.body?.markdown])));
      await expect.poll(async () => (await list(inboxId!)).map((h) => h.artifact.title), { timeout: 10_000 }).toContain("Roadmap pricing notes");
      const head = (await list(inboxId!)).find((h) => h.artifact.title === "Roadmap pricing notes");
      expect(head?.body?.markdown ?? "").toContain("Ask about the review.");
    });

    // Later steps name the capture by the title it was saved with, so one title miss does not fail them all.
    const saved = (await list(inboxId!))[0]?.artifact.title ?? "Roadmap pricing notes";
    console.log("Q6-SAVED-TITLE", saved);

    // Reopened: it is first in the Inbox.
    await page.keyboard.press("Meta+t");
    await expect(surface(page)).toBeVisible({ timeout: 10_000 });
    await check("Cmd+T again: a new document with the caret in it, no second ask", async () => {
      await expect(askHeading(page)).toHaveCount(0);
      await expect(entry(page)).toBeFocused({ timeout: 10_000 });
    });
    await check("the list reads Inbox, then recent, the capture first", async () => {
      await expect(page.locator(".quick-capture__list-label")).toHaveText("Inbox, then recent");
      await expect(rows(page).first().locator(".quick-capture__row-title")).toHaveText(saved, { timeout: 10_000 });
    });
    await shoot(page, "03-inbox-first");

    // Switch to a sheet and back.
    await rows(page).first().click();
    const title = page.locator(".capture-editor .artifact-head__title");
    await check("the row opens the capture in the editor", () => expect(title).toHaveValue(saved, { timeout: 10_000 }));
    const typeSelect = page.getByRole("combobox", { name: /^Type(,|$)/u }).or(page.getByRole("button", { name: /^Type(,|$)/u })).first();
    await check("Type switches it to a sheet, each line a row", async () => {
      await typeSelect.click();
      await page.getByRole("option", { name: "Sheet", exact: true }).click();
      await expect(page.getByRole("button", { name: "Back to document" })).toBeVisible({ timeout: 10_000 });
      const cells = page.locator(".capture-editor input, .capture-editor textarea, .capture-editor [role='gridcell']");
      await expect.poll(async () => (await cells.evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value ?? el.textContent))).join("|"), { timeout: 10_000 }).toContain("Ask about the review.");
    });
    await shoot(page, "04-as-sheet");
    await check("Back to document puts the document back", async () => {
      await page.getByRole("button", { name: "Back to document" }).click();
      await expect(entry(page)).toContainText("Ask about the review.", { timeout: 10_000 });
      await expect(page.getByRole("button", { name: "Back to document" })).toHaveCount(0);
    });

    // Route it through Move to, on its suggestion: a long name.
    await page.getByRole("button", { name: "Move to…" }).click();
    const dialog = page.getByRole("dialog", { name: `Move ${saved}` });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    const suggested = dialog.locator(".artifact-move__target--suggested").first();
    await check("Move to suggests the long-named node first, for its like artifacts", async () => {
      await expect(suggested.locator(".artifact-move__name")).toHaveText(LONG, { timeout: 10_000 });
      await expect(suggested.locator(".artifact-move__why")).toHaveText(/^Suggested: /u);
    });
    const geometry = async () =>
      suggested.evaluate((el) => {
        const box = (sel: string) => {
          const one = el.querySelector<HTMLElement>(sel)!;
          const r = one.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, scroll: one.scrollWidth, client: one.clientWidth, text: one.textContent, overflow: getComputedStyle(one).textOverflow };
        };
        return { name: box(".artifact-move__name"), place: box(".artifact-move__place"), why: box(".artifact-move__why") };
      });
    for (const theme of ["dark", "bright"] as const) {
      await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
      await page.waitForTimeout(300);
      const g = await geometry();
      console.log(`Q6-SUGGESTED-${theme}`, JSON.stringify(g));
      await check(`${theme}: the long name ellipsises on line one, beside its place`, () => {
        expect(g.name.scroll, "the name is cut").toBeGreaterThan(g.name.client);
        expect(g.name.overflow).toBe("ellipsis");
        expect(Math.abs(g.name.top - g.place.top), "name and place share line one").toBeLessThan(4);
        expect(g.name.right, "the name ends before the place").toBeLessThanOrEqual(g.place.left + 1);
      });
      await check(`${theme}: the reason is whole on line two`, () => {
        expect(g.why.top, "below the name").toBeGreaterThanOrEqual(g.name.bottom - 1);
        expect(g.why.scroll, "not cut").toBeLessThanOrEqual(g.why.client);
      });
      // 2bf6db1f4: a row takes the list's width, so nothing scrolls sideways and every place reads whole.
      const fit = await dialog.locator('[role="listbox"]').first().evaluate((list) => {
        const box = list.getBoundingClientRect();
        return {
          list: { left: box.left, right: box.right, scroll: list.scrollWidth, client: list.clientWidth },
          rows: [...list.querySelectorAll<HTMLElement>(".artifact-move__target")].map((row) => {
            const place = row.querySelector<HTMLElement>(".artifact-move__place")!;
            return { name: row.querySelector(".artifact-move__name")?.textContent, right: row.getBoundingClientRect().right, place: place.textContent, scroll: place.scrollWidth, client: place.clientWidth };
          }),
        };
      });
      console.log(`Q6-FIT-${theme}`, JSON.stringify(fit));
      await check(`${theme}: every Move to row ends within the list, and the list does not scroll sideways`, () => {
        expect(fit.list.scroll, "no sideways scroll").toBeLessThanOrEqual(fit.list.client);
        for (const one of fit.rows) expect(one.right, `${one.name ?? ""} ends inside the list`).toBeLessThanOrEqual(fit.list.right + 0.5);
      });
      const tall = await dialog.evaluate((box) => {
        const list = box.querySelector<HTMLElement>('[role="listbox"]')!;
        const within = list.getBoundingClientRect();
        const frame = box.getBoundingClientRect();
        return {
          list: { top: within.top, bottom: within.bottom, scroll: list.scrollHeight, client: list.clientHeight },
          frame: { bottom: frame.bottom },
          rows: [...list.querySelectorAll<HTMLElement>(".artifact-move__target")].map((row) => ({ name: row.querySelector(".artifact-move__name")?.textContent, bottom: row.getBoundingClientRect().bottom, height: row.getBoundingClientRect().height })),
        };
      });
      console.log(`Q6-TALL-${theme}`, JSON.stringify(tall));
      await check(`${theme}: the long-named row does not run off the bottom of the list or the dialog`, () => {
        expect(tall.list.bottom, "the list inside the dialog").toBeLessThanOrEqual(tall.frame.bottom);
        expect(tall.list.scroll, "two rows need no vertical scroll").toBeLessThanOrEqual(tall.list.client + 1);
        for (const one of tall.rows) expect(one.bottom, `${one.name ?? ""} ends inside the list`).toBeLessThanOrEqual(tall.list.bottom + 0.5);
      });
      await check(`${theme}: No region reads whole on the suggested row and on Errands`, () => {
        expect(fit.rows.length).toBeGreaterThanOrEqual(2);
        for (const one of fit.rows) {
          expect(one.place).toBe("No region");
          expect(one.scroll, `${one.name ?? ""}'s place is not cut`).toBeLessThanOrEqual(one.client);
        }
      });
      mkdirSync(join(SHOTS, theme), { recursive: true });
      await page.screenshot({ path: join(SHOTS, theme, "05-move-to-suggested.png") });
      await dialog.screenshot({ path: join(SHOTS, theme, "05a-move-dialog.png") });
    }
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await check("routing by the suggestion moves it out of the Inbox into the long-named node", async () => {
      await suggested.click();
      await page.keyboard.press("Enter");
      await expect(dialog).toBeHidden({ timeout: 10_000 });
      await expect.poll(async () => (await list("research")).map((h) => h.artifact.title), { timeout: 10_000 }).toContain(saved);
      // The type switch leaves its sheet archived in the Inbox; only the live capture moves.
      expect((await list(inboxId!)).filter((h) => h.artifact.archived !== true).map((h) => h.artifact.title)).not.toContain(saved);
    });
    await shoot(page, "06-moved");

    // A second capture, routed by M on its Inbox row.
    await page.keyboard.press("Meta+n");
    await check("Cmd+N starts another capture with the caret in it", () => expect(entry(page)).toBeFocused({ timeout: 10_000 }));
    await page.keyboard.type("Shopping errands");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Milk, eggs and bread before Friday.");
    await page.waitForTimeout(1500);
    await page.keyboard.press("Meta+l");
    await check("Cmd+L moves to the search field", () => expect(search(page)).toBeFocused({ timeout: 5_000 }));
    const second = (await list(inboxId!))[0]?.artifact.title ?? "Shopping errands";
    console.log("Q6-SECOND-TITLE", second);
    await check("the second capture is first in the Inbox", () => expect(rows(page).first().locator(".quick-capture__row-title")).toHaveText(second, { timeout: 10_000 }));
    // M is the list's own key: Tab steps from the search field into the list.
    await page.keyboard.press("Tab");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("m");
    const mDialog = page.getByRole("dialog", { name: `Move ${second}` });
    await check("M on the Inbox row opens Move to with a suggestion", async () => {
      await expect(mDialog).toBeVisible({ timeout: 5_000 });
      await expect(mDialog.locator(".artifact-move__target--suggested").first().locator(".artifact-move__name")).toHaveText("Errands");
    });
    await shoot(page, "07-m-on-row");
    if (await mDialog.isVisible()) {
      await check("M routes it to Errands", async () => {
        await mDialog.locator(".artifact-move__target--suggested").first().click();
        await page.keyboard.press("Enter");
        await expect.poll(async () => (await list("errands")).map((h) => h.artifact.title), { timeout: 10_000 }).toContain(second);
      });
    }
    if ((await search(page).inputValue()) !== "") await search(page).fill("");

    // An old artifact: search, preview, Enter edits it in place, Cmd+Enter opens it in its node.
    await search(page).click();
    await search(page).fill("Errands for the week");
    await check("search finds the old artifact", () => expect(rows(page).first().locator(".quick-capture__row-title")).toHaveText("Errands for the week", { timeout: 10_000 }));
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    await check("the arrows preview it large on the right, its words rendered", () => expect(page.locator(".quick-capture__preview-doc")).toContainText("Milk, eggs, bread", { timeout: 5_000 }));
    await shoot(page, "08-search-preview");
    await page.keyboard.press("Enter");
    await check("Enter edits it in place, in the surface", async () => {
      await expect(title).toHaveValue("Errands for the week", { timeout: 10_000 });
      await entry(page).click();
      await page.keyboard.press("Meta+ArrowDown");
      await page.keyboard.type(" Also stamps.");
      await expect.poll(async () => (await list("errands")).find((h) => h.artifact.title === "Errands for the week")?.body?.markdown ?? "", { timeout: 15_000 }).toContain("Also stamps.");
    });
    await shoot(page, "09-edit-in-place");
    await search(page).click();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Meta+Enter");
    await check("Cmd+Enter opens it in its own node", async () => {
      await expect(surface(page)).toBeHidden({ timeout: 5_000 });
      await expect(page.locator('.react-flow__node[data-id="errands"]')).toHaveClass(/selected/u, { timeout: 5_000 });
    });
    await shoot(page, "10-opened-in-node");
    if (await surface(page).isVisible()) await close("after Cmd+Enter");

    // From a terminal.
    await page.locator('.react-flow__node[data-id="term"]').dblclick();
    const term = page.locator(".workbench-pane:not(.workbench-pane--parked) .native-terminal-surface");
    await expect(term).toBeVisible({ timeout: 30_000 });
    await term.click();
    await page.waitForTimeout(500);
    await page.keyboard.press("Meta+t");
    await check("from a terminal, Cmd+T puts the caret in a new document", () => expect(entry(page)).toBeFocused({ timeout: 10_000 }));
    await page.keyboard.type("T");
    await check("from a terminal, the first keystroke lands in the capture", () => expect(entry(page)).toContainText("T", { timeout: 5_000 }));
    await shoot(page, "11-from-terminal");
    await close("from the terminal's capture");
    await page.keyboard.press("Escape");

    // Over a dialog.
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await expect(page.locator(".settings-panel")).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Meta+t");
    await check("over the Settings dialog, Cmd+T puts the caret in a new document", () => expect(entry(page)).toBeFocused({ timeout: 10_000 }));
    await page.keyboard.type("D");
    await check("over a dialog, the first keystroke lands in the capture", () => expect(entry(page)).toContainText("D", { timeout: 5_000 }));
    await shoot(page, "12-over-dialog");
    await close("over the dialog");
    if (await page.locator(".settings-panel").isVisible()) await page.locator(".settings-panel__close").click();

    // The top bar button.
    await page.getByRole("button", { name: "Quick capture", exact: true }).click();
    await check("the top bar button opens the same surface, caret in a new document", async () => {
      await expect(surface(page)).toBeVisible({ timeout: 10_000 });
      await expect(entry(page)).toBeFocused({ timeout: 10_000 });
    });
    await shoot(page, "13-top-bar-button");
    await check("Cmd+T pressed again closes it", async () => {
      await page.keyboard.press("Meta+t");
      await expect(surface(page)).toBeHidden({ timeout: 5_000 });
    });

    console.log("Q6", JSON.stringify(results));
    for (const r of results) expect.soft(r.pass, `${r.row}: ${r.detail ?? ""}`).toBe(true);
  } finally {
    await junto.close();
  }
});
