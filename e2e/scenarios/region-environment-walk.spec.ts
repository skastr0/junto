import { readSeatSession } from "../harness/seat-session";
import { modelFixture, modelSeatSession, modelRegion, modelSeat, readModelCanvas, readModelSeat, type ModelFixture } from "../harness/model";
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
 * the source and verifies that its stored secret remains. The only Keychain
 * call is a lookup of a made-up item that does not
 * exist (S9).
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright-core";
import type { EnvSource, Region, RegionEnvironment } from "../../src/shared/model/region";
import { SOURCE_KINDS } from "../../src/renderer/lib/region-environment";
import {
  crewOccupySeat,
  crewPlayFactory,
  crewSeat,
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
}): Region => modelRegion({
  id: input.id, label: input.label, x: input.x, y: input.y, width: input.width, height: input.height,
  hold: true, ...(input.sources ? { environment: { sources: [...input.sources] } } : {}),
});

const plainValue = (id: string, name: string, value: string): EnvSource => ({ id, kind: "value", name, value });

const OUTER = { id: "org", label: "Org", x: 40, y: 40, width: 700, height: 440 } as const;
const INNER = { id: "team", label: "Team", x: 80, y: 140, width: 440, height: 260 } as const;

/** The one seat inside Team keeps its explicit harness session. */
const SEAT = modelSeat({ id: "worker", key: "local:worker", label: "Worker", x: 120, y: 250 });
const walkFixture = (innerSources?: ReadonlyArray<EnvSource>): ModelFixture =>
  modelFixture([regionNode(OUTER), regionNode({ ...INNER, ...(innerSources ? { sources: innerSources } : {}) }), SEAT], [], [modelSeatSession(SEAT, SESSION)]);

// ---------------------------------------------------------------------------
// Launch, theme, evidence
// ---------------------------------------------------------------------------

const shotsDir = (testInfo: TestInfo): string => process.env.ENV_WALK_SHOTS ?? testInfo.outputPath();

/** Full page, stable name, one folder. */
/** A focus surface fades in over 160 ms (styles.css, focus-surface-enter): a frame taken sooner shows the canvas through it. */
const DIALOG_FADE_MS = 200;

/** Wait out the fade whenever a dialog is up, so no frame catches it half drawn. */
const settleDialogFade = async (page: Page): Promise<void> => {
  if ((await page.locator("[role='dialog']").count()) > 0) await page.waitForTimeout(DIALOG_FADE_MS);
};

