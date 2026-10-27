/**
 * 0.11 F1, the Files node kind, in the real app. A Files node seeded into
 * junto.db draws on the canvas in the dark and the bright theme with no
 * renderer error; its label and root edit through main and land in the
 * `file_trees` row (step 51) with the host untouched; and a node naming a
 * machine that is not this one is refused (plan, Decisions, Host-local).
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/files-node.spec.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { THIS_MACHINE } from "../../tests/support/machines";
import { FILES_ID, filesCard, filesNode, stageFiles } from "../harness/files-scenario";
import { expect, launchJunto, test } from "../harness/launch";
import { commandModel, modelFixture, modelNode, readModelNode } from "../harness/model";

const CANVAS = "files-node";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/files-node";

const dbOf = (homeDir: string): string => join(homeDir, ".junto", "state", "junto.db");

const fileTreeRows = (homeDir: string): ReadonlyArray<Record<string, unknown>> =>
  JSON.parse(
    execFileSync("sqlite3", ["-json", dbOf(homeDir), "SELECT id, label, host, root FROM file_trees"], { encoding: "utf8" }) || "[]",
  ) as ReadonlyArray<Record<string, unknown>>;

const setTheme = async (page: Page, theme: "dark" | "bright"): Promise<void> => {
  await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
  if (theme === "bright") await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
  else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
};

test("a seeded Files node draws in dark and bright, with no renderer error", async () => {
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });
  const stage = await stageFiles();
  const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture([filesNode(stage.fixture.root)]) } });
  const errors: string[] = [];
  junto.page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  junto.page.on("pageerror", (error) => errors.push(error.message));
  try {
    const { page } = junto;
    await expect(filesCard(page)).toBeVisible({ timeout: 30_000 });
    expect(await readModelNode(page, CANVAS, FILES_ID)).toMatchObject({ kind: "files", host: THIS_MACHINE, root: stage.fixture.root });
    for (const theme of ["dark", "bright"] as const) {
      await setTheme(page, theme);
      await page.screenshot({ path: join(SHOTS, `card-${theme}.png`) });
      await filesCard(page).screenshot({ path: join(SHOTS, `card-${theme}-close.png`) });
    }
    expect(errors).toEqual([]);
  } finally {
    await junto.close();
    await stage.cleanup();
  }
});

test("label and root edit through main into file_trees, and the host stays", async () => {
  test.setTimeout(120_000);
  const stage = await stageFiles();
  const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture([filesNode(stage.fixture.root)]) } });
  try {
    const { page, sandbox } = junto;
    await expect(filesCard(page)).toBeVisible({ timeout: 30_000 });
    const moved = join(stage.fixture.root, "src");

    const edited = await commandModel(page, { _tag: "Edit", canvas: CANVAS, id: FILES_ID, change: { kind: "files", label: "Fixture", root: moved } });
    expect(edited).toHaveProperty("seq");

    expect(await readModelNode(page, CANVAS, FILES_ID)).toMatchObject({ kind: "files", label: "Fixture", host: THIS_MACHINE, root: moved });
    await expect.poll(() => fileTreeRows(sandbox.homeDir)).toEqual([{ id: FILES_ID, label: "Fixture", host: THIS_MACHINE, root: moved }]);
  } finally {
    await junto.close();
    await stage.cleanup();
  }
});

test("a Files node naming another machine is refused, and nothing is stored", async () => {
  test.setTimeout(120_000);
  const stage = await stageFiles();
  const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture([]) } });
  try {
    const { page, sandbox } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    const elsewhere = modelNode({
      kind: "files", id: "files-elsewhere", x: 400, y: 60, width: 280, height: 160, z: 1,
      host: "other-machine", root: stage.fixture.root,
    });

    const added = await commandModel(page, { _tag: "Add", canvas: CANVAS, nodes: [elsewhere], wires: [] }).then(
      (result) => result,
      (error: unknown) => ({ refused: String(error) }),
    );
    expect(added).not.toHaveProperty("seq");

    expect(await readModelNode(page, CANVAS, "files-elsewhere")).toBeUndefined();
    expect(fileTreeRows(sandbox.homeDir)).toEqual([]);
  } finally {
    await junto.close();
    await stage.cleanup();
  }
});
