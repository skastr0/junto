/**
 * Real app, plan 0.11 02, across L1, L2, L4 and L5: the claims a reader of the
 * plan would check by hand, end to end, dark and bright.
 *
 * A seat's `junto artifact create` with `[[Target note]]` in its markdown is
 * stored as the id link (L5), and `[[Nope]]` or a title two artifacts share is
 * refused naming them. The target's "Linked from" lists the seat's document
 * with the line around the link (L1, L4), beside a comment that links it.
 * The operator renames the target and the link holds: the source still names
 * the same id and draws the new title, and Linked from still lists it.
 * After a quit and relaunch on the same home both rows are still listed.
 * Archiving the source drops its body row; the comment row stays. `show`
 * lists the body in linkedFrom.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/artifact-links-verify.spec.ts
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright-core";
import { Schema } from "effect";
import { asNodeId, Node } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { expect, launchJunto, test, type JuntoHandle } from "../harness/launch";
import { modelFixture, modelRegion, modelSeat } from "../harness/model";

const CANVAS = "links-verify";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/artifact-links-verify";
const shelf = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({ kind: "artifacts", id: "shelf", label: "Shelf", x: 400, y: 60, width: 280, height: 160, z: 0 });

const seedDocument = (page: Page, title: string, markdown: string): Promise<unknown> =>
  page.evaluate(
    ({ canvas, node, artifactId, opId, title, markdown }) =>
      window.junto!.resource!.artifact!.apply(canvas, node, artifactId, opId, { op: "create", title, body: { type: "document", markdown } }),
    { canvas: CANVAS, node: asNodeId("shelf"), artifactId: mintItemId(), opId: mintOpId(), title, markdown },
  );

const setTheme = async (page: Page, theme: "bright" | "dark"): Promise<void> => {
  await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
  if (theme === "bright") await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
  else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
};

const pick = async (page: Page, title: string): Promise<void> => {
  await page.getByRole("list", { name: "Artifacts" }).locator("button").filter({ hasText: title }).first().click();
  await expect(page.locator(".artifact-head__title")).toHaveValue(title, { timeout: 15_000 });
};

/** Quit the app and start a second one by hand on the same home (as seat-offboard-surfaces.spec.ts does). */
const quitAndRelaunch = async (junto: JuntoHandle, env: Record<string, string>): Promise<ElectronApplication> => {
  const child = junto.app.process();
  const gone = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  await junto.app.close();
  await gone;
  const app = await electron.launch({
    executablePath: createRequire(import.meta.url)("electron") as string,
    args: [process.cwd(), `--user-data-dir=${junto.sandbox.userDataDir}`, "--mute-audio"],
    env,
    timeout: 60_000,
  });
  // The quit gate cannot be clicked in a hidden window: accept it, as launch.ts does.
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox;
  });
  return app;
};

type Listed = { readonly id?: string; readonly artifactId?: string; readonly title: string };

