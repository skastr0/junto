import { readModelSeat } from "../harness/model";
/** Amp's creation choices and same-thread client options, in the isolated app. */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { TextNode } from "../../src/shared/canvas";
import { planSeatLaunch } from "../../src/shared/seat-launch-params";
import { seededHarnessBinDir } from "../harness/agent-harness-fixture";
import { expect, test } from "../harness/launch";
import { agentTextNode, canvasDoc } from "../harness/sandbox";

const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/amp-params";
const THREAD = "T-00000000-0000-7000-8000-000000000001";

const ampSeat = (id: string, existing: boolean): TextNode => {
  const node = agentTextNode({
    id,
    key: `local:${id}`,
    label: existing ? "Existing Amp thread" : "New Amp seat",
    harness: "amp",
    cwd: "/tmp",
    x: existing ? 380 : 0,
  });
  const launch = planSeatLaunch({
    harness: "amp",
    params: { mode: "low", extraArgs: existing ? ["--features", "plaid"] : [] },
    base: { cwd: "/tmp" },
  }).launch;
  return {
    ...node,
    ether: {
      ...node.ether,
      terminal: {
        ...node.ether?.terminal,
        bindingId: `local:${id}`,
        harness: "amp",
        launch,
        ...(existing ? { sessionId: THREAD } : {}),
      },
    },
  };
};

test.use({
  juntoOptions: {
    windowContentSize: { width: 1320, height: 1000 },
    seedHarnessInstalls: ["amp"],
    seedCanvases: { "amp-params": canvasDoc([ampSeat("amp-new", false), ampSeat("amp-existing", true)]) },
    afterSeed: async (sandbox) => {
      // Only the public native output format is faked. No live Amp account,
      // thread, plugin, settings file, or inference is involved in this fixture.
      await writeFile(join(seededHarnessBinDir(sandbox), "amp"), `#!/bin/sh
case "$*" in
  --help)
    cat <<'HELP'
Amp CLI
Options:
  -m, --mode <value>
      Set the agent mode by key or label, case-insensitive
  --features <value>
      Enable a thread feature (fast, plaid, pro)
  --fast
      Run new threads in Fast mode
  --no-ide
      Disable IDE connection
  --no-color
      Disable color output
  --settings-file <value>
      Custom settings file path
  --executor <value>
      Run a new thread locally, in an orb, or on a runner
  -x, --execute [message]
      Use execute mode
  --visibility <visibility>
      Set thread visibility
HELP
    ;;
  "plugins list")
    cat <<'PLUGINS'
project agent (loaded)
  agent mode: eclipse
personal agent (loaded)
  agent mode: __custom_mode__
PLUGINS
    ;;
esac
`, "utf8");
    },
  },
});

const setTheme = async (page: Page, theme: "Dark" | "Bright"): Promise<void> => {
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
  await page.getByRole("radio", { name: theme, exact: true }).click();
  await page.locator(".settings-panel__close").click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme ?? "dark"))
    .toBe(theme.toLowerCase());
};

const openParams = async (page: Page, id: string) => {
  await page.locator(`.react-flow__node[data-id="${id}"]`).click();
  await page.getByTestId("rts-seat-guidance").click();
  await page.getByRole("tab", { name: "start params", exact: true }).click();
  const form = page.getByTestId("seat-start-params");
  await expect(form.getByRole("textbox", { name: "Filter options" })).toBeVisible();
  return form;
};

const readSeat = (page: Page, id: string) => readModelSeat(page, "amp-params", id);

