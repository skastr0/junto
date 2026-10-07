/**
 * Region Environment screen, visual walk [fake-tui]: twelve steps (S1 to S12), one
 * test each except S12, which shares S4's test and state, every state a person would want to look at saved as a
 * full-page screenshot with a stable name.
 *
 *   ENV_WALK_SHOTS=/some/folder bun run test:e2e:fast e2e/scenarios/region-environment-walk.spec.ts
 *
 * Shots land in ENV_WALK_SHOTS when it is set, otherwise in each test's own
 * output folder, as `S<step>-<what>.png`. The app is forced to the dark
 * theme through the settings bridge, the way design-audit.spec.ts does it.
 *
 * Every check of a PASS line is a soft expectation: a miss is listed and the
 * step goes on, so the later shots of the same step are still taken. Only the
 * gestures a step cannot continue without (the panel opens, a form saves) are
 * hard; when one of those fails the step leaves `S<step>-on-failure.png`.
 *
 * Every test boots the same canvas: region Org, region Team inside it, and
 * one fake agent seat (the crew fixture's fake codex) inside Team. No real
 * harness binary starts. Files live under os.tmpdir() or the launch sandbox.
 * One secret is saved, in S4, and only after a hard guard has proven the app
 * keeps secrets in files under the throwaway home; S12 (same test) removes
 * it. The only Keychain call is a lookup of a made-up item that does not
 * exist (S9).
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright-core";
import type { CanvasDoc, EnvSource, EtherRegionEnvironment, GroupNode, TextNode } from "../../src/shared/canvas";
import { SOURCE_KINDS } from "../../src/renderer/lib/region-environment";
import {
  crewDoc,
  crewOccupySeat,
  crewPlayFactory,
  crewSeat,
  crewSeatNode,
  installCrewSeatHarness,
  type WorkEnvelope,
} from "../harness/crew-fixture";
import { expect, launchJunto, test, type JuntoHandle } from "../harness/launch";

const CANVAS = "envwalk";
const SESSION = "sess-envwalk-0001";

/** Every PASS check: a miss is recorded and the step goes on. */
const soft = expect.configure({ soft: true });

// ---------------------------------------------------------------------------
// The canvas every step boots on
// ---------------------------------------------------------------------------

const regionNode = (input: {
  readonly id: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly sources?: ReadonlyArray<EnvSource>;
}): GroupNode => ({
  id: input.id,
  type: "group",
  label: input.label,
  x: input.x,
  y: input.y,
  width: input.width,
  height: input.height,
  ether: {
    region: {
      hold: true,
      ...(input.sources ? { environment: { sources: [...input.sources] } } : {}),
    },
  },
});

const plainValue = (id: string, name: string, value: string): EnvSource => ({ id, kind: "value", name, value });

const OUTER = { id: "org", label: "Org", x: 40, y: 40, width: 700, height: 440 } as const;
const INNER = { id: "team", label: "Team", x: 80, y: 140, width: 440, height: 260 } as const;

const seatBase = crewSeatNode({ id: "worker", label: "Worker", x: 120, y: 250 });
/** The one seat, inside Team, with a session to keep (seat-sessions.spec.ts seeds it the same way). */
const SEAT: TextNode = {
  ...seatBase,
  ether: { ...seatBase.ether, terminal: { ...seatBase.ether!.terminal!, sessionId: SESSION } },
};

const walkDoc = (innerSources?: ReadonlyArray<EnvSource>): CanvasDoc =>
  crewDoc([regionNode(OUTER), regionNode({ ...INNER, ...(innerSources ? { sources: innerSources } : {}) }), SEAT]);

// ---------------------------------------------------------------------------
// Launch, theme, evidence
// ---------------------------------------------------------------------------

const shotsDir = (testInfo: TestInfo): string => process.env.ENV_WALK_SHOTS ?? testInfo.outputPath();