const shot = async (page: Page, testInfo: TestInfo, step: string, what: string): Promise<void> => {
  const dir = shotsDir(testInfo);
  await mkdir(dir, { recursive: true });
  await settleDialogFade(page);
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
  fixture: ModelFixture,
  body: (junto: JuntoHandle) => Promise<void>,
): Promise<void> => {
  const junto = await launchJunto({ seedModels: { [CANVAS]: fixture }, afterSeed: installCrewSeatHarness });
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
const savedEnvironment = async (page: Page, regionId: string): Promise<RegionEnvironment | undefined> => {
  const opened = await readModelCanvas(page, CANVAS);
  const region = opened.nodes.find((node) => node.id === regionId);
  return region?.kind === "region" ? region.environment : undefined;
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
  await walk(testInfo, "S1", walkFixture(), async ({ page }) => {
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
    await soft(open).toHaveAttribute("data-junto-tooltip", "Environment and secrets");

    await open.click();
    const dialog = page.getByRole("dialog", { name: "Region environment" });
    await expect(dialog.getByTestId("region-env")).toBeVisible();
    await settled(dialog);
    await shot(page, testInfo, "S1", "panel-open");

    await soft(dialog.locator("header").first(), "the panel's title").toContainText("Environment and secrets");
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

test("SH bottom bar: the region's Environment key", async ({}, testInfo) => {
  test.setTimeout(180_000);
  // Two regions side by side: one with nothing set, one that already has a source.
  const BARE = { id: "bare", label: "Bare", x: 40, y: 60, width: 420, height: 260 } as const;
  const STOCKED = { id: "stocked", label: "Stocked", x: 520, y: 60, width: 420, height: 260 } as const;
  const doc = modelFixture([regionNode(BARE), regionNode({ ...STOCKED, sources: [plainValue("src-org", "ORG", "x")] })]);
  // The key's name, and the toolbar key's tooltip. The strip key's own tooltip adds its state (RegionKey.tsx).
  const TOOLTIP = "Environment and secrets";
  const TOOLTIP_UNSET = `${TOOLTIP}: none yet`;
  const TOOLTIP_SET = `${TOOLTIP}: set`;

  await walk(testInfo, "SH", doc, async ({ page }) => {
    // 1. Select a region: under REGION in the bottom bar's middle section, the key sits right after folder paths.
    await selectRegion(page, BARE.id);
    const strip = page.getByRole("toolbar", { name: "Region fields" });
    const key = page.getByTestId("rts-region-environment");
    await expect(key, "the bottom bar shows the region's Environment key").toBeVisible({ timeout: 10_000 });
    await shot(page, testInfo, "SH", "1-bottom-bar-region-keys");
    await soft(strip, "the keys sit in the region strip").toBeVisible();
    await soft(page.locator(".rts-kind-surface--region .rts-kind-kind-label"), "the strip is headed REGION").toHaveText("region");
    soft(
      await key.evaluate((el) => {
        const buttons = Array.from(el.closest("[role='toolbar']")?.querySelectorAll("button") ?? []);
        const at = buttons.indexOf(el as HTMLButtonElement);
        return at > 0 ? buttons[at - 1]!.getAttribute("aria-label") : null;
      }),
      "the key sits right after the folder paths key",
    ).toBe("Folder paths");
    soft((await key.locator("svg").first().getAttribute("class")) ?? "", "its icon is the key").toContain("key");
    await soft(key, "its tooltip").toHaveAttribute("data-junto-tooltip", TOOLTIP_UNSET);
    await soft(key, "its name").toHaveAttribute("aria-label", TOOLTIP);
    await soft(key, "it says nothing is set").toHaveAttribute("data-state", "unset");
    await soft(key, "it is not pressed: its screen is closed").toHaveAttribute("aria-pressed", "false");
    await key.hover();
    await soft(page.locator(".junto-tooltip[data-positioned='true']"), "hovering it shows the tooltip").toHaveText(TOOLTIP_UNSET);
    await shot(page, testInfo, "SH", "1-key-hovered");

    // 2. Press it: the same dialog the toolbar key opens, for the selected region.
    await key.click();
    const dialog = page.getByRole("dialog", { name: "Region environment" });
    await expect(dialog.getByTestId("region-env")).toBeVisible();
    await settled(dialog);
    await soft(dialog, "one Environment dialog").toHaveCount(1);
    await soft(dialog.locator("header").first(), "the dialog is the selected region's").toContainText(`What seats inside ${BARE.label} get when they start`);
    await soft(key, "the key is pressed while its dialog is open").toHaveAttribute("aria-pressed", "true");
    await soft(key, "its name does not change while open").toHaveAttribute("aria-label", TOOLTIP);
    await shot(page, testInfo, "SH", "2-dialog-open-from-the-bottom-bar");
    await closeRegionEnvironment(dialog);
    await soft(key, "after done the key is no longer pressed").toHaveAttribute("aria-pressed", "false");
    await soft(key).toHaveAttribute("aria-label", TOOLTIP);
    await shot(page, testInfo, "SH", "2-closed-key-released");

    // 3. The toolbar key above the selected region carries the same words.
    const above = environmentButton(page);
    await expect(above).toBeVisible({ timeout: 10_000 });
    await soft(above, "the toolbar key above a region with nothing set").toHaveAttribute("data-junto-tooltip", TOOLTIP);
    await soft(above).toHaveAttribute("aria-label", "Region environment");
    await above.hover();
    await soft(page.locator(".junto-tooltip[data-positioned='true']"), "hovering the toolbar key").toHaveText(TOOLTIP);
    await shot(page, testInfo, "SH", "3-toolbar-key-nothing-set");

    // And "(set)" on a region that already has a source.
    await selectRegion(page, STOCKED.id);
    const aboveSet = environmentButton(page);
    await expect(aboveSet).toBeVisible({ timeout: 10_000 });
    await soft(aboveSet, "the toolbar key above a region that has a source").toHaveAttribute("data-junto-tooltip", `${TOOLTIP} (set)`);
    await soft(aboveSet).toHaveAttribute("aria-label", "Region environment (set)");
    await aboveSet.hover();
    await soft(page.locator(".junto-tooltip[data-positioned='true']"), "hovering it").toHaveText(`${TOOLTIP} (set)`);
    await shot(page, testInfo, "SH", "3-toolbar-key-set");
    // Set and pressed are two things: a region with a source reads "set", and is pressed only while its screen is open.
    await soft(key, "the bottom bar key of a region with a source reads as set").toHaveAttribute("data-state", "set");
    await soft(key, "and is not pressed while its screen is closed").toHaveAttribute("aria-pressed", "false");
    await soft(key, "its tooltip says set").toHaveAttribute("data-junto-tooltip", TOOLTIP_SET);
    await key.click();
    const stocked = page.getByRole("dialog", { name: "Region environment" });
    await expect(stocked.getByTestId("region-env")).toBeVisible();
    await soft(stocked.locator("header").first(), "the dialog follows the selection").toContainText(`What seats inside ${STOCKED.label} get when they start`);
    await soft(sourceRows(stocked), "and lists that region's source").toHaveCount(1);
    await shot(page, testInfo, "SH", "3-dialog-for-the-region-with-a-source");
    await closeRegionEnvironment(stocked);
  });
});

// ---------------------------------------------------------------------------
// SI and SJ: walks judged by eye. The frames are the deliverable; the checks
// are soft and only record what the eye should confirm.
// ---------------------------------------------------------------------------

/** The bottom bar's middle section (RtsBottomBar.tsx: `.rts-panel__body.rts-mid-body`). */
const MID = ".rts-mid-body";

/** A tight crop of the bottom bar's middle section, with 8 px of margin. */
const cropStrip = async (page: Page, testInfo: TestInfo, step: string, what: string): Promise<void> => {
  const box = await page.locator(MID).first().boundingBox().catch(() => null);
  if (box === null) {
    note(testInfo, `${step}-${what}`, "no crop: the bottom bar's middle section has no box");
    return;
  }
  const dir = shotsDir(testInfo);
  await mkdir(dir, { recursive: true });
  await settleDialogFade(page);
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const x = Math.max(0, box.x - 8);
  const y = Math.max(0, box.y - 8);
  await page.screenshot({
    path: join(dir, `${step}-${what}.png`),
    clip: { x, y, width: Math.min(viewport.width - x, box.width + 16), height: Math.min(viewport.height - y, box.height + 16) },
  });
};

type KeyFacts = {
  readonly name: string | null;
  readonly tooltip: string | null;
  readonly caption: string;
  readonly state: string;
  readonly icon: string;
  readonly width: number;
  readonly height: number;
  readonly pressed: string | null;
  readonly dataState: string | null;
  readonly captionOneLine: boolean;
  readonly stateOneLine: boolean;
  readonly clipped: boolean;
  readonly iconColor: string;
  readonly stateColor: string;
  readonly borderColor: string;
  readonly background: string;
  readonly outline: string;
  readonly boxShadow: string;
  readonly focused: boolean;
};

/** Every key of the region strip, as it is drawn right now. */
const stripKeys = (page: Page): Promise<ReadonlyArray<KeyFacts>> =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".rts-region-keys .rts-region-key")).map((key) => {
      const caption = key.querySelector<HTMLElement>(".rts-region-key__caption");
      const state = key.querySelector<HTMLElement>(".rts-region-key__state");
      const icon = key.querySelector<HTMLElement>(".rts-region-key__icon");
      const box = key.getBoundingClientRect();
      const style = getComputedStyle(key);
      const oneLine = (el: HTMLElement | null): boolean => {
        if (el === null) return false;
        const line = Number.parseFloat(getComputedStyle(el).lineHeight) || Number.parseFloat(getComputedStyle(el).fontSize) * 1.2;
        return el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().height <= line * 1.5;
      };
      return {
        name: key.getAttribute("aria-label"),
        tooltip: key.getAttribute("data-junto-tooltip") ?? key.getAttribute("title"),
        caption: (caption?.textContent ?? "").trim(),
        state: (state?.textContent ?? "").trim(),
        icon: icon?.querySelector("svg")?.getAttribute("class") ?? "",
        width: Math.round(box.width * 10) / 10,
        height: Math.round(box.height * 10) / 10,
        pressed: key.getAttribute("aria-pressed"),
        dataState: key.getAttribute("data-state"),
        captionOneLine: oneLine(caption),
        stateOneLine: oneLine(state),
        clipped: key.scrollWidth > key.clientWidth + 1 || key.scrollHeight > key.clientHeight + 1,
        iconColor: icon ? getComputedStyle(icon).color : "",
        stateColor: state ? getComputedStyle(state).color : "",
        borderColor: style.borderTopColor,
        background: style.backgroundColor,
        outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor} offset ${style.outlineOffset}`,
        boxShadow: style.boxShadow,
        focused: document.activeElement === key,
      };
    }),
  );

/** The theme's amber and greys as computed, so the recorded colours can be read against them. */
const themeColours = (page: Page): Promise<Record<string, string>> =>
  page.evaluate(() => {
    const out: Record<string, string> = {};
    const probe = document.createElement("span");
    document.body.append(probe);
    for (const name of ["--color-amber", "--color-faint", "--color-dim", "--color-ink", "--color-crimson"]) {
      probe.style.color = `var(${name})`;
      out[name] = getComputedStyle(probe).color;
    }
    probe.remove();
    return out;
  });

const KEY_ORDER = ["Briefing", "Folder paths", "Environment"] as const;
const KEY_NAMES = ["Region briefing", "Folder paths", "Environment and secrets"] as const;

test("SI region strip keys, by eye: three labelled keys, their hover, pressed, set and focus looks", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const PLAIN = { id: "plain", label: "Plain", x: 40, y: 60, width: 420, height: 260 } as const;
  const FULL = { id: "full", label: "Full", x: 520, y: 60, width: 420, height: 260 } as const;
  // Seed the region's briefing, folder paths and environment independently.
  const full = modelRegion({
    ...regionNode(FULL),
    instruction: "Keep the build green and say when it is not.",
    defaults: { paths: { local: "/tmp/junto-region-walk" } },
    environment: { sources: [plainValue("src-org", "ORG", "x")] },
  });
  const tooltip = (page: Page): Locator => page.locator(".junto-tooltip[data-positioned='true']");

  await walk(testInfo, "SI", modelFixture([regionNode(PLAIN), full]), async ({ page }) => {
    const colours = await themeColours(page);
    const keys = page.locator(".rts-region-keys .rts-region-key");

    // ── I1: an empty region ────────────────────────────────────────────────
    await selectRegion(page, PLAIN.id);
    await expect(keys.first(), "the region strip shows its keys").toBeVisible({ timeout: 10_000 });
    await page.mouse.move(4, 4);
    await shot(page, testInfo, "SI", "I1-empty-region");
    await cropStrip(page, testInfo, "SI", "I1-strip-crop");
    const i1 = await stripKeys(page);
    note(testInfo, "SI-I1", JSON.stringify({ label: await page.locator(".rts-kind-surface--region .rts-kind-kind-label").textContent().catch(() => null), colours, keys: i1 }));
    soft(i1.slice(0, 3).map((key) => key.caption), "I1: three keys, left to right").toEqual([...KEY_ORDER]);
    soft(i1.length === 3 || i1.length === 4, `I1: three keys, or four with Page defaults (${String(i1.length)})`).toBe(true);
    soft(i1.map((key) => key.state), "I1: each says none yet").toEqual(i1.map(() => "none yet"));
    soft(i1.map((key) => key.pressed), "I1: no key is pressed").toEqual(i1.map(() => "false"));
    soft(i1.map((key) => key.dataState), "I1: no key reads set").toEqual(i1.map(() => "unset"));
    for (const key of i1) {
      soft(key.width, `I1: ${key.caption} is about 96 px wide`).toBeGreaterThanOrEqual(96);
      soft(key.width, `I1: ${key.caption} is not much wider than 96 px`).toBeLessThan(140);
      soft(key.captionOneLine && key.stateOneLine && !key.clipped, `I1: ${key.caption} fits on one line, nothing clipped`).toBe(true);
      soft(key.icon, `I1: ${key.caption} has an icon`).not.toBe("");
    }

    // ── I2: hover each key ─────────────────────────────────────────────────
    const hovered: Array<Record<string, unknown>> = [];
    for (const [index, caption] of KEY_ORDER.entries()) {
      const key = keys.nth(index);
      await key.hover();
      await soft(tooltip(page), `I2: ${caption}'s tooltip`).toHaveText(`${KEY_NAMES[index]!}: none yet`, { timeout: 5_000 });
      // Let the border's transition finish before it is read and framed.
      await page.waitForTimeout(250);
      const slug = caption.toLowerCase().replace(/\s+/gu, "-");
      await shot(page, testInfo, "SI", `I2-hover-${slug}`);
      await cropStrip(page, testInfo, "SI", `I2-hover-${slug}-strip-crop`);
      const facts = (await stripKeys(page))[index];
      hovered.push({ caption, tooltipShown: await tooltip(page).textContent().catch(() => null), borderColor: facts?.borderColor, background: facts?.background });
      soft(facts?.borderColor, `I2: ${caption}'s border changes on hover`).not.toBe(i1[index]?.borderColor);
    }
    note(testInfo, "SI-I2", JSON.stringify({ colours, restingBorder: i1[0]?.borderColor, hovered }));
    await page.mouse.move(4, 4);

    // ── I3: press Environment ──────────────────────────────────────────────
    const environmentKey = page.getByTestId("rts-region-environment");
    await environmentKey.click();
    const dialog = page.getByRole("dialog", { name: "Region environment" });
    await expect(dialog.getByTestId("region-env")).toBeVisible();
    await settled(dialog);
    await page.mouse.move(4, 4);
    await page.waitForTimeout(250);
    await shot(page, testInfo, "SI", "I3-screen-open");
    await cropStrip(page, testInfo, "SI", "I3-strip-crop");
    const open = (await stripKeys(page))[2];
    soft(open?.pressed, "I3: the Environment key is pressed while its screen is open").toBe("true");
    soft(open?.borderColor, "I3: its border is amber").toBe(colours["--color-amber"]);
    await closeRegionEnvironment(dialog);
    await page.waitForTimeout(250);
    await shot(page, testInfo, "SI", "I3-after-done");
    await cropStrip(page, testInfo, "SI", "I3-after-done-strip-crop");
    const closed = (await stripKeys(page))[2];
    soft(closed?.pressed, "I3: after done the key is no longer pressed").toBe("false");
    note(testInfo, "SI-I3", JSON.stringify({ colours, whileOpen: open, afterDone: closed, keyCoveredByScreen: "see SI-I3-screen-open.png" }));

    // ── I4: a region with a briefing, a folder path and a source ──────────
    await selectRegion(page, FULL.id);
    await expect(keys.first()).toBeVisible({ timeout: 10_000 });
    await page.mouse.move(4, 4);
    await page.waitForTimeout(250);
    await shot(page, testInfo, "SI", "I4-all-set");
    await cropStrip(page, testInfo, "SI", "I4-strip-crop");
    const i4 = await stripKeys(page);
    note(testInfo, "SI-I4", JSON.stringify({ colours, keys: i4 }));
    soft(i4.slice(0, 3).map((key) => key.state), "I4: all three say set").toEqual(["set", "set", "set"]);
    soft(i4.slice(0, 3).map((key) => key.dataState), "I4: all three read set").toEqual(["set", "set", "set"]);
    soft(i4.slice(0, 3).map((key) => key.pressed), "I4: none looks pressed").toEqual(["false", "false", "false"]);
    soft(i4.slice(0, 3).map((key) => key.tooltip), "I4: tooltips end in set").toEqual(KEY_NAMES.map((name) => `${name}: set`));
    for (const key of i4.slice(0, 3)) {
      soft(key.stateColor, `I4: ${key.caption}'s state word is amber`).toBe(colours["--color-amber"]);
      soft(key.iconColor, `I4: ${key.caption}'s icon is amber`).toBe(colours["--color-amber"]);
      soft(key.captionOneLine && key.stateOneLine && !key.clipped, `I4: ${key.caption} fits on one line, nothing clipped`).toBe(true);
    }
    soft(i1[2]?.stateColor, "I1 against I4: the state word is not amber while nothing is set").not.toBe(i4[2]?.stateColor);
    soft(i1[2]?.iconColor, "I1 against I4: the icon is not amber while nothing is set").not.toBe(i4[2]?.iconColor);
    await environmentKey.hover();
    await soft(tooltip(page), "I4: the Environment key's tooltip").toHaveText("Environment and secrets: set", { timeout: 5_000 });
    await page.waitForTimeout(250);
    await shot(page, testInfo, "SI", "I4-hover-environment");
    await page.mouse.move(4, 4);

    // ── I5: the keyboard ───────────────────────────────────────────────────
    // The key pressed in I3 keeps POINTER focus, and a pointer-focused key
    // draws no ring. So focus is taken out of the strip for certain first,
    // and the ring is judged only on a key the keyboard itself reached.
    const openDialogs = page.getByRole("dialog");
    if ((await openDialogs.count()) > 0) await page.keyboard.press("Escape");
    await page.locator(".react-flow__pane").click({ position: { x: 12, y: 12 } });
    await selectRegion(page, PLAIN.id);
    await expect(keys.first()).toBeVisible({ timeout: 10_000 });
    await page.mouse.move(4, 4);
    const focusInStrip = (): Promise<boolean> => page.evaluate(() => document.activeElement?.closest(".rts-region-keys") != null);
    let blurredByScript = false;
    if (await focusInStrip()) {
      // Selecting the region did not move focus: drop it, and say so.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      blurredByScript = true;
    }
    const startedOutside = !(await focusInStrip());
    soft(startedOutside, "I5: before any key is pressed, focus is not in the strip").toBe(true);
    const startedOn = await page.evaluate(() => {
      const active = document.activeElement;
      return active ? `${active.tagName.toLowerCase()}${active.getAttribute("data-testid") ? `[${String(active.getAttribute("data-testid"))}]` : ""}` : "nothing";
    });

    /** The strip key that holds focus, and whether the browser counts that focus as the keyboard's. */
    const focusedKey = (): Promise<{ readonly name: string | null; readonly focusVisible: boolean } | null> =>
      page.evaluate(() => {
        const active = document.activeElement;
        return active instanceof HTMLElement && active.classList.contains("rts-region-key")
          ? { name: active.getAttribute("aria-label"), focusVisible: active.matches(":focus-visible") }
          : null;
      });
    let presses = 0;
    let direction = "Tab";
    let reached = null as Awaited<ReturnType<typeof focusedKey>>;
    for (const key of ["Tab", "Shift+Tab"] as const) {
      direction = key;
      for (let step = 0; step < 80 && reached === null; step += 1) {
        await page.keyboard.press(key);
        presses += 1;
        reached = await focusedKey();
      }
      if (reached !== null) break;
    }
    const how =
      reached === null
        ? `neither Tab nor Shift+Tab reached the strip in ${String(presses)} presses (focus began on ${startedOn})`
        : `${direction} reached "${String(reached.name)}" after ${String(presses)} real presses (focus began on ${startedOn}${blurredByScript ? ", after a scripted blur" : ""})`;
    soft(reached !== null && presses >= 1, `I5: the strip is reached with the keyboard (${how})`).toBe(true);
    soft(reached?.focusVisible, "I5: the focused key matches :focus-visible").toBe(true);
    await page.waitForTimeout(200);
    await shot(page, testInfo, "SI", "I5-focus-ring");
    await cropStrip(page, testInfo, "SI", "I5-strip-crop");
    // region-keys.css:35-38: `.rts-region-key:focus-visible { outline: 2px solid var(--color-amber); outline-offset: 2px; }`
    const ring = await page.evaluate(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !active.classList.contains("rts-region-key")) return null;
      const style = getComputedStyle(active);
      return { width: style.outlineWidth, style: style.outlineStyle, colour: style.outlineColor, offset: style.outlineOffset, borderWidth: style.borderTopWidth };
    });
    soft(ring, "I5: a strip key holds the focus to read the ring from").not.toBeNull();
    soft({ width: ring?.width, style: ring?.style, colour: ring?.colour, offset: ring?.offset }, "I5: a 2 px amber outline, 2 px clear of the key's border").toEqual({
      width: "2px",
      style: "solid",
      colour: colours["--color-amber"],
      offset: "2px",
    });
    const focusedFirst = (await stripKeys(page)).find((key) => key.focused);

    // On to the Environment key, by the keyboard, then Enter.
    let more = 0;
    while ((await focusedKey())?.name !== "Environment and secrets" && more < 6) {
      await page.keyboard.press(direction === "Shift+Tab" ? "Shift+Tab" : "Tab");
      more += 1;
    }
    const onEnvironment = await focusedKey();
    soft(onEnvironment?.name, "I5: the keyboard reaches the Environment key").toBe("Environment and secrets");
    await page.waitForTimeout(200);
    const focusedEnvironment = (await stripKeys(page)).find((key) => key.focused);
    await shot(page, testInfo, "SI", "I5-focus-on-environment");
    await cropStrip(page, testInfo, "SI", "I5-focus-on-environment-strip-crop");
    await page.keyboard.press("Enter");
    const byKeyboard = page.getByRole("dialog", { name: "Region environment" });
    await soft(byKeyboard.getByTestId("region-env"), "I5: Enter on the focused key opens its screen").toBeVisible({ timeout: 10_000 });
    await shot(page, testInfo, "SI", "I5-enter-opened-the-screen");
    note(
      testInfo,
      "SI-I5",
      JSON.stringify({ colours, how, startedOutside, blurredByScript, reached, ring, focusedFirst, onEnvironment, focusedEnvironment, pressesOnToEnvironment: more }),
    );
    if ((await byKeyboard.count()) > 0) await closeRegionEnvironment(byKeyboard);
  });
});

