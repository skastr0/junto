/**
 * Files attached to a needs-you signal.
 *   bun run test:e2e:fast e2e/scenarios/feed-attachments.spec.ts
 *
 * A real seat raises a real feedback signal through its own CLI with two
 * captioned files (`--attach "Before=..." --attach "After=..."`). The
 * originals are then deleted, as a cleaned temp folder would: what the card
 * shows can only come from the app's own store.
 *
 * Asserts:
 *   - the CLI refuses a file no preview can show, naming it, and raises nothing
 *   - the raised signal carries two attachments by content reference, no path anywhere
 *   - with the originals gone, the card's details show both as pictures, in order, tagged A and B
 *   - the viewer opens on the attached file with the agent's caption, and offers no reveal in Finder
 *   - the A B view opens on the Before and After pair
 *   - main serves an attachment only by its place in that signal's list
 *   - a file larger than one work socket frame is attached and shown
 *   - the seat withdraws the signal through its CLI and it closes
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type { AgentSignal, AgentSignalAttachment } from "../../src/shared/agent-signals";
import { expect, launchJunto, test } from "../harness/launch";
import {
  crewDoc,
  crewOccupySeat,
  crewPlayFactory,
  crewSeat,
  crewSeatNode,
  installCrewSeatHarness,
} from "../harness/crew-fixture";

/** A file attachment's reference; these signals carry nothing else. */
const fileRef = (attachment: AgentSignalAttachment) => {
  if ("kind" in attachment) throw new Error(`expected a file, got a ${attachment.kind}`);
  return attachment.ref;
};

/** Thirty-two bytes no reader takes for text. */
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(28, 0xff)]);

const SHOTS = join(process.cwd(), "test-results", "feed-attachments");
const CANVAS = "feed-attachments";
const SEAT = "seat-ada";
const seatNode = crewSeatNode({ id: SEAT, label: "Ada", x: 120, y: 220 });

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