for (const theme of ["Dark", "Bright"] as const) {
  test(`Amp params and re-seat respect native thread ownership (${theme})`, async ({ junto: { page } }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(page.locator('.react-flow__node[data-id="amp-new"]')).toBeVisible({ timeout: 30_000 });
    await setTheme(page, theme);
    await page.getByRole("button", { name: "Fit all nodes" }).click();
    const tag = theme.toLowerCase();

    const fresh = await openParams(page, "amp-new");
    const preview = fresh.getByTestId("seat-start-params-preview");
    await expect(fresh.getByRole("textbox", { name: "Model", exact: true })).toHaveCount(0);
    await expect(fresh.getByRole("button", { name: "Effort", exact: true })).toHaveCount(0);
    await expect(fresh.getByText("Choices for this seat's next Amp thread. Mode and startup features are set when the private thread is created.", { exact: true })).toBeVisible();
    await expect(preview).toHaveText("amp --no-ide -m low");
    await fresh.getByRole("button", { name: "Save", exact: true }).scrollIntoViewIfNeeded();
    await fresh.getByRole("button", { name: "Mode", exact: true }).click();
    await expect(page.getByRole("option", { name: "eclipse", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: "__custom_mode__", exact: true })).toBeVisible();
    await page.screenshot({ path: join(SHOTS, `${tag}-creation-modes.png`) });

    // A native key matching the custom-entry seed is still an actual mode.
    await page.getByRole("option", { name: "__custom_mode__", exact: true }).click();
    await expect(preview).toHaveText("amp --no-ide -m __custom_mode__");
    await expect(fresh.getByRole("textbox", { name: "Mode key or label" })).toHaveCount(0);
    await fresh.getByRole("button", { name: "Mode", exact: true }).click();
    await page.getByRole("option", { name: "other key or label…", exact: true }).click();
    const custom = fresh.getByRole("textbox", { name: "Mode key or label" });
    await custom.fill("Review label");
    await expect(custom).toBeFocused();
    await expect(preview).toHaveText('amp --no-ide -m "Review label"');
    await fresh.getByRole("textbox", { name: "Extra arguments" }).fill("--features fast --label experiment");
    await expect(preview).toHaveText('amp --no-ide -m "Review label" --features fast --label experiment');
    await fresh.getByRole("button", { name: "Save", exact: true }).scrollIntoViewIfNeeded();
    await expect(fresh.getByRole("button", { name: "Save", exact: true })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: join(SHOTS, `${tag}-custom-mode.png`) });
    await fresh.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => (await readSeat(page, "amp-new"))?.launch?.argv)
      .toEqual(["amp", "--no-ide", "-m", "Review label", "--features", "fast", "--label", "experiment"]);
    await page.getByRole("button", { name: "Close customize", exact: true }).click();

    const original = await readSeat(page, "amp-existing");
    const existing = await openParams(page, "amp-existing");
    const creationMode = existing.getByRole("textbox", { name: "Creation mode" });
    await expect(creationMode).toHaveValue("low");
    await expect(creationMode).toHaveAttribute("readonly", "");
    await expect(existing.getByRole("button", { name: "Mode", exact: true })).toHaveCount(0);
    await expect(existing.getByRole("button", { name: /^--features/ })).toBeDisabled();
    await expect(existing.getByRole("button", { name: /^--executor/ })).toBeDisabled();
    await expect(existing.getByRole("button", { name: /^--execute/ })).toBeDisabled();
    await expect(existing.getByRole("button", { name: /^--visibility/ })).toBeDisabled();
    await expect(existing.getByTestId("seat-start-params-preview"))
      .toHaveText(`amp --no-ide threads continue ${THREAD}`);
    await existing.getByRole("textbox", { name: "Filter options" }).fill("features");
    await page.screenshot({ path: join(SHOTS, `${tag}-same-thread.png`) });

    await existing.getByRole("textbox", { name: "Extra arguments" }).fill("--features fast");
    await expect(existing.getByRole("alert")).toContainText("Startup features apply when Junto creates the Amp thread.");
    await expect(existing.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    expect(await readSeat(page, "amp-existing")).toEqual(original);
    await page.screenshot({ path: join(SHOTS, `${tag}-feature-refusal.png`) });

    // A client edit is allowed, but never re-emits mode or startup features.
    await existing.getByRole("textbox", { name: "Extra arguments" }).fill("--features plaid --no-color");
    await expect(existing.getByRole("alert")).toHaveCount(0);
    await expect(existing.getByTestId("seat-start-params-preview"))
      .toHaveText(`amp --no-ide threads continue ${THREAD} --no-color`);
    await existing.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => {
      const node = await readSeat(page, "amp-existing");
      return {
        sessionId: node?.sessionId,
        bindingId: node?.bindingId,
        extraArgs: node?.launch?.extraArgs,
      };
    }).toEqual({
      sessionId: THREAD,
      bindingId: "local:amp-existing",
      extraArgs: ["--features", "plaid", "--no-color"],
    });
    await page.getByRole("button", { name: "Close customize", exact: true }).click();

    // Same harness plus a mode must not be mistaken for a bare-harness no-op.
    await page.getByRole("button", { name: "Re-seat agent", exact: true }).click();
    const reseat = page.getByRole("dialog", { name: "Re-seat agent", exact: true });
    await reseat.getByRole("button", { name: "Current Amp", exact: true }).hover();
    const modes = page.getByRole("menu", { name: "Amp modes", exact: true });
    await expect(modes.locator(".agent-cascade__caption-step")).toHaveText("mode");
    await expect(modes.getByRole("menuitem", { name: "eclipse", exact: true })).toBeVisible();
    await page.screenshot({ path: join(SHOTS, `${tag}-reseat-modes.png`) });
    await modes.getByRole("menuitem", { name: "eclipse", exact: true }).click();
    const confirmation = page.getByRole("alertdialog", { name: "Re-seat agent process", exact: true });
    await expect(confirmation).toBeVisible();
    await expect(confirmation.getByText("Amp (eclipse)", { exact: true })).toBeVisible();
    await page.screenshot({ path: join(SHOTS, `${tag}-reseat-confirmation.png`) });
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    expect((await readSeat(page, "amp-existing"))?.sessionId).toBe(THREAD);
    expect(errors).toEqual([]);
  });
}