test("SJ Environment screen, by eye: the empty state, the lead action, and the one alert that comes first", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const PLAIN = { id: "plain", label: "Plain", x: 40, y: 60, width: 420, height: 260 } as const;
  const EMPTY_SENTENCE =
    "No sources yet. A source gives the seats in this region a variable or secret you already keep somewhere: a Keychain item, a 1Password field, an env file.";
  const ALERT = "A required source is failing, so seats in this region will not start until it is fixed.";
  // Made up, and looked up only: a read that finds nothing.
  const item = `junto-e2e-no-such-item-${Math.random().toString(36).slice(2, 10)}`;

  await walk(testInfo, "SJ", modelFixture([regionNode(PLAIN)]), async ({ page }) => {
    /** What leads the screen, and how its first section sits. */
    const layout = (dialog: Locator): Promise<Record<string, unknown>> =>
      dialog.getByTestId("region-env").evaluate((scroller) => {
        const first = scroller.firstElementChild as HTMLElement | null;
        const section = scroller.querySelector<HTMLElement>("section.region-env__section");
        const sectionStyle = section ? getComputedStyle(section) : undefined;
        const alerts = Array.from(scroller.closest("[role='dialog']")?.querySelectorAll("[data-testid='region-env-blocks-launch']") ?? []);
        const alert = alerts[0] as HTMLElement | undefined;
        const alertStyle = alert ? getComputedStyle(alert) : undefined;
        return {
          firstChild: first ? (first.getAttribute("data-testid") ?? first.getAttribute("aria-label") ?? first.tagName.toLowerCase()) : null,
          alertCount: alerts.length,
          alertText: alert ? (alert.textContent ?? "").trim() : null,
          alertHasIcon: alert ? alert.querySelector("svg") !== null : false,
          alertColour: alertStyle?.color ?? null,
          alertBackground: alertStyle?.backgroundColor ?? null,
          alertBorder: alertStyle?.borderTopColor ?? null,
          alertAboveSources: alert && section ? alert.getBoundingClientRect().bottom <= section.getBoundingClientRect().top + 1 : null,
          firstSection: section?.getAttribute("aria-label") ?? null,
          firstSectionBorderTop: sectionStyle ? `${sectionStyle.borderTopStyle} ${sectionStyle.borderTopWidth} ${sectionStyle.borderTopColor}` : null,
          firstSectionPaddingTop: sectionStyle?.paddingTop ?? null,
          // From the top of the scroller's content box to the first section.
          firstSectionOffsetFromTop:
            section === null
              ? null
              : Math.round(section.getBoundingClientRect().top - scroller.getBoundingClientRect().top - Number.parseFloat(getComputedStyle(scroller).paddingTop) + scroller.scrollTop),
        };
      });
    const addButton = (dialog: Locator): Promise<Record<string, unknown>> =>
      dialog.getByTestId("region-env-add-source").evaluate((button) => {
        const style = getComputedStyle(button);
        return { emphasis: button.getAttribute("data-emphasis"), colour: style.color, background: style.backgroundColor, border: style.borderTopColor };
      });
    const toTop = (dialog: Locator): Promise<void> => dialog.getByTestId("region-env").evaluate((scroller) => void (scroller.scrollTop = 0));
    /** Where the keyboard is: the screen opens with it on Add source, never in the Folders field (eff71ed6e: data-autofocus). */
    const focusNow = (): Promise<{ readonly testId: string | null; readonly label: string | null; readonly tag: string; readonly inFolders: boolean }> =>
      page.evaluate(() => {
        const active = document.activeElement;
        return {
          testId: active?.getAttribute("data-testid") ?? null,
          label: active?.getAttribute("aria-label") ?? null,
          tag: active?.tagName.toLowerCase() ?? "nothing",
          inFolders: active?.closest("section[aria-label='Folders']") != null,
        };
      });
    const checkOpeningFocus = async (step: string, which: string): Promise<Awaited<ReturnType<typeof focusNow>>> => {
      await soft
        .poll(async () => (await focusNow()).testId, { message: `${step}: on opening (${which}), the keyboard is on Add source`, timeout: 5_000 })
        .toBe("region-env-add-source");
      const focus = await focusNow();
      soft(focus.inFolders, `${step}: on opening (${which}), the Folders field does not have the keyboard`).toBe(false);
      soft(focus.testId, `${step}: nor is it the Folders input`).not.toBe("region-env-folder-input");
      return focus;
    };
    const colours = await themeColours(page);

    // ── J1: the empty region's screen ──────────────────────────────────────
    await selectRegion(page, PLAIN.id);
    await page.getByTestId("rts-region-environment").click();
    const dialog = page.getByRole("dialog", { name: "Region environment" });
    await expect(dialog.getByTestId("region-env")).toBeVisible();
    await settled(dialog);
    await page.mouse.move(4, 4);
    const j1Focus = await checkOpeningFocus("J1", "an empty region");
    await shot(page, testInfo, "SJ", "J1-empty-screen");
    const header = dialog.locator("header").first();
    await soft(header, "J1: the title").toContainText("Environment and secrets");
    await soft(header, "J1: under the small word region").toContainText("region");
    const sources = dialog.locator('section[aria-label="Sources"]');
    await soft(sources.locator(".region-env__empty"), "J1: the one grey sentence under Sources").toHaveText(EMPTY_SENTENCE);
    await soft(dialog.getByTestId("region-env-add-source"), "J1: Add source has the primary look").toHaveAttribute("data-emphasis", "primary");
    await soft(resolved(dialog).locator(".region-env__empty"), 'J1: under "What a seat here gets"').toHaveText("Nothing yet.");
    const j1Button = await addButton(dialog);
    note(
      testInfo,
      "SJ-J1",
      JSON.stringify({
        colours,
        header: ((await header.textContent().catch(() => "")) ?? "").replace(/\s+/gu, " ").trim(),
        emptySentenceColour: await sources.locator(".region-env__empty").evaluate((el) => getComputedStyle(el).color).catch(() => null),
        addSource: j1Button,
        focusOnOpening: j1Focus,
        layout: await layout(dialog),
      }),
    );

    // ── J2: one plain value source ─────────────────────────────────────────
    await addSource(dialog, "value", { name: "AWS_REGION", value: "eu-west-1" });
    await settled(dialog);
    await toTop(dialog);
    await page.mouse.move(4, 4);
    await shot(page, testInfo, "SJ", "J2-one-source");
    await soft(sourceRows(dialog), "J2: the row appears").toHaveCount(1);
    await soft(dialog.getByTestId("region-env-add-source"), "J2: Add source is back to the ordinary look").toHaveAttribute("data-emphasis", "quiet");
    const j2Button = await addButton(dialog);
    soft(j2Button.background, "J2: and it is drawn differently from the primary one").not.toBe(j1Button.background);
    // Reopened on a region that now has a source: the keyboard lands in the same place.
    await closeRegionEnvironment(dialog);
    await page.getByTestId("rts-region-environment").click();
    await expect(dialog.getByTestId("region-env")).toBeVisible();
    await settled(dialog);
    await page.mouse.move(4, 4);
    const j2Focus = await checkOpeningFocus("J2", "a region with a source");
    await shot(page, testInfo, "SJ", "J2-reopened-with-a-source");
    note(testInfo, "SJ-J2", JSON.stringify({ colours, addSource: j2Button, addSourceWhenEmpty: j1Button, focusOnReopening: j2Focus }));

    // ── J3: a required Keychain source that does not exist ─────────────────
    const form = await openSourceForm(dialog, "keychain");
    await form.getByTestId("region-env-field-name").fill("WALK_MISSING");
    await form.getByTestId("region-env-field-service").fill(item);
    const required = form.getByRole("switch", { name: "Required" });
    await required.click();
    await expect(required).toBeChecked();
    await form.getByTestId("region-env-save-source").click();
    await expect(form).toHaveCount(0);
    const alert = dialog.getByTestId("region-env-blocks-launch");
    await soft(alert.first(), "J3: the red block").toBeVisible({ timeout: 30_000 });
    await settled(dialog);
    await toTop(dialog);
    await page.mouse.move(4, 4);
    await shot(page, testInfo, "SJ", "J3-alert-leads-the-screen");
    const j3 = await layout(dialog);
    soft(j3.alertCount, "J3: the block appears exactly once in the whole dialog").toBe(1);
    soft(j3.firstChild, "J3: it is the first thing on the screen").toBe("region-env-blocks-launch");
    soft(j3.alertAboveSources, "J3: above Sources").toBe(true);
    soft(j3.alertText, "J3: its sentence").toBe(ALERT);
    soft(j3.alertHasIcon, "J3: with a warning triangle").toBe(true);
    await soft(resolved(dialog), 'J3: it is not said again under "What a seat here gets"').not.toContainText(ALERT);
    const row = sourceRows(dialog).filter({ hasText: "WALK_MISSING" });
    await soft(row, "J3: the source's row").toHaveCount(1);
    await soft(row, "J3: the row still says required").toContainText("required");
    await soft(row, "J3: and Missing").toContainText("Missing");
    const reason = ((await row.locator(".region-env__error").first().textContent().catch(() => "")) ?? "").trim();
    soft(reason, "J3: with its own reason").not.toBe("");
    await soft(variable(dialog, "WALK_MISSING"), "J3: the variable still says not set").toContainText("not set");
    await resolved(dialog).scrollIntoViewIfNeeded();
    await shot(page, testInfo, "SJ", "J3-row-and-variable");
    note(testInfo, "SJ-J3", JSON.stringify({ colours, layout: j3, rowReason: reason, rowText: ((await row.textContent().catch(() => "")) ?? "").replace(/\s+/gu, " ").trim() }));

    // ── J4: Required off ───────────────────────────────────────────────────
    await dialog.getByRole("button", { name: "Edit WALK_MISSING" }).click();
    const edit = dialog.getByTestId("region-env-form");
    const requiredAgain = edit.getByRole("switch", { name: "Required" });
    await requiredAgain.click();
    await expect(requiredAgain).not.toBeChecked();
    await edit.getByTestId("region-env-save-source").click();
    await expect(edit).toHaveCount(0);
    await soft(alert, "J4: the red block is gone").toHaveCount(0, { timeout: 30_000 });
    await settled(dialog);
    await toTop(dialog);
    await page.mouse.move(4, 4);
    await shot(page, testInfo, "SJ", "J4-required-off");
    const j4 = await layout(dialog);
    soft(j4.alertCount, "J4: no block anywhere in the dialog").toBe(0);
    soft(j4.firstChild, "J4: Sources is the first thing on the screen").toBe("Sources");
    soft(String(j4.firstSectionBorderTop ?? ""), "J4: with no divider line above it").toMatch(/^none|\s0px\s/u);
    soft(j4.firstSectionOffsetFromTop, "J4: and it starts at the top").toBe(0);
    await soft(row, "J4: the row no longer says required").not.toContainText("required");
    await soft(row, "J4: it is still Missing").toContainText("Missing");
    note(testInfo, "SJ-J4", JSON.stringify({ colours, layout: j4, withTheAlert: j3 }));
    await closeRegionEnvironment(dialog);
  });
});

test("S2 forms: eight kinds, Keychain first, each showing only its own fields, switching clears them", async ({}, testInfo) => {
  test.setTimeout(240_000);
  await walk(testInfo, "S2", walkFixture(), async ({ page }) => {
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
  await walk(testInfo, "S3", walkFixture(), async ({ page }) => {
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
  await walk(testInfo, "S4", walkFixture(), async ({ page, app, sandbox }) => {
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
  await walk(testInfo, "S5", walkFixture(), async ({ page }) => {
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

    await walk(testInfo, "S6", walkFixture(), async ({ page }) => {
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
  await walk(testInfo, "S7", walkFixture(seeded), async ({ page }) => {
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
  await walk(testInfo, "S8", walkFixture(), async ({ page }) => {
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
  await walk(testInfo, "S9", walkFixture(), async ({ page, sandbox }) => {
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
  await walk(testInfo, "S10", walkFixture([plainValue("src-stage", "STAGE", "one")]), async ({ page, sandbox }) => {
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
    soft(readSeatSession(sandbox, SEAT.id), "the seat's stored session id").toBe(SESSION);
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
  const junto = await launchJunto({ seedModels: { [CANVAS]: walkFixture() }, afterSeed: installCrewSeatHarness });
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
