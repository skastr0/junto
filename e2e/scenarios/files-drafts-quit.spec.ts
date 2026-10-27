/**
 * 0.11 Files drafts on quit, in the real app: an unsaved file and a quit
 * asks Save all, Discard or Cancel. Cancel keeps the app and the draft,
 * Save all writes the file and quits, Discard quits and leaves the file as
 * it was. Frames of the ask in dark and bright.
 *   bun run test:e2e:fast e2e/scenarios/files-drafts-quit.spec.ts
 */
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture } from "../harness/model";
import { filesNode, openFilesModal, openInTree, stageFiles } from "../harness/files-scenario";

const CANVAS = "files-drafts-quit";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/files-drafts-quit";

const exited = (child: ChildProcess, ms: number): Promise<boolean> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

const launchWithDraft = async (typed: string) => {
  const stage = await stageFiles();
  const junto = await launchJunto({
    windowContentSize: { width: 1400, height: 900 },
    seedModels: { [CANVAS]: modelFixture([filesNode(stage.fixture.root)]) },
  });
  const { page } = junto;
  await page.waitForFunction(() => window.junto !== undefined);
  const modal = await openFilesModal(page);
  await openInTree(modal, stage.fixture.paths.markdown);
  const editor = modal.locator(".files-main .cm-content").first();
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type(typed);
  await expect(modal.getByText("Unsaved").first()).toBeVisible({ timeout: 10_000 });
  const file = join(stage.fixture.root, stage.fixture.paths.markdown);
  return { stage, junto, page, file, before: await readFile(file, "utf8") };
};

/** Ask the app to quit as Cmd+Q does; the call itself may never answer when the app leaves. */
const quit = (junto: Awaited<ReturnType<typeof launchJunto>>): void => {
  void junto.app.evaluate(({ app }) => app.quit()).catch(() => undefined);
};

test("an unsaved file asks before quit: Cancel keeps the app, Save all writes and quits", async () => {
  test.setTimeout(240_000);
  const typed = "\nWritten before quit.";
  const { stage, junto, page, file, before } = await launchWithDraft(typed);
  const child = junto.app.process();
  try {
    const ask = page.getByTestId("unsaved-files-dialog");
    quit(junto);
    await expect(ask).toBeVisible({ timeout: 15_000 });
    await expect(ask).toContainText("Save changes to README.md?");
    for (const theme of ["dark", "bright"] as const) {
      await page.evaluate((next) => window.junto!.settingsPatch({ appearance: { theme: next } }), theme);
      await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(theme === "bright" ? "bright" : null);
      mkdirSync(SHOTS, { recursive: true });
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(SHOTS, `ask-${theme}.png`) });
    }

    // Cancel: the app stays, the draft stays, nothing is written.
    await ask.getByRole("button", { name: "Cancel" }).click();
    await expect(ask).toBeHidden();
    expect(await exited(child, 3_000)).toBe(false);
    await expect(page.getByText("Unsaved").first()).toBeVisible();
    expect(await readFile(file, "utf8")).toBe(before);

    // Save all: the file is written, then the app quits.
    quit(junto);
    await expect(ask).toBeVisible({ timeout: 15_000 });
    await ask.getByRole("button", { name: "Save all" }).click();
    expect(await exited(child, 30_000)).toBe(true);
    expect(await readFile(file, "utf8")).toContain("Written before quit.");
  } finally {
    await junto.close().catch(() => undefined);
    await stage.cleanup();
  }
});

test("Discard quits and leaves the file as it was on disk", async () => {
  test.setTimeout(180_000);
  const { stage, junto, page, file, before } = await launchWithDraft("\nThrown away.");
  const child = junto.app.process();
  try {
    const ask = page.getByTestId("unsaved-files-dialog");
    quit(junto);
    await expect(ask).toBeVisible({ timeout: 15_000 });
    await ask.getByRole("button", { name: "Discard" }).click();
    expect(await exited(child, 30_000)).toBe(true);
    expect(await readFile(file, "utf8")).toBe(before);
  } finally {
    await junto.close().catch(() => undefined);
    await stage.cleanup();
  }
});