test("a seat's [[Title]] links by id, Linked from shows body and comment, a rename keeps it, an archive drops it", async () => {
  test.setTimeout(360_000);
  const folder = mkdtempSync(join(tmpdir(), "junto-links-seat-"));
  const scout = modelSeat({ id: "scout", key: "local:links-scout", label: "Scout", harness: "codex", cwd: folder, x: 40, y: 60 });
  const ops = modelRegion({ id: "ops", label: "Ops", x: 0, y: 0, width: 800, height: 400 });
  const junto = await launchJunto({
    windowContentSize: { width: 1500, height: 900 },
    seedModels: { [CANVAS]: modelFixture([ops, scout, shelf], []) },
    afterSeed: installCrewSeatHarness,
  });
  let second: ElectronApplication | undefined;
  try {
    const { page, sandbox } = junto;
    await expect(page.locator('.react-flow__node[data-id="shelf"]')).toBeVisible({ timeout: 30_000 });
    const seat = crewSeat(sandbox, CANVAS, "scout");
    await crewPlayFactory(page);
    await crewOccupySeat(page, CANVAS, scout, seat);
    expect((await seat.op("onboard", {})).ok, "scout onboards").toBe(true);

    await seedDocument(page, "Target note", "# Target note\n\nThe one to link.");
    await seedDocument(page, "Twin", "one");
    await seedDocument(page, "Twin", "two");
    await seedDocument(page, "Commented", "# Commented\n\nIts thread links the target.");

    const cli = async (argv: ReadonlyArray<string>) => {
      const result = await seat.cli(argv);
      // A refusal's envelope comes on stderr.
      const out = result.stdout.trim() === "" ? result.stderr : result.stdout;
      return { ...result, json: JSON.parse(out.trim() || "{}") as { ok?: boolean; data?: Record<string, unknown>; error?: unknown } };
    };
    const listed = await cli(["artifact", "list", "--type", "document"]);
    const idOf = (title: string): string => {
      const row = (listed.json.data!.artifacts as ReadonlyArray<Listed>).find((a) => a.title === title);
      const id = row?.artifactId ?? row?.id;
      expect(id, `${title} in ${listed.stdout.slice(0, 400)}`).toBeTruthy();
      return id!;
    };
    const targetId = idOf("Target note");
    const commentedId = idOf("Commented");

    // L5: [[Title]] resolves to the id link; nothing and two are refused, naming what they found.
    const made = await cli(["artifact", "create", "From the seat", "--type", "document", "--markdown", "# From the seat\n\nSee [[Target note]] for the plan."]);
    expect(made.json.ok, made.stdout.slice(0, 600)).toBe(true);
    const madeData = made.json.data as { artifactId?: string; id?: string };
    const madeId = madeData.artifactId ?? madeData.id;
    expect(madeId, made.stdout.slice(0, 600)).toBeTruthy();
    const shown = await cli(["artifact", "show", madeId!]);
    expect(shown.json.ok, shown.stdout.slice(0, 600)).toBe(true);
    const stored = shown.stdout;
    // Stored as artifact-link.ts writes it: the label [[Target note]] with its brackets escaped, the address by id.
    const text = (shown.json.data as { text: string }).text;
    expect(text).toContain(String.raw`See [\[\[Target note\]\]](junto://canvas/${CANVAS}?node=shelf&item=${targetId}) for the plan.`);
    const url = /\((junto:\/\/[^)\s"\\]+)\)/u.exec(stored)?.[1];
    expect(url, "the stored link carries its junto:// address").toBeTruthy();

    const none = await cli(["artifact", "create", "Nowhere", "--type", "document", "--markdown", "See [[Nope]]."]);
    expect(none.json.ok, `${String(none.exitCode)} ${none.stdout.slice(0, 300)} ${none.stderr.slice(0, 600)}`).toBe(false);
    expect(`${none.stdout}${none.stderr}`).toContain("Nope");
    const twins = await cli(["artifact", "create", "Two ways", "--type", "document", "--markdown", "See [[Twin]]."]);
    expect(twins.json.ok, `${String(twins.exitCode)} ${twins.stderr.slice(0, 600)}`).toBe(false);
    const twinIds = (listed.json.data!.artifacts as ReadonlyArray<Listed>).filter((a) => a.title === "Twin").map((a) => a.artifactId ?? a.id!);
    for (const id of twinIds) expect(`${twins.stdout}${twins.stderr}`, "the refusal names each candidate").toContain(id);

    // A comment that links the target, through the same address.
    const commented = await cli(["artifact", "comment", commentedId, `Also read [Target note](${url!}).`]);
    expect(commented.json.ok, commented.stdout.slice(0, 400)).toBe(true);

    // show's linkedFrom carries the body.
    const targetShown = await cli(["artifact", "show", targetId]);
    expect(JSON.stringify(targetShown.json.data)).toContain("From the seat");

    // L1, L4: the operator sees both kinds under Linked from.
    const card = page.locator('.react-flow__node[data-id="shelf"]');
    await card.dblclick();
    await expect(page.getByRole("list", { name: "Artifacts" })).toBeVisible({ timeout: 20_000 });
    await pick(page, "Target note");
    // Linked from lives in the comments rail, which starts collapsed to its edge.
    await page.locator(".artifact-comments-edge").click();
    const linkedFrom = page.getByTestId("linked-from");
    const bodyRow = linkedFrom.locator('[data-testid="linked-from-row"][data-kind="body"]');
    const postRow = linkedFrom.locator('[data-testid="linked-from-row"][data-kind="post"]');
    await expect(bodyRow.filter({ hasText: "From the seat" })).toHaveCount(1, { timeout: 20_000 });
    await expect(bodyRow.filter({ hasText: "From the seat" }).locator(".linked-from__line")).toContainText("for the plan");
    await expect(postRow).toHaveCount(1, { timeout: 20_000 });
    for (const theme of ["dark", "bright"] as const) {
      mkdirSync(join(SHOTS, theme), { recursive: true });
      await setTheme(page, theme);
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(SHOTS, theme, "1-linked-from.png") });
    }

    // A rename keeps the link: same id stored, the new title drawn, still listed.
    const title = page.locator(".artifact-head__title");
    await title.fill("Target renamed");
    await title.press("Enter");
    await expect(page.getByRole("list", { name: "Artifacts" }).locator("button").filter({ hasText: "Target renamed" })).toHaveCount(1, { timeout: 15_000 });
    await expect(bodyRow.filter({ hasText: "From the seat" })).toHaveCount(1, { timeout: 15_000 });
    const after = await cli(["artifact", "show", madeId!]);
    expect(after.stdout).toContain(targetId);
    await pick(page, "From the seat");
    await expect(page.locator(".artifact-body, .artifact-document, main").getByText("Target renamed").first()).toBeVisible({ timeout: 15_000 });
    for (const theme of ["dark", "bright"] as const) {
      await setTheme(page, theme);
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(SHOTS, theme, "2-renamed-chip.png") });
    }

    // The body link opens its target with the modal up, and again the second time (23d5c772b):
    // a Linked from chip would close the modal first and pass either way.
    const headTitle = page.locator(".artifact-head__title");
    for (const round of [1, 2]) {
      await pick(page, "From the seat");
      await page.locator(".artifact-body, .artifact-document, main").getByText("Target renamed").first().click();
      await expect(headTitle, `round ${String(round)}: the link opens its target`).toHaveValue("Target renamed", { timeout: 15_000 });
      await expect(page.getByRole("list", { name: "Artifacts" }), "the modal stayed up").toBeVisible();
    }

    // A quit and relaunch on the same home: Linked from still lists both rows.
    const env = await junto.app.evaluate(() => {
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") out[key] = value;
      return out;
    });
    second = await quitAndRelaunch(junto, env);
    const again = await second.firstWindow();
    const window = await second.browserWindow(again);
    await window.evaluate((main) => main.setContentSize(1500, 900));
    await expect(again.locator('.react-flow__node[data-id="shelf"]')).toBeVisible({ timeout: 30_000 });
    await again.locator('.react-flow__node[data-id="shelf"]').dblclick();
    await expect(again.getByRole("list", { name: "Artifacts" })).toBeVisible({ timeout: 20_000 });
    await pick(again, "Target renamed");
    const rail = again.locator(".artifact-comments-edge");
    if (await rail.isVisible()) await rail.click();
    const linkedAgain = again.getByTestId("linked-from");
    const bodyAgain = linkedAgain.locator('[data-testid="linked-from-row"][data-kind="body"]');
    const postAgain = linkedAgain.locator('[data-testid="linked-from-row"][data-kind="post"]');
    await expect(bodyAgain.filter({ hasText: "From the seat" })).toHaveCount(1, { timeout: 20_000 });
    await expect(bodyAgain.filter({ hasText: "From the seat" }).locator(".linked-from__line")).toContainText("for the plan");
    await expect(postAgain).toHaveCount(1, { timeout: 20_000 });
    for (const theme of ["dark", "bright"] as const) {
      await setTheme(again, theme);
      await again.waitForTimeout(250);
      await again.screenshot({ path: join(SHOTS, theme, "3-after-relaunch.png") });
    }

    // Archiving the source, from its own header, drops its body row; the comment row stays.
    await pick(again, "From the seat");
    await again.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(again.getByRole("button", { name: "Restore", exact: true })).toBeVisible({ timeout: 15_000 });
    await again.getByRole("list", { name: "Artifacts" }).locator("button").filter({ hasText: "Target renamed" }).first().click();
    await expect(again.locator(".artifact-head__title")).toHaveValue("Target renamed", { timeout: 15_000 });
    if (await rail.isVisible()) await rail.click();
    await expect(postAgain).toHaveCount(1, { timeout: 20_000 });
    await expect(bodyAgain).toHaveCount(0, { timeout: 20_000 });
  } finally {
    if (second !== undefined) await second.close().catch(() => undefined);
    await junto.close();
  }
});