/** Full page, stable name, one folder. */
const shot = async (page: Page, testInfo: TestInfo, step: string, what: string): Promise<void> => {
  const dir = shotsDir(testInfo);
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${step}-${what}.png`), fullPage: true });
};

const note = (testInfo: TestInfo, type: string, description: string): void => {
  testInfo.annotations.push({ type, description });
};

/** Dark, through the same settings IPC the Appearance panel writes (design-audit.spec.ts:178). */
const forceDark = async (page: Page): Promise<void> => {
  await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
};

const walk = async (
  testInfo: TestInfo,
  step: string,
  doc: CanvasDoc,
  body: (junto: JuntoHandle) => Promise<void>,
): Promise<void> => {
  const junto = await launchJunto({ seedCanvases: { [CANVAS]: doc }, afterSeed: installCrewSeatHarness });
  try {
    await expect(junto.page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await forceDark(junto.page);
    await body(junto);
  } catch (error) {
    await shot(junto.page, testInfo, step, "on-failure").catch(() => undefined);
    throw error;
  } finally {
    await junto.close();
  }
};

const opData = (envelope: WorkEnvelope): Record<string, unknown> => {
  expect(envelope.ok, JSON.stringify(envelope)).toBe(true);
  return ((envelope as { readonly data?: unknown }).data ?? {}) as Record<string, unknown>;
};

/** The region's environment as the canvas has it saved. */
const savedEnvironment = async (page: Page, regionId: string): Promise<EtherRegionEnvironment | undefined> => {
  const doc = (await page.evaluate(async (name) => (await window.junto!.readCanvas(name)).doc, CANVAS)) as CanvasDoc;
  const region = doc.nodes.find((node) => node.id === regionId);
  return region?.type === "group" ? region.ether?.region?.environment : undefined;
};

// ---------------------------------------------------------------------------
// The Environment screen
// ---------------------------------------------------------------------------

const selectRegion = async (page: Page, regionId: string): Promise<void> => {
  const region = page.getByTestId(`rf__node-${regionId}`);
  await expect(region).toBeVisible({ timeout: 30_000 });
  await region.locator(".region-drag-handle").first().click();
};

const environmentButton = (page: Page): Locator => page.getByRole("button", { name: /^Region environment/ });

const openRegionEnvironment = async (page: Page, regionId: string): Promise<Locator> => {
  await selectRegion(page, regionId);
  const open = environmentButton(page);
  await expect(open).toBeVisible({ timeout: 10_000 });
  await open.click();
  const dialog = page.getByRole("dialog", { name: "Region environment" });
  await expect(dialog.getByTestId("region-env")).toBeVisible();
  return dialog;
};

const closeRegionEnvironment = async (dialog: Locator): Promise<void> => {
  await dialog.getByRole("button", { name: "done", exact: true }).click();
  await expect(dialog).toBeHidden();
};

/** Open the add form on one kind. Never saves. */
const openSourceForm = async (dialog: Locator, kind: EnvSource["kind"]): Promise<Locator> => {
  await dialog.getByTestId("region-env-add-source").click();
  const form = dialog.getByTestId("region-env-form");
  await form.getByTestId(`region-env-kind-${kind}`).click();
  await expect(form).toHaveAttribute("data-kind", kind);
  return form;
};

const cancelSourceForm = async (form: Locator): Promise<void> => {
  await form.getByRole("button", { name: "cancel", exact: true }).click();
  await expect(form).toHaveCount(0);
};

/** Add one source through the form: pick the kind, fill its fields, save. Never used for a secret. */
const addSource = async (
  dialog: Locator,
  kind: Exclude<EnvSource["kind"], "secret">,
  fields: Readonly<Record<string, string>>,
): Promise<void> => {
  const form = await openSourceForm(dialog, kind);
  for (const [key, value] of Object.entries(fields)) {
    await form.getByTestId(`region-env-field-${key}`).fill(value);
  }
  await form.getByTestId("region-env-save-source").click();
  await expect(form).toHaveCount(0);
};

const sourceRows = (dialog: Locator): Locator => dialog.getByTestId("region-env-source");

/** The source list, top to bottom, by title. */
const sourceTitles = (dialog: Locator): Promise<ReadonlyArray<string>> =>
  dialog.locator('[data-testid="region-env-source"] .region-env__source-title').allTextContents();

const resolved = (dialog: Locator): Locator => dialog.locator('section[aria-label="What a seat here gets"]');

const variable = (dialog: Locator, name: string): Locator =>
  dialog.locator(`[data-testid="region-env-variable"][data-name="${name}"]`);

/** Wait until main has answered and the "Reading your stores" line is gone. */
const settled = async (dialog: Locator): Promise<void> => {
  await expect(dialog.getByTestId("region-env-reading")).toHaveCount(0, { timeout: 30_000 });
};

/** Children of `box` whose own box sticks out of it, named for the report. */
const stickingOut = (box: Locator): Promise<ReadonlyArray<string>> =>
  box.evaluate((el) => {
    const outer = el.getBoundingClientRect();
    return Array.from(el.querySelectorAll("input, textarea, select, button, label, p, code"))
      .filter((child) => {
        const rect = child.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        return (
          rect.left < outer.left - 1 || rect.right > outer.right + 1 || rect.top < outer.top - 1 || rect.bottom > outer.bottom + 1
        );
      })
      .map((child) => `${child.tagName.toLowerCase()} ${child.getAttribute("data-testid") ?? (child.textContent ?? "").trim().slice(0, 40)}`);
  });

// ===========================================================================

test("S1 entry: the key icon in the region toolbar opens a panel titled Environment that fits and scrolls", async ({}, testInfo) => {
  test.setTimeout(180_000);
  await walk(testInfo, "S1", walkDoc(), async ({ page }) => {
    await shot(page, testInfo, "S1", "canvas");
    await selectRegion(page, INNER.id);

    const paths = page.getByRole("button", { name: /^Region folder paths/ });
    const open = environmentButton(page);
    await expect(open).toBeVisible({ timeout: 10_000 });
    await shot(page, testInfo, "S1", "toolbar-pill");

    // A key icon, in the same pill as folder paths and right after it.
    const iconClass = (await open.locator("svg").first().getAttribute("class")) ?? "";
    note(testInfo, "S1-icon-class", iconClass);
    soft(iconClass, "the Environment button's icon is the key").toContain("key");
    soft(
      await open.evaluate((el, pathsLabel) => {
        const pill = el.parentElement;
        const buttons = pill ? Array.from(pill.querySelectorAll("button")) : [];
        const at = buttons.indexOf(el as HTMLButtonElement);
        return at > 0 && (buttons[at - 1]!.getAttribute("aria-label") ?? "").startsWith(pathsLabel);
      }, "Region folder paths"),
      "the key sits next to folder paths in the toolbar pill",
    ).toBe(true);
    await soft(paths).toBeVisible();
    await soft(open).toHaveAttribute("data-junto-tooltip", "Environment");

    await open.click();
    const dialog = page.getByRole("dialog", { name: "Region environment" });
    await expect(dialog.getByTestId("region-env")).toBeVisible();
    await settled(dialog);
    await shot(page, testInfo, "S1", "panel-open");

    await soft(dialog.locator("header").first(), "the panel's title").toContainText("Environment");
    await soft(dialog.locator("header").first()).toContainText(`What seats inside ${INNER.label} get when they start`);

    // The panel fits the window.
    const panel = dialog.locator(".focus-surface__panel");
    const box = await panel.boundingBox();
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    note(testInfo, "S1-panel-box", `${JSON.stringify(box)} in viewport ${JSON.stringify(viewport)}`);
    soft(box, "the panel has a box").not.toBeNull();
    if (box) {
      soft(box.x, "panel left edge inside the window").toBeGreaterThanOrEqual(0);
      soft(box.y, "panel top edge inside the window").toBeGreaterThanOrEqual(0);
      soft(box.x + box.width, "panel right edge inside the window").toBeLessThanOrEqual(viewport.width);
      soft(box.y + box.height, "panel bottom edge inside the window").toBeLessThanOrEqual(viewport.height);
    }

    // It scrolls: the page of sections is the scroll container.
    const scroller = dialog.getByTestId("region-env");
    const overflowY = await scroller.evaluate((el) => getComputedStyle(el).overflowY);
    soft(overflowY, "the scroll container's overflow-y").toMatch(/^(auto|scroll)$/u);

    // Make it taller than the panel (the add form) and go to the bottom.
    await dialog.getByTestId("region-env-add-source").click();
    const heights = await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollTop: el.scrollTop };
    });
    note(testInfo, "S1-scroll", JSON.stringify(heights));
    soft(heights.scrollHeight, "with the add form open the content is taller than the panel").toBeGreaterThan(heights.clientHeight);
    soft(heights.scrollTop, "and the panel scrolled").toBeGreaterThan(0);
    await shot(page, testInfo, "S1", "panel-scrolled-to-bottom");
    soft(await dialog.getByRole("button", { name: "done", exact: true }).isVisible(), "the footer stays in view while scrolled").toBe(true);
  });
});

test("S2 forms: eight kinds, Keychain first, each showing only its own fields, switching clears them", async ({}, testInfo) => {
  test.setTimeout(240_000);
  await walk(testInfo, "S2", walkDoc(), async ({ page }) => {
    const dialog = await openRegionEnvironment(page, INNER.id);
    await settled(dialog);
    await dialog.getByTestId("region-env-add-source").click();
    const form = dialog.getByTestId("region-env-form");
    await expect(form).toBeVisible();
    await form.scrollIntoViewIfNeeded();
    await shot(page, testInfo, "S2", "kind-grid");

    const kinds = form.locator('[data-testid^="region-env-kind-"]');
    await soft(kinds, "the grid of kinds").toHaveCount(8);
    await soft(kinds.first().locator(".region-env__kind-label"), "the first kind").toHaveText("macOS Keychain item");
    const grid = await kinds.evaluateAll((buttons) =>
      buttons.map((button) => ({
        label: (button.querySelector(".region-env__kind-label")?.textContent ?? "").trim(),
        summary: (button.querySelector(".region-env__kind-summary")?.textContent ?? "").trim(),
        // Text wider than its box is cut off.
        clipped: Array.from(button.querySelectorAll("span")).some((span) => span.scrollWidth > span.clientWidth + 1),
      })),
    );
    note(testInfo, "S2-kinds", JSON.stringify(grid));
    soft(grid.map((kind) => kind.label), "each kind's label, in order").toEqual(SOURCE_KINDS.map((kind) => kind.label));
    soft(grid.map((kind) => kind.summary), "each kind's one-line summary").toEqual(SOURCE_KINDS.map((kind) => kind.summary));
    soft(grid.filter((kind) => kind.clipped).map((kind) => kind.label), "kinds whose text is cut off").toEqual([]);
    soft(await stickingOut(form.locator(".region-env__kinds")), "kind cards sticking out of the grid").toEqual([]);

    const typed = form.locator("input:not([type='checkbox']), textarea");
    for (const kind of SOURCE_KINDS) {
      await form.getByTestId(`region-env-kind-${kind.kind}`).click();
      await expect(form).toHaveAttribute("data-kind", kind.kind);
      await soft(form.getByTestId(`region-env-kind-${kind.kind}`)).toHaveAttribute("aria-checked", "true");

      // Switching kind clears what was typed in the last one.
      soft(
        await typed.evaluateAll((fields) => fields.map((field) => (field as HTMLInputElement).value)),
        `${kind.label}: fields are empty after switching to it`,
      ).toEqual(kind.fields.filter((field) => field.key !== "tokenFrom").map(() => ""));

      // Only this kind's fields, each with its label and example.
      await soft(form.locator(".region-env__field"), `${kind.label}: number of fields`).toHaveCount(kind.fields.length);
      soft(
        (await form.locator(".region-env__label").allTextContents()).map((label) => label.replace(/optional$/u, "").trim()),
        `${kind.label}: field labels`,
      ).toEqual(kind.fields.map((field) => field.label));
      for (const field of kind.fields) {
        // The token picker is a select: it has options, not an example.
        if (field.key === "tokenFrom") continue;
        const input = field.key === "attributes" ? form.locator("textarea") : form.getByTestId(`region-env-field-${field.key}`);
        await soft(input, `${kind.label}: example in ${field.label}`).toHaveAttribute("placeholder", field.placeholder);
      }

      await form.scrollIntoViewIfNeeded();
      soft(await stickingOut(form), `${kind.label}: parts sticking out of the form`).toEqual([]);
      const scroller = dialog.getByTestId("region-env");
      soft(
        await scroller.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        `${kind.label}: the panel does not scroll sideways`,
      ).toBe(true);
      await shot(page, testInfo, "S2", `form-${kind.kind}`);

      // Leave something behind for the next kind to clear.
      await typed.first().fill("LEFTOVER");
    }

    // And back to the first: what was typed there at the start is gone too.
    await form.getByTestId("region-env-kind-keychain").click();
    await soft(form.getByTestId("region-env-field-name"), "back on Keychain, the name is empty").toHaveValue("");
    await cancelSourceForm(form);
    await soft(sourceRows(dialog), "nothing was added by looking").toHaveCount(0);
    await shot(page, testInfo, "S2", "form-cancelled");
  });
});

test("S3 plain value: the row appears at once and the resolved list names it without its value", async ({}, testInfo) => {
  test.setTimeout(180_000);
  await walk(testInfo, "S3", walkDoc(), async ({ page }) => {
    // Every "Reading your stores" line the screen shows, as it shows it.
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { __envWalkReading: string[] }).__envWalkReading = seen;
      const look = (): void => {
        const text = document.querySelector('[data-testid="region-env-reading"]')?.textContent?.trim();
        if (text && seen.at(-1) !== text) seen.push(text);
      };
      new MutationObserver(look).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    const readingLines = (): Promise<ReadonlyArray<string>> =>
      page.evaluate(() => [...(window as unknown as { __envWalkReading: string[] }).__envWalkReading]);

    const dialog = await openRegionEnvironment(page, INNER.id);
    await settled(dialog);
    await shot(page, testInfo, "S3", "before");

    const form = await openSourceForm(dialog, "value");
    await form.getByTestId("region-env-field-name").fill("AWS_REGION");
    await form.getByTestId("region-env-field-value").fill("eu-west-1");
    await form.scrollIntoViewIfNeeded();
    await shot(page, testInfo, "S3", "form-filled");
    await form.getByTestId("region-env-save-source").click();

    // The row is there at once, before main has answered.
    await soft(sourceRows(dialog), "the row appears at once").toHaveCount(1, { timeout: 2_000 });
    await shot(page, testInfo, "S3", "just-saved");
    await soft(sourceRows(dialog).first()).toContainText("AWS_REGION");
    await soft(sourceRows(dialog).first()).toContainText("Plain value: eu-west-1");

    await soft(variable(dialog, "AWS_REGION").locator(".region-env__origin"), "the resolved list").toHaveText("Plain value, this region", {
      timeout: 30_000,
    });
    await settled(dialog);
    const lines = await readingLines();
    note(testInfo, "S3-reading-lines", JSON.stringify(lines));
    soft(lines, 'a "Reading your stores." line was shown').toContain("Reading your stores.");
    await soft(sourceRows(dialog).first(), "the row's status").toContainText("Set");
    await soft(resolved(dialog), "the value is not in the resolved list").not.toContainText("eu-west-1");
    await resolved(dialog).scrollIntoViewIfNeeded();
    await shot(page, testInfo, "S3", "resolved-list");
  });
});

// S4 SAVES A SECRET. THAT IS ONLY SAFE ON A BUILD WHOSE HARNESS SETS
// JUNTO_SECRET_STORE=file (65e3ad6da ON), WHERE THE SECRET LANDS IN FILES
// UNDER THE THROWAWAY HOME. ON ANY OTHER BUILD, SAVING WRITES TO THE
// OPERATOR'S REAL LOGIN KEYCHAIN. THE HARD GUARD BELOW MUST PASS BEFORE THE
// SAVE BUTTON IS CLICKED. DO NOT MOVE THE SAVE ABOVE IT, AND NEVER PRESS
// ENTER IN THE FORM BEFORE IT.
const STORE_SENTENCE = "owner-only files in its own folder (set by JUNTO_SECRET_STORE=file)";

/** Where the file store keeps region secrets: beside the state database (credentials/store.ts regionSecretDirectory). */
const regionSecretsDir = (homeDir: string): string => join(homeDir, ".junto", "state", "region-secrets");

const secretFiles = async (homeDir: string): Promise<ReadonlyArray<{ readonly name: string; readonly mode: string }>> => {
  const dir = regionSecretsDir(homeDir);
  const names = await readdir(dir).catch(() => [] as string[]);
  return Promise.all(
    names.sort().map(async (name) => ({
      name,
      mode: ((await stat(join(dir, name))).mode & 0o777).toString(8),
    })),
  );
};

test("S4 and S12 secret: masked while typed, saved only to the sandbox file store, never shown again, then removed", async ({}, testInfo) => {
  test.setTimeout(240_000);
  await walk(testInfo, "S4", walkDoc(), async ({ page, app, sandbox }) => {
    // Main says which store it opened, once, on its log (region-env/secret-store.ts).
    const mainLog: string[] = [];
    const keep = (chunk: Buffer): void => {
      mainLog.push(String(chunk));
    };
    app.process().stdout?.on("data", keep);
    app.process().stderr?.on("data", keep);
    const storeSentences = (): ReadonlyArray<string> =>
      mainLog
        .join("")
        .split("\n")
        .filter((line) => line.includes("[region-env] "))
        .map((line) => line.slice(line.indexOf("[region-env] ") + "[region-env] ".length).trim());

    const dialog = await openRegionEnvironment(page, INNER.id);
    await settled(dialog);
    const form = await openSourceForm(dialog, "secret");
    await form.getByTestId("region-env-field-name").fill("TEST_TOKEN");
    const value = form.getByTestId("region-env-field-secretValue");
    // fill() only: no key press that could submit the form.
    await value.fill("test-123");
    await form.scrollIntoViewIfNeeded();
    await shot(page, testInfo, "S4", "secret-typed-masked");

    const masking = await value.evaluate((el) => ({
      type: el.getAttribute("type"),
      autocomplete: el.getAttribute("autocomplete"),
      textSecurity: getComputedStyle(el).getPropertyValue("-webkit-text-security"),
    }));
    note(testInfo, "S4-masking", JSON.stringify(masking));
    soft(masking.type, "the value field is a password input").toBe("password");
    soft(masking.autocomplete, "and the browser is told not to remember it").toBe("new-password");
    await soft(form, "the typed secret is not echoed anywhere in the form's text").not.toContainText("test-123");

    // ── HARD GUARD. NOTHING IS SAVED UNTIL BOTH HALVES PASS. ────────────────
    // The screen and the form do not show the store's sentence (it reaches
    // the screen only as the reason of a secret source when no store is
    // usable), so the guard reads it where main says it: its own log.
    // 1. The app itself was started with the switch. Checked first, so a
    //    build without it never even opens a store.
    const forced = await app.evaluate(() => process.env.JUNTO_SECRET_STORE ?? "(unset)");
    expect(
      forced,
      `NOT SAVING: this app runs with JUNTO_SECRET_STORE=${forced}, not "file". A save could write to the real login Keychain.`,
    ).toBe("file");
    // 2. Main's own sentence for the store it opened. A remove of something
    //    that is not a secret id opens the store and touches nothing in it.
    await page.evaluate(() => window.junto!.regionEnvRemoveSecret?.("walk-not-a-secret-id"));
    await expect
      .poll(() => storeSentences().join(" | "), {
        message: `NOT SAVING: main did not say it keeps secrets in "${STORE_SENTENCE}". What it said is below (empty: it said nothing).`,
        timeout: 10_000,
      })
      .toContain(STORE_SENTENCE);
    note(testInfo, "S4-store-sentence", storeSentences().join(" | "));
    soft(await secretFiles(sandbox.homeDir), "no secret file before the save").toEqual(
      (await secretFiles(sandbox.homeDir)).filter((file) => !/^[0-9a-f]{8}-/u.test(file.name)),
    );
    // ── GUARD PASSED ─────────────────────────────────────────────────────────

    await form.getByTestId("region-env-save-source").click();
    await expect(form).toHaveCount(0);

    // The row reads as a secret kept by Junto, and the value is nowhere.
    const row = sourceRows(dialog).first();
    await soft(sourceRows(dialog)).toHaveCount(1);
    await soft(row.locator(".region-env__source-title")).toHaveText("TEST_TOKEN");
    await soft(row.locator(".region-env__source-detail"), "the row").toHaveText("Secret kept by Junto");
    await soft(variable(dialog, "TEST_TOKEN").locator(".region-env__origin")).toHaveText("Secret kept by Junto, this region", {
      timeout: 30_000,
    });
    await settled(dialog);
    await soft(page.locator("body"), "the secret is visible nowhere on the page").not.toContainText("test-123");
    await shot(page, testInfo, "S4", "secret-saved-row");

    // The canvas holds an id, never the value; the store holds a file for it.
    const saved = (await savedEnvironment(page, INNER.id))?.sources?.[0];
    const secretId = saved?.kind === "secret" ? saved.secretId : "";
    soft(saved?.kind, "the saved source").toBe("secret");
    soft(JSON.stringify(saved ?? {}), "the canvas does not hold the value").not.toContain("test-123");
    const onDisk = await secretFiles(sandbox.homeDir);
    note(testInfo, "S4-region-secrets-dir", regionSecretsDir(sandbox.homeDir));
    note(testInfo, "S4-secret-files", JSON.stringify(onDisk));
    const mine = onDisk.filter((file) => secretId !== "" && file.name.startsWith(secretId));
    soft(mine.length, `a file for the secret appeared under region-secrets: ${JSON.stringify(onDisk)}`).toBe(1);
    soft(mine[0]?.mode, "the file is owner-only").toBe("600");
    if (mine[0]) {
      const raw = await readFile(join(regionSecretsDir(sandbox.homeDir), mine[0].name), "utf8").catch(() => "");
      note(testInfo, "S4-file-holds-plain-value", String(raw.includes("test-123")));
    }

    // Edit: an empty value field that says the stored value is kept.
    await dialog.getByRole("button", { name: "Edit TEST_TOKEN" }).click();
    const edit = dialog.getByTestId("region-env-form");
    const editValue = edit.getByTestId("region-env-field-secretValue");
    await soft(editValue, "the value is not sent back to the form").toHaveValue("");
    await soft(editValue).toHaveAttribute("placeholder", "leave empty to keep the stored value");
    await soft(editValue).toHaveAttribute("type", "password");
    await soft(edit.getByTestId("region-env-field-name")).toHaveValue("TEST_TOKEN");
    await soft(page.locator("body"), "still nowhere on the page").not.toContainText("test-123");
    await edit.scrollIntoViewIfNeeded();
    await shot(page, testInfo, "S4", "secret-edit-empty-value");
    await cancelSourceForm(edit);

    // ── S12: clean up ────────────────────────────────────────────────────────
    await row.scrollIntoViewIfNeeded();
    await shot(page, testInfo, "S12", "before-remove");
    await dialog.getByRole("button", { name: "Remove TEST_TOKEN" }).click();
    await soft(sourceRows(dialog), "the row is gone").toHaveCount(0);
    await soft(variable(dialog, "TEST_TOKEN"), "and the name leaves the resolved list").toHaveCount(0, { timeout: 30_000 });
    await soft
      .poll(async () => (await secretFiles(sandbox.homeDir)).filter((file) => /^[0-9a-f]{8}-/u.test(file.name)).map((file) => file.name), {
        message: "removing a source preserves the stored secret for other references",
        timeout: 15_000,
      })
      .toEqual(mine.map((file) => file.name));
    note(testInfo, "S12-files-after-remove", JSON.stringify(await secretFiles(sandbox.homeDir)));
    soft(await savedEnvironment(page, INNER.id), "the canvas has no environment left for the region").toBeUndefined();
    await settled(dialog);
    await shot(page, testInfo, "S12", "after-remove");
  });
});

test("S5 command: arguments show as chips, and an unclosed quote is refused in words", async ({}, testInfo) => {
  test.setTimeout(180_000);
  await walk(testInfo, "S5", walkDoc(), async ({ page }) => {
    const dialog = await openRegionEnvironment(page, INNER.id);
    await settled(dialog);
    const form = await openSourceForm(dialog, "command");
    await form.getByTestId("region-env-field-name").fill("X");
    const command = form.getByTestId("region-env-field-argv");

    await command.fill('echo "two words" three');
    await form.scrollIntoViewIfNeeded();
    await shot(page, testInfo, "S5", "three-chips");
    await soft(form.getByTestId("region-env-arg"), "one chip per argument").toHaveText(["echo", "two words", "three"]);
    await soft(form.getByTestId("region-env-argv")).toContainText("Runs as");

    // Delete the closing quote.
    await command.fill('echo "two words three');
    await form.scrollIntoViewIfNeeded();
    await shot(page, testInfo, "S5", "unclosed-quote");
    const problem = form.locator(".region-env__error").filter({ hasText: "quote" });
    await soft(problem, "the red line").toHaveText("A double quote is opened and never closed.");
    await soft(form.getByTestId("region-env-arg"), "no chips for a command that cannot be read").toHaveCount(0);
    note(
      testInfo,
      "S5-error-colour",
      await problem
        .first()
        .evaluate((el) => getComputedStyle(el).color)
        .catch(() => "no error line"),
    );

    // Save does nothing.
    const before = await sourceRows(dialog).count();
    await form.getByTestId("region-env-save-source").click();
    await page.waitForTimeout(500);
    await shot(page, testInfo, "S5", "save-refused");
    await soft(sourceRows(dialog), "the source list did not change").toHaveCount(before);
    await soft(form, "the form is still open").toBeVisible();
    await soft(form.locator(".region-env__error").filter({ hasText: "quote" })).toHaveText("A double quote is opened and never closed.");
    soft(await savedEnvironment(page, INNER.id), "nothing was saved").toBeUndefined();
  });
});

test("S6 pickers: browse a folder for an env file, and use a folder for Folders", async ({}, testInfo) => {
  test.setTimeout(240_000);
  // The picker starts where the field already points (PathBrowser.tsx
  // browseStart): an empty field starts at home, so the walk types a path in
  // the temp folder first and never lists a home folder.
  const dir = await mkdtemp(join(tmpdir(), "junto-env-walk-"));
  try {
    await mkdir(join(dir, "configs"));
    await writeFile(join(dir, "configs", "inner.env"), "INNER=1\n", "utf8");
    await writeFile(join(dir, "notes.txt"), "a normal file\n", "utf8");
    await writeFile(join(dir, ".env"), "DOTTED=1\n", "utf8");

    await walk(testInfo, "S6", walkDoc(), async ({ page }) => {
      const dialog = await openRegionEnvironment(page, INNER.id);
      await settled(dialog);

      // --- an env file -----------------------------------------------------
      const form = await openSourceForm(dialog, "envFile");
      const field = form.getByTestId("region-env-field-path");
      await field.fill(join(dir, "pick-one"));
      await form.getByTestId("region-env-browse-path").click();
      const browser = form.getByTestId("region-env-browser");
      await expect(browser).toBeVisible();
      const entries = browser.getByTestId("region-env-browser-entry");
      await expect(entries.first()).toBeVisible({ timeout: 15_000 });
      await browser.scrollIntoViewIfNeeded();
      await shot(page, testInfo, "S6", "file-browser-temp-folder");

      const root = browser.getByTestId("region-env-browser-root");
      await soft(root, "the picker opened on the temp folder").toContainText(basename(dir));
      await soft(browser).toHaveAttribute("data-mode", "file");
      const listing = await entries.evaluateAll((buttons) =>
        buttons.map((button) => ({ kind: button.getAttribute("data-kind"), name: (button.textContent ?? "").trim() })),
      );
      note(testInfo, "S6-listing", JSON.stringify(listing));
      note(testInfo, "S6-dot-env-listed", String(listing.some((entry) => entry.name === ".env")));
      const kinds = listing.map((entry) => entry.kind);
      soft(kinds, "folders first").toEqual([...kinds].sort((a, b) => (a === b ? 0 : a === "directory" ? -1 : 1)));
      soft(listing.map((entry) => entry.name), "the folder and the normal file are listed").toEqual(
        expect.arrayContaining(["configs", "notes.txt"]),
      );

      // Clicking a folder opens it.
      await entries.filter({ hasText: "configs" }).click();
      await soft(root, "clicking a folder opens it").toContainText("configs", { timeout: 15_000 });
      await soft(entries, "the subfolder's one file").toHaveText(["inner.env"]);
      await shot(page, testInfo, "S6", "file-browser-subfolder");

      // Up, then clicking a file fills the field and closes the picker.
      await browser.getByRole("button", { name: "Up one folder" }).click();
      await expect(entries.filter({ hasText: "notes.txt" })).toBeVisible({ timeout: 15_000 });
      await entries.filter({ hasText: "notes.txt" }).click();
      await soft(field, "clicking a file fills the field").toHaveValue(/\/notes\.txt$/u);
      await soft(browser, "and the picker closes").toHaveCount(0);
      await form.scrollIntoViewIfNeeded();
      await shot(page, testInfo, "S6", "file-picked");
      await cancelSourceForm(form);

      // --- Folders ---------------------------------------------------------
      const folders = dialog.locator('section[aria-label="Folders"]');
      await folders.scrollIntoViewIfNeeded();
      await folders.getByTestId("region-env-folder-input").fill(dir);
      await folders.getByTestId("region-env-browse-folder").click();
      const folderBrowser = folders.getByTestId("region-env-browser");
      await expect(folderBrowser).toBeVisible();
      const folderEntries = folderBrowser.getByTestId("region-env-browser-entry");
      await expect(folderEntries.first()).toBeVisible({ timeout: 15_000 });
      await folderBrowser.scrollIntoViewIfNeeded();
      await shot(page, testInfo, "S6", "folder-browser-temp-folder");
      await soft(folderBrowser).toHaveAttribute("data-mode", "directory");
      await soft(folderEntries, "a folder picker lists folders only").toHaveText(["configs"]);

      await folderEntries.filter({ hasText: "configs" }).click();
      const folderRoot = folderBrowser.getByTestId("region-env-browser-root");
      await soft(folderRoot).toContainText("configs", { timeout: 15_000 });
      await shot(page, testInfo, "S6", "folder-browser-subfolder");
      await folderBrowser.getByTestId("region-env-browser-use").click();

      const added = folders.getByTestId("region-env-folder");
      await soft(added, "the folder is added to the list").toHaveCount(1);
      await soft(added.first()).toContainText(join(basename(dir), "configs"));
      await soft(folderBrowser, "the picker closes").toHaveCount(0);
      await soft(folders.getByTestId("region-env-folder-input"), "the field is emptied").toHaveValue("");
      await folders.scrollIntoViewIfNeeded();
      await shot(page, testInfo, "S6", "folder-added");
      await soft
        .poll(async () => (await savedEnvironment(page, INNER.id))?.folders?.length ?? 0, { message: "the folder is saved", timeout: 15_000 })
        .toBe(1);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S7 order: a drag and the arrows reorder sources, and the order survives closing the screen", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const seeded = [plainValue("src-one", "ONE", "1"), plainValue("src-two", "TWO", "2"), plainValue("src-three", "THREE", "3")];
  await walk(testInfo, "S7", walkDoc(seeded), async ({ page }) => {
    let dialog = await openRegionEnvironment(page, INNER.id);
    await settled(dialog);
    soft(await sourceTitles(dialog), "the order to start with").toEqual(["ONE", "TWO", "THREE"]);
    await shot(page, testInfo, "S7", "order-before");

    // Drag ONE onto THREE: it lands in THREE's place.
    const rows = sourceRows(dialog);
    await rows.nth(0).dragTo(rows.nth(2)).catch(() => undefined);
    let mechanism = "pointer drag (locator.dragTo)";
    if ((await sourceTitles(dialog)).join() === "ONE,TWO,THREE") {
      // The pointer drag did not start a native drag: send the same drag
      // events the row listens for.
      mechanism = "dispatched dragstart, dragover, drop";
      const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
      await rows.nth(0).dispatchEvent("dragstart", { dataTransfer });
      await rows.nth(2).dispatchEvent("dragover", { dataTransfer });
      await rows.nth(2).dispatchEvent("drop", { dataTransfer });
      await rows.nth(2).dispatchEvent("dragend", { dataTransfer });
    }
    note(testInfo, "S7-drag-mechanism", mechanism);
    await soft.poll(() => sourceTitles(dialog), { message: "after dragging ONE onto THREE", timeout: 5_000 }).toEqual(["TWO", "THREE", "ONE"]);
    await settled(dialog);
    await shot(page, testInfo, "S7", "order-after-drag");

    // The arrows: ONE up one place, then TWO down one place.
    const afterDrag = await sourceTitles(dialog);
    await dialog.getByRole("button", { name: "Move ONE up" }).click();
    await dialog.getByRole("button", { name: "Move TWO down" }).click();
    const expected = ((): ReadonlyArray<string> => {
      const order = [...afterDrag];
      const swap = (name: string, by: number): void => {
        const at = order.indexOf(name);
        const to = at + by;
        if (at < 0 || to < 0 || to >= order.length) return;
        [order[at], order[to]] = [order[to]!, order[at]!];
      };
      swap("ONE", -1);
      swap("TWO", 1);
      return order;
    })();
    await soft.poll(() => sourceTitles(dialog), { message: "after the arrows", timeout: 5_000 }).toEqual(expected);
    soft(expected, "the arrows changed the order").not.toEqual(afterDrag);
    await soft(dialog.getByRole("button", { name: `Move ${expected[0]!} up` }), "the top row cannot go up").toBeDisabled();
    await soft(dialog.getByRole("button", { name: `Move ${expected.at(-1)!} down` }), "the bottom row cannot go down").toBeDisabled();
    await settled(dialog);
    await shot(page, testInfo, "S7", "order-after-arrows");

    // Close, reopen: the same order, on the screen and in the canvas.
    await closeRegionEnvironment(dialog);
    dialog = await openRegionEnvironment(page, INNER.id);
    await settled(dialog);
    soft(await sourceTitles(dialog), "the order after closing and reopening").toEqual(expected);
    soft(
      ((await savedEnvironment(page, INNER.id))?.sources ?? []).map((source) => ("name" in source ? source.name : source.id)),
      "the order saved in the canvas",
    ).toEqual(expected);
    await shot(page, testInfo, "S7", "order-after-reopen");
  });
});

test("S8 inheritance: an outer name is inherited, an inner one overrides it, and Sealed cuts it off", async ({}, testInfo) => {
  test.setTimeout(240_000);
  await walk(testInfo, "S8", walkDoc(), async ({ page }) => {
    // ORG = x on the outer region.
    const outer = await openRegionEnvironment(page, OUTER.id);
    await settled(outer);
    await addSource(outer, "value", { name: "ORG", value: "x" });
    await soft(variable(outer, "ORG").locator(".region-env__origin")).toHaveText("Plain value, this region", { timeout: 30_000 });
    await settled(outer);
    await shot(page, testInfo, "S8", "outer-has-org");
    await closeRegionEnvironment(outer);

    // The inner region inherits it.
    const dialog = await openRegionEnvironment(page, INNER.id);
    const org = variable(dialog, "ORG");
    await soft(org.locator(".region-env__origin"), "ORG on the inner region").toHaveText(`Plain value, inherited from ${OUTER.label}`, {
      timeout: 30_000,
    });
    await soft(org.locator(".region-env__origin")).toHaveAttribute("data-inherited", "true");
    // The chip is a second "inherited", after the origin's own.
    await soft(org.locator(".region-env__variable-head"), "the inherited chip").toHaveText(/inherited from .*inherited$/u);
    await soft(sourceRows(dialog), "the inner region has no source of its own").toHaveCount(0);
    await settled(dialog);
    await resolved(dialog).scrollIntoViewIfNeeded();
    await shot(page, testInfo, "S8", "inner-inherits-org");

    // ORG on the inner region too: the outer one is struck through.
    await addSource(dialog, "value", { name: "ORG", value: "y" });
    await soft(org.locator(".region-env__origin"), "ORG now comes from the inner region").toHaveText("Plain value, this region", {
      timeout: 30_000,
    });
    const struck = org.locator(".region-env__overridden s");
    await soft(struck, "the outer ORG, struck through").toHaveText(`Plain value, inherited from ${OUTER.label}`);
    await soft(org.locator(".region-env__overridden")).toContainText("overridden");
    soft(
      await struck
        .first()
        .evaluate((el) => getComputedStyle(el).textDecorationLine)
        .catch(() => "no struck line"),
      "it is drawn struck through",
    ).toContain("line-through");
    await settled(dialog);
    await resolved(dialog).scrollIntoViewIfNeeded();
    await shot(page, testInfo, "S8", "inner-overrides-outer");

    // Sealed: the outer ORG is gone.
    const sealed = dialog.getByTestId("region-env-sealed");
    await sealed.scrollIntoViewIfNeeded();
    await sealed.click();
    await soft(sealed).toBeChecked();
    await soft(org.locator(".region-env__overridden"), "the outer ORG disappears once sealed").toHaveCount(0, { timeout: 30_000 });
    await soft(org.locator(".region-env__origin")).toHaveText("Plain value, this region");
    await soft(dialog.locator('section[aria-label="Sealed"]')).toContainText(
      "Seats in this region get only what is listed here. Nothing comes in from the regions around it.",
    );
    await settled(dialog);
    await shot(page, testInfo, "S8", "sealed-switch-on");
    await resolved(dialog).scrollIntoViewIfNeeded();
    await shot(page, testInfo, "S8", "sealed-resolved-list");
  });
});

test("S9 errors [fake-tui]: a missing Keychain item reads red with a reason, the seat still starts, and Required blocks the region", async ({}, testInfo) => {
  test.setTimeout(300_000);
  // Made up, and looked up only: a read that finds nothing.
  const item = `junto-e2e-no-such-item-${Math.random().toString(36).slice(2, 10)}`;
  await walk(testInfo, "S9", walkDoc(), async ({ page, sandbox }) => {
    await crewPlayFactory(page);
    const dialog = await openRegionEnvironment(page, INNER.id);
    await settled(dialog);

    const form = await openSourceForm(dialog, "keychain");
    await form.getByTestId("region-env-field-name").fill("WALK_MISSING");
    await form.getByTestId("region-env-field-service").fill(item);
    await form.scrollIntoViewIfNeeded();
    await soft(form.getByTestId("region-env-lookup"), "the lookup hint").toHaveText(
      `Looks for the Keychain item named "${item}", whatever its account.`,
    );
    await shot(page, testInfo, "S9", "keychain-form");
    await form.getByTestId("region-env-save-source").click();
    await expect(form).toHaveCount(0);

    // Red on the row, with a reason in plain words, status Missing.
    const row = sourceRows(dialog).first();
    const rowReason = row.locator(".region-env__error");
    await soft(rowReason, "red text on the source's row").toBeVisible({ timeout: 30_000 });
    await settled(dialog);
    const reason = ((await rowReason.textContent().catch(() => "")) ?? "").trim();
    note(testInfo, "S9-reason", reason);
    note(
      testInfo,
      "S9-reason-colour",
      await rowReason
        .first()
        .evaluate((el) => getComputedStyle(el).color)
        .catch(() => "no reason line"),
    );
    soft(reason, "the reason is plain words").toMatch(/\w+ \w+/u);
    soft(reason, "the reason names the item").toContain(item);
    await soft(row, "status Missing").toContainText("Missing");
    await shot(page, testInfo, "S9", "missing-on-row");

    // Red under its variable too.
    const missing = variable(dialog, "WALK_MISSING");
    await soft(missing, "the variable is listed as not set").toContainText("not set");
    await soft(missing.locator("p.region-env__error"), "red text under the variable").toContainText(reason);
    await soft(dialog.getByTestId("region-env-blocks-launch"), "not required: no banner").toHaveCount(0);
    await resolved(dialog).scrollIntoViewIfNeeded();
    await shot(page, testInfo, "S9", "missing-under-variable");

    // Not required, so the seat still starts.
    const seat = crewSeat(sandbox, CANVAS, SEAT.id);
    const ready = await crewOccupySeat(page, CANVAS, SEAT, seat).catch((error: unknown) => String(error));
    soft(typeof ready === "string" ? ready : "started", "the seat still starts with a missing source that is not required").toBe("started");
    await shot(page, testInfo, "S9", "seat-started");

    // Mark it Required.
    await dialog.getByRole("button", { name: "Edit WALK_MISSING" }).click();
    const edit = dialog.getByTestId("region-env-form");
    const required = edit.getByRole("switch", { name: "Required" });
    await required.click();
    await expect(required).toBeChecked();
    await edit.scrollIntoViewIfNeeded();
    await shot(page, testInfo, "S9", "edit-required-on");
    await edit.getByTestId("region-env-save-source").click();
    await expect(edit).toHaveCount(0);

    const banner = dialog.getByTestId("region-env-blocks-launch");
    await soft(banner, "the red banner").toHaveText(
      "A required source is failing, so seats in this region will not start until it is fixed.",
      { timeout: 30_000 },
    );
    await soft(sourceRows(dialog).first(), "the row is marked required").toContainText("required");
    note(
      testInfo,
      "S9-banner-colour",
      await banner
        .first()
        .evaluate((el) => getComputedStyle(el).color)
        .catch(() => "no banner"),
    );
    await settled(dialog);
    await shot(page, testInfo, "S9", "required-row");
    await resolved(dialog).scrollIntoViewIfNeeded();
    await shot(page, testInfo, "S9", "required-banner");
  });
});

test("S10 restart to apply [fake-tui]: changing a source lists the running seat, and restart keeps its session", async ({}, testInfo) => {
  test.setTimeout(300_000);
  await walk(testInfo, "S10", walkDoc([plainValue("src-stage", "STAGE", "one")]), async ({ page, sandbox }) => {
    await crewPlayFactory(page);
    const seat = crewSeat(sandbox, CANVAS, SEAT.id);
    const started = await crewOccupySeat(page, CANVAS, SEAT, seat);
    const sessionNow = async (): Promise<unknown> =>
      (opData(await seat.op("onboard", {})).sessions as { readonly current?: { readonly session_id?: unknown } } | undefined)?.current
        ?.session_id;
    soft(await sessionNow(), "the session the seat starts on").toBe(SESSION);

    const dialog = await openRegionEnvironment(page, INNER.id);
    await settled(dialog);
    const stale = dialog.getByTestId("region-env-stale");
    await soft(stale, "nothing to restart before the change").toHaveCount(0);
    await shot(page, testInfo, "S10", "before-change");

    // Change the source while the seat runs.
    await dialog.getByRole("button", { name: "Edit STAGE" }).click();
    const form = dialog.getByTestId("region-env-form");
    await form.getByTestId("region-env-field-value").fill("two");
    await form.scrollIntoViewIfNeeded();
    await shot(page, testInfo, "S10", "editing-source");
    await form.getByTestId("region-env-save-source").click();
    await expect(form).toHaveCount(0);

    await soft(stale.getByRole("heading", { name: "Restart to apply" }), "the Restart to apply section").toBeVisible({ timeout: 30_000 });
    await soft(stale, "it lists the seat").toContainText("Worker");
    await soft(stale, "and what changes").toContainText("Changes on restart: STAGE");
    await soft(stale).toContainText("A running seat keeps the environment it started with. These started before the last change.");
    await settled(dialog);
    await stale.scrollIntoViewIfNeeded().catch(() => undefined);
    await shot(page, testInfo, "S10", "restart-to-apply");

    // Restart: a new process, the same session, and the seat leaves the list.
    await stale.getByTestId("region-env-restart").click();
    await shot(page, testInfo, "S10", "restarting");
    await soft
      .poll(async () => (await seat.ready()).pid !== started.pid, { message: "the seat process was replaced", timeout: 90_000 })
      .toBe(true);
    await soft(stale, "the seat leaves the list").toHaveCount(0, { timeout: 30_000 });
    await soft.poll(sessionNow, { message: "the session after the restart", timeout: 30_000 }).toBe(SESSION);
    const doc = (await page.evaluate(async (name) => (await window.junto!.readCanvas(name)).doc, CANVAS)) as CanvasDoc;
    soft(doc.nodes.find((node) => node.id === SEAT.id)?.ether?.terminal?.sessionId, "the seat's stored session id").toBe(SESSION);
    note(testInfo, "S10-restart-argv", JSON.stringify((await seat.ready()).argv));
    await soft(dialog.locator(".region-env__error"), "no restart problem is shown").toHaveCount(0);
    await settled(dialog);
    await shot(page, testInfo, "S10", "after-restart");
  });
});

// ---------------------------------------------------------------------------
// S11: quit and relaunch on the same sandbox
// ---------------------------------------------------------------------------

/**
 * The harness has no relaunch: launchJunto always makes a new sandbox, and
 * its close() deletes it. So this step quits the first app itself and starts
 * a second Electron by hand on the same sandbox, with the environment the
 * first one ran with (sandbox HOME, restricted PATH, the renderer server
 * launchJunto started and still serves until close()) and the same arguments
 * launch.ts passes. The harness's close() then deletes the sandbox as usual.
 */
const relaunchOnSameSandbox = async (junto: JuntoHandle): Promise<ElectronApplication> => {
  const env = await junto.app.evaluate(() => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") out[key] = value;
    return out;
  });
  // Quit, as quit-bound.spec.ts does, and wait for the process to be gone.
  const child = junto.app.process();
  const gone = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  await junto.app.close();
  await gone;
  return electron.launch({
    executablePath: createRequire(import.meta.url)("electron") as string,
    args: [process.cwd(), `--user-data-dir=${junto.sandbox.userDataDir}`, "--mute-audio"],
    env,
    timeout: 60_000,
  });
};

test("S11 persistence: sources, order, sealed and folders are as left after a quit and relaunch", async ({}, testInfo) => {
  test.setTimeout(360_000);
  const dir = await mkdtemp(join(tmpdir(), "junto-env-walk-"));
  const junto = await launchJunto({ seedCanvases: { [CANVAS]: walkDoc() }, afterSeed: installCrewSeatHarness });
  let second: ElectronApplication | undefined;
  let page = junto.page;
  try {
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await forceDark(page);

    // Set it up through the screen: three sources, a changed order, sealed, a folder.
    let dialog = await openRegionEnvironment(page, INNER.id);
    await settled(dialog);
    await addSource(dialog, "value", { name: "FIRST", value: "1" });
    await addSource(dialog, "value", { name: "SECOND", value: "2" });
    await addSource(dialog, "value", { name: "THIRD", value: "3" });
    await dialog.getByRole("button", { name: "Move THIRD up" }).click();
    const sealed = dialog.getByTestId("region-env-sealed");
    await sealed.scrollIntoViewIfNeeded();
    await sealed.click();
    await expect(sealed).toBeChecked();
    const folders = dialog.locator('section[aria-label="Folders"]');
    await folders.getByTestId("region-env-folder-input").fill(dir);
    await folders.getByRole("button", { name: "add folder" }).click();
    await expect(folders.getByTestId("region-env-folder")).toHaveCount(1);
    await settled(dialog);
    const orderLeft = await sourceTitles(dialog);
    soft(orderLeft, "the order as left").toEqual(["FIRST", "THIRD", "SECOND"]);
    await shot(page, testInfo, "S11", "before-quit-sources");
    await folders.scrollIntoViewIfNeeded();
    await shot(page, testInfo, "S11", "before-quit-sealed-and-folders");
    await closeRegionEnvironment(dialog);

    // Saved before the quit: the canvas holds all of it.
    await expect
      .poll(
        async () => {
          const saved = await savedEnvironment(page, INNER.id);
          return { sources: saved?.sources?.length ?? 0, sealed: saved?.sealed === true, folders: saved?.folders?.length ?? 0 };
        },
        { message: "the environment is saved before the quit", timeout: 20_000 },
      )
      .toEqual({ sources: 3, sealed: true, folders: 1 });
    const left = await savedEnvironment(page, INNER.id);
    note(testInfo, "S11-left", JSON.stringify(left));

    // Quit, and start again on the same sandbox.
    second = await relaunchOnSameSandbox(junto);
    page = await second.firstWindow();
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 60_000 });
    await page.waitForFunction(() => Boolean(window.junto?.settingsPatch), undefined, { timeout: 30_000 });
    await forceDark(page);
    await shot(page, testInfo, "S11", "after-relaunch-canvas");

    soft(await savedEnvironment(page, INNER.id), "the saved environment after the relaunch").toEqual(left);

    dialog = await openRegionEnvironment(page, INNER.id);
    await settled(dialog);
    soft(await sourceTitles(dialog), "sources and their order after the relaunch").toEqual(orderLeft);
    await soft(dialog.getByTestId("region-env-sealed"), "sealed after the relaunch").toBeChecked();
    const foldersAgain = dialog.locator('section[aria-label="Folders"]').getByTestId("region-env-folder");
    await soft(foldersAgain, "folders after the relaunch").toHaveCount(1);
    await soft(foldersAgain.first()).toContainText(dir);
    await soft(dialog.getByTestId("region-env-variable"), "the resolved list after the relaunch").toHaveCount(3, { timeout: 30_000 });
    await shot(page, testInfo, "S11", "after-relaunch-sources");
    await dialog.locator('section[aria-label="Folders"]').scrollIntoViewIfNeeded();
    await shot(page, testInfo, "S11", "after-relaunch-sealed-and-folders");
  } catch (error) {
    await shot(page, testInfo, "S11", "on-failure").catch(() => undefined);
    throw error;
  } finally {
    if (second !== undefined) await second.close().catch(() => undefined);
    await junto.close();
    await rm(dir, { recursive: true, force: true });
  }
});
