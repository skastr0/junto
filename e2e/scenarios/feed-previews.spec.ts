/**
 * Previews in the needs-you feed: the files an agent names in a signal's
 * detail show as thumbnails and open in a viewer.
 *   bun run test:e2e:fast e2e/scenarios/feed-previews.spec.ts
 *
 * The signal is a durable row and the files are real files on disk, so every
 * thumbnail and every full image comes through main's guarded preview read.
 *
 * Asserts:
 *   - a closed card reads no file; opening its details shows a thumbnail per file, in the order written
 *   - a path that is gone stays text with a quiet "file not found"; a .png that is not an image is never an <img>
 *   - the text shows a previewed path as its file name, a link that opens the viewer there
 *   - a thumbnail opens the viewer above the feed, at that image, with the agent's caption
 *   - next and previous move through the files in order, by key and by button, and stop at the ends
 *   - j and k do nothing to the feed while the viewer is open
 *   - the A B view opens on the before and after pair, side by side and under one divider
 *   - a text file opens as readable text
 *   - Escape closes the viewer only, focus returns to the thumbnail; the next Escape closes the feed
 *   - main serves nothing the signal does not name
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type { AgentSignal } from "../../src/shared/agent-signals";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "feed-previews");
const CANVAS = "feed-previews";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Buffer): number => {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer): Buffer => {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
};
/** A real PNG: a flat ground with one darker band, so two of them differ to the eye. */
const png = (width: number, height: number, [r, g, b]: readonly [number, number, number], band: number): Buffer => {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const dark = x >= band && x < band + 80 ? 0.45 : 1;
      raw[row + 1 + x * 3] = r * dark;
      raw[row + 2 + x * 3] = g * dark;
      raw[row + 3 + x * 3] = b * dark;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

test("the needs-you feed previews the files a signal names", async () => {
  await mkdir(SHOTS, { recursive: true });
  const dir = await mkdtemp(join(tmpdir(), "junto-feed-previews-"));
  const at = (name: string): string => join(dir, name);
  await writeFile(at("before.png"), png(1200, 760, [222, 148, 52], 120));
  await writeFile(at("after.png"), png(1200, 760, [222, 148, 52], 620));
  await writeFile(at("rail-expanded.png"), png(520, 1400, [70, 150, 190], 200));
  await writeFile(at("notes.md"), "# Rail notes\n\nThe rail keeps its width when collapsed.\n");
  await writeFile(at("not-an-image.png"), "plain text wearing a png name");
  await writeFile(at("unnamed.png"), png(40, 40, [10, 200, 10], 0));

  const signal: AgentSignal = {
    signalId: "sig-previews",
    canvasName: CANVAS,
    nodeId: "atlas",
    kind: "feedback",
    text: "The agent rail redesign is ready to review, with screenshots.",
    detail: [
      "Compare the rail before and after the change.",
      "",
      `- Before: ${at("before.png")}`,
      `- After: ${at("after.png")}`,
      `- Rail expanded: \`${at("rail-expanded.png")}\``,
      `- Notes: ${at("notes.md")}`,
      `- Gone: ${at("cleaned-up.png")}`,
      `- Odd: ${at("not-an-image.png")}`,
    ].join("\n"),
    createdAt: Date.now() - 60_000,
    state: "open",
  };

  // Two more cards for the strip's shapes: a plain pair, and seven that fold into "+3".
  const many = ["one", "two", "three", "four", "five", "six", "seven"];
  for (const [index, name] of many.entries()) {
    await writeFile(at(`${name}.png`), png(400, 300, [60 + index * 25, 120, 200 - index * 20], 40 * index));
  }
  const extra = (signalId: string, text: string, names: ReadonlyArray<string>): AgentSignal => ({
    ...signal,
    signalId,
    text,
    detail: names.map((name) => at(`${name}.png`)).join("\n"),
    createdAt: signal.createdAt - 60_000,
  });
  const pairSignal = extra("sig-pair", "Two screenshots of the settings page.", many.slice(0, 2));
  const manySignal = extra("sig-many", "Seven screenshots of the onboarding tour.", many);

  const junto = await launchJunto({
    seedCanvases: {
      [CANVAS]: canvasDoc(
        [agentTextNode({ id: "atlas", key: "local:e2e-previews-atlas", label: "Atlas", harness: "claude", x: 40, y: 80 })],
        [],
      ),
    },
    seedAgentSignals: [signal, pairSignal, manySignal],
  });
  try {
    const { page } = junto;
    await expect(page.locator(".react-flow__node", { hasText: "Atlas" })).toBeVisible({ timeout: 30_000 });
    // Dark is the operator's theme: the screenshots are taken there.
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");

    await page.keyboard.press("Meta+I");
    const feed = page.getByTestId("operator-feed");
    await expect(feed).toBeVisible({ timeout: 10_000 });
    const card = feed.locator("[data-item-id='signal:sig-previews']");
    await expect(card).toBeVisible();

    // A closed card costs nothing: no strip, so no file is read.
    await expect(card.getByTestId("preview-strip")).toHaveCount(0);

    await card.getByRole("button", { name: "Details" }).click();
    const strip = card.getByTestId("preview-strip");
    const thumbs = strip.getByTestId("preview-thumbnail");
    // Five files exist, in the order written; the one that is gone is not a tile.
    await expect(thumbs).toHaveCount(5);
    expect(await thumbs.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")))).toEqual([
      "before.png",
      "after.png",
      "rail-expanded.png",
      "notes.md",
      "not-an-image.png",
    ]);
    // Three are images, each drawn from a data URL main produced.
    await expect(strip.locator("img[src^='data:image/png']")).toHaveCount(3);
    // A png name over text is a file tile, never a broken image.
    await expect(thumbs.nth(4).locator("img")).toHaveCount(0);
    await expect(thumbs.nth(4)).toContainText("png");
    // Every image decoded: none is broken.
    expect(
      await strip.locator("img").evaluateAll((nodes) => nodes.map((node) => (node as HTMLImageElement).naturalWidth > 0)),
    ).toEqual([true, true, true]);
    // The labelled pair wears its tags.
    await expect(thumbs.nth(0)).toContainText("A");
    await expect(thumbs.nth(1)).toContainText("B");
    await expect(strip).toContainText("cleaned-up.png, file not found");
    // The text names each previewed file by its name, the full path on hover; the one that is gone stays as written.
    const detail = card.locator(".operator-feed__detail");
    await expect(detail).toContainText("Before: before.png");
    await expect(detail).toContainText("Rail expanded: rail-expanded.png");
    await expect(detail).not.toContainText(at("before.png"));
    await expect(detail.getByRole("link", { name: "after.png" })).toHaveAttribute("data-junto-tooltip", at("after.png"));
    await expect(detail).toContainText(at("cleaned-up.png"));
    await page.screenshot({ path: join(SHOTS, "card-details-dark.png") });

    // A pair with no labels wears no tags; seven fold into four and "+3", which opens the fifth.
    const pairCard = feed.locator("[data-item-id='signal:sig-pair']");
    await pairCard.getByRole("button", { name: "Details" }).click();
    await expect(pairCard.getByTestId("preview-thumbnail")).toHaveCount(2);
    await expect(pairCard.getByTestId("preview-strip")).not.toContainText("A");
    const manyCard = feed.locator("[data-item-id='signal:sig-many']");
    await manyCard.getByRole("button", { name: "Details" }).click();
    await expect(manyCard.getByTestId("preview-thumbnail")).toHaveCount(4);
    await manyCard.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, "cards-two-and-seven-dark.png") });
    await manyCard.getByRole("button", { name: "3 more" }).click();
    await expect(page.getByTestId("preview-viewer-title")).toHaveText("five.png");
    await expect(page.getByTestId("preview-viewer-status")).toContainText("5 of 7");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("preview-viewer")).toHaveCount(0);

    // The same surfaces in the bright edition, for the design review.
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "bright" } }));
    await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
    await page.screenshot({ path: join(SHOTS, "cards-two-and-seven-bright.png") });
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, "card-details-bright.png") });
    await thumbs.nth(2).click();
    await expect(page.getByTestId("preview-viewer-title")).toHaveText("rail-expanded.png");
    await page.mouse.move(4, 700);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, "viewer-tall-bright.png") });
    await page.keyboard.press("c");
    await expect(page.getByTestId("preview-compare").locator("img")).toHaveCount(2);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, "compare-side-bright.png") });
    await page.getByTestId("preview-viewer").getByRole("button", { name: "Swipe" }).click();
    await expect(page.getByTestId("preview-compare").getByRole("slider")).toBeVisible();
    await page.screenshot({ path: join(SHOTS, "compare-swipe-bright.png") });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("preview-viewer")).toHaveCount(0);
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");

    // Main serves nothing the signal does not name.
    const refused = await page.evaluate(
      (path) => window.junto!.previewRead({ source: { kind: "signal", signalId: "sig-previews" }, path, variant: "full" }),
      at("unnamed.png"),
    );
    expect(refused).toEqual({ ok: false, reason: "not-named" });

    // A file name in the text opens the viewer at that file.
    await detail.getByRole("link", { name: "notes.md" }).click();
    await expect(page.getByTestId("preview-viewer-title")).toHaveText("notes.md");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("preview-viewer")).toHaveCount(0);

    // Open the second image.
    await expect(card).toHaveAttribute("aria-current", "true");
    await thumbs.nth(1).click();
    const viewer = page.getByTestId("preview-viewer");
    await expect(viewer).toBeVisible();
    const title = viewer.getByTestId("preview-viewer-title");
    const status = viewer.getByTestId("preview-viewer-status");
    await expect(title).toHaveText("after.png");
    await expect(viewer).toContainText("After");
    await expect(status).toContainText("2 of 5, 1200 × 760");

    // The viewer is on top of the feed.
    const onTop = await viewer.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit !== null && node.contains(hit);
    });
    expect(onTop).toBe(true);
    await page.mouse.move(4, 700);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, "viewer-dark.png") });

    // Next and previous, by key, in the order written; the ends hold.
    await page.keyboard.press("ArrowLeft");
    await expect(title).toHaveText("before.png");
    await expect(viewer.getByRole("button", { name: "Previous" })).toBeDisabled();
    await page.keyboard.press("ArrowLeft");
    await expect(title).toHaveText("before.png");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(title).toHaveText("rail-expanded.png");
    await expect(status).toContainText("3 of 5, 520 × 1400");
    await page.screenshot({ path: join(SHOTS, "viewer-tall-dark.png") });
    // And by button.
    await viewer.getByRole("button", { name: "Next" }).click();
    await expect(title).toHaveText("notes.md");
    await expect(viewer.getByTestId("preview-text")).toContainText("The rail keeps its width when collapsed.");
    await viewer.getByRole("button", { name: "Next" }).click();
    await expect(viewer.getByTestId("preview-file")).toContainText("PNG file");
    await expect(viewer.getByRole("button", { name: "Next" })).toBeDisabled();

    // The feed's keys are quiet under the viewer: the card stays selected, no reply opens.
    await page.keyboard.press("j");
    await page.keyboard.press("k");
    await page.keyboard.press("Enter");
    await expect(card).toHaveAttribute("aria-current", "true");
    await expect(card.getByLabel("Your reply")).toHaveCount(0);

    // Fit and actual size.
    await viewer.getByRole("button", { name: "Before, before.png" }).click();
    await expect(title).toHaveText("before.png");
    await page.keyboard.press("z");
    await expect(status).toContainText("100%");
    const actual = await viewer.locator(".preview-viewer__slide img").evaluate((node) => node.getBoundingClientRect().width);
    expect(Math.round(actual)).toBe(1200);
    await page.keyboard.press("z");

    // A B: opens on the before and after pair, side by side on one scale.
    await viewer.getByRole("button", { name: "Compare two images" }).click();
    const compare = viewer.getByTestId("preview-compare");
    await expect(compare).toHaveAttribute("data-mode", "side");
    await expect(compare.locator("img")).toHaveCount(2);
    await expect(compare.locator(".preview-viewer__pane-name")).toHaveText(["Before, before.png", "After, after.png"]);
    await expect
      .poll(async () => {
        const widths = await compare.locator("img").evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().width)));
        return widths.length === 2 && widths[0] === widths[1] && widths[0]! > 0;
      })
      .toBe(true);
    await page.mouse.move(4, 700);
    await page.screenshot({ path: join(SHOTS, "compare-side-dark.png") });

    // Swipe: one stage, a divider that is a slider.
    await viewer.getByRole("button", { name: "Swipe" }).click();
    await expect(compare).toHaveAttribute("data-mode", "swipe");
    const divider = compare.getByRole("slider");
    await expect(divider).toHaveAttribute("aria-valuenow", "50");
    await divider.focus();
    await page.keyboard.press("ArrowRight");
    await expect(divider).toHaveAttribute("aria-valuenow", "52");
    await page.keyboard.press("Home");
    await expect(divider).toHaveAttribute("aria-valuenow", "0");
    await page.keyboard.press("ArrowRight");
    for (let step = 0; step < 14; step++) await page.keyboard.press("ArrowRight");
    await expect(divider).toHaveAttribute("aria-valuenow", "30");
    await page.screenshot({ path: join(SHOTS, "compare-swipe-dark.png") });

    // Escape: the viewer only, and the keyboard goes back to the thumbnail.
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
    await expect(feed).toBeVisible();
    await expect(strip).toBeVisible();
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("after.png");
    // Then what the feed always did: it closes, details as the operator left them.
    await page.keyboard.press("Escape");
    await expect(feed).toHaveCount(0);
  } finally {
    await junto.close();
    await rm(dir, { recursive: true, force: true });
  }
});