test("[fake-tui] a seat attaches files to a signal and the card shows them after the originals are gone", async () => {
  test.setTimeout(240_000);
  await mkdir(SHOTS, { recursive: true });
  const dir = await mkdtemp(join(tmpdir(), "junto-feed-attachments-"));
  const at = (name: string): string => join(dir, name);
  await writeFile(at("before.png"), png(900, 560, [222, 148, 52], 100));
  await writeFile(at("after.png"), png(900, 560, [222, 148, 52], 500));
  await writeFile(at("build.zip"), ZIP);

  const junto = await launchJunto({
    seedCanvases: { [CANVAS]: crewDoc([seatNode]) },
    afterSeed: installCrewSeatHarness,
  });
  try {
    const { page, sandbox } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await crewPlayFactory(page);
    const ada = crewSeat(sandbox, CANVAS, SEAT);
    await crewOccupySeat(page, CANVAS, seatNode, ada);

    const signalsNow = (): Promise<ReadonlyArray<AgentSignal>> =>
      page.evaluate((canvas) => window.junto!.agentSignalsList(canvas), CANVAS);

    // A file that is not there is refused at the CLI, by name, and nothing is raised.
    const refused = await ada.cli(["feedback", "Here is the build.", "--attach", at("gone.zip")]);
    expect(refused.ok).toBe(false);
    expect(`${refused.stdout}${refused.stderr}`).toContain("gone.zip");
    expect(await signalsNow()).toEqual([]);

    // The real thing: two captioned files, raised by the seat itself.
    const raised = await ada.cli([
      "feedback",
      "The rail redesign is ready to review.",
      "--attach",
      `Before=${at("before.png")}`,
      "--attach",
      `After=${at("after.png")}`,
    ]);
    expect(raised.ok, `${raised.stdout}${raised.stderr}`).toBe(true);

    await expect.poll(async () => (await signalsNow()).length, { timeout: 15_000 }).toBe(1);
    const signal = (await signalsNow())[0]!;
    expect(signal.attachments?.map((attachment) => [attachment.caption, fileRef(attachment).displayName, fileRef(attachment).mediaType])).toEqual([
      ["Before", "before.png", "image/png"],
      ["After", "after.png", "image/png"],
    ]);
    // A reference to bytes, never where they came from.
    expect(JSON.stringify(signal)).not.toContain(dir);

    // The temp folder is cleaned.
    await rm(dir, { recursive: true, force: true });

    await page.keyboard.press("Meta+I");
    const feed = page.getByTestId("operator-feed");
    await expect(feed).toBeVisible({ timeout: 10_000 });
    const card = feed.locator(`[data-item-id='signal:${signal.signalId}']`);
    // No longer text was sent: the files alone give the card its details.
    await card.getByRole("button", { name: /Details/ }).click();
    const strip = card.getByTestId("preview-strip");
    const thumbs = strip.getByTestId("preview-thumbnail");
    await expect(thumbs).toHaveCount(2);
    expect(await thumbs.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")))).toEqual([
      "Before, before.png",
      "After, after.png",
    ]);
    await expect(strip.locator("img[src^='data:image/png']")).toHaveCount(2);
    expect(
      await strip.locator("img").evaluateAll((nodes) => nodes.map((node) => (node as HTMLImageElement).naturalWidth > 0)),
    ).toEqual([true, true]);
    await expect(thumbs.nth(0)).toContainText("A");
    await expect(thumbs.nth(1)).toContainText("B");
    await expect(strip).not.toContainText("file not found");
    await page.screenshot({ path: join(SHOTS, "card-attachments-dark.png") });

    // The viewer, on the attached file, with the agent's caption.
    await thumbs.nth(0).click();
    const viewer = page.getByTestId("preview-viewer");
    await expect(viewer.getByTestId("preview-viewer-title")).toHaveText("before.png");
    await expect(viewer).toContainText("Before");
    await expect(viewer.getByTestId("preview-viewer-status")).toContainText("1 of 2, 900 × 560");
    // It lives in the app's store: there is no folder to reveal.
    await expect(viewer.getByRole("button", { name: /Reveal in Finder|Show in folder/ })).toHaveCount(0);

    // A B opens on the captioned pair.
    await page.keyboard.press("c");
    const compare = viewer.getByTestId("preview-compare");
    await expect(compare.locator("img")).toHaveCount(2);
    await expect(compare.locator(".preview-viewer__pane-name")).toHaveText(["Before, before.png", "After, after.png"]);
    await page.mouse.move(4, 700);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SHOTS, "compare-attachments-dark.png") });
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);

    // Main serves an attachment only by its place in this signal's list.
    const outside = await page.evaluate(
      (signalId) =>
        Promise.all([
          window.junto!.previewRead({ source: { kind: "signal", signalId }, target: { kind: "attachment", index: 2 }, variant: "full" }),
          window.junto!.previewRead({ source: { kind: "signal", signalId: "no-such-signal" }, target: { kind: "attachment", index: 0 }, variant: "full" }),
        ]),
      signal.signalId,
    );
    expect(outside).toEqual([
      { ok: false, reason: "not-named" },
      { ok: false, reason: "not-named" },
    ]);

    // Withdrawn by the seat: the signal closes and the card leaves.
    await page.keyboard.press("Escape");
    const cleared = await ada.cli(["signal", "clear", signal.signalId]);
    expect(cleared.ok, `${cleared.stdout}${cleared.stderr}`).toBe(true);
    await expect.poll(async () => (await signalsNow())[0]?.state, { timeout: 15_000 }).toBe("withdrawn");

    // No size of ours: a file larger than one socket frame goes up in pieces.
    await mkdir(dir, { recursive: true });
    const bigBytes = 20 * 1024 * 1024;
    await writeFile(at("run.log"), Buffer.alloc(bigBytes, "a line of the run's log\n"));
    await writeFile(at("build.zip"), ZIP);
    // No kind of ours either: a file no preview draws rides along and shows by its name.
    const big = await ada.cli([
      "escalate",
      "The full run log is attached.",
      "--attach",
      `Run log=${at("run.log")}`,
      "--attach",
      at("build.zip"),
    ]);
    expect(big.ok, `${big.stdout}${big.stderr}`).toBe(true);
    await expect
      .poll(async () => (await signalsNow()).filter((raisedSignal) => raisedSignal.state === "open").length, { timeout: 15_000 })
      .toBe(1);
    const bigSignal = (await signalsNow()).find((raisedSignal) => raisedSignal.state === "open")!;
    expect(bigSignal.attachments?.map((attachment) => [attachment.caption, fileRef(attachment).displayName, fileRef(attachment).mediaType, fileRef(attachment).byteLength])).toEqual([
      ["Run log", "run.log", "text/plain", bigBytes],
      [undefined, "build.zip", "application/octet-stream", 32],
    ]);
    await rm(dir, { recursive: true, force: true });
    const shown = await page.evaluate(
      (signalId) =>
        window.junto!.previewRead({ source: { kind: "signal", signalId }, target: { kind: "attachment", index: 0 }, variant: "full" }),
      bigSignal.signalId,
    );
    expect(shown.ok && shown.kind === "text" && shown.text.length).toBe(bigBytes);
    expect(shown).toMatchObject({ ok: true, kind: "text", name: "run.log", byteLength: bigBytes, truncated: false });
    const zipShown = await page.evaluate(
      (signalId) =>
        window.junto!.previewRead({ source: { kind: "signal", signalId }, target: { kind: "attachment", index: 1 }, variant: "full" }),
      bigSignal.signalId,
    );
    expect(zipShown).toMatchObject({ ok: true, kind: "file", name: "build.zip", byteLength: 32 });

    // The whole log opens in the viewer, not a first slice of it.
    await page.keyboard.press("Meta+I");
    await expect(feed).toBeVisible({ timeout: 10_000 });
    const bigCard = feed.locator(`[data-item-id='signal:${bigSignal.signalId}']`);
    await bigCard.getByRole("button", { name: /Details/ }).click();
    const bigThumbs = bigCard.getByTestId("preview-strip").getByTestId("preview-thumbnail");
    await expect(bigThumbs).toHaveCount(2);
    const opening = Date.now();
    await bigThumbs.nth(0).click();
    await expect(viewer.getByTestId("preview-viewer-title")).toHaveText("run.log");
    await expect(viewer.getByTestId("preview-text")).toBeVisible({ timeout: 60_000 });
    console.log(`whole 20 MB log on screen in ${Date.now() - opening} ms`);
    await expect(viewer.getByTestId("preview-viewer-status")).not.toContainText("showing the first");
    await page.screenshot({ path: join(SHOTS, "whole-log-dark.png") });
  } finally {
    await junto.close();
    await rm(dir, { recursive: true, force: true });
  }
});
