/**
 * A video attached to a needs-you signal plays from the card.
 *   bun run test:e2e:fast e2e/scenarios/feed-video.spec.ts
 *
 * A fake seat raises a signal through its own CLI with three short clips
 * (`e2e/fixtures/video`: MP4, QuickTime, WebM). The claims, on the built app:
 *   - each clip is recorded as a video by its bytes, whatever it is named
 *   - with the originals gone, the card shows each as a poster under a play mark
 *   - the viewer opens a real player on the app's own stream: it has a
 *     duration, it plays, and it seeks (main answers the range read)
 *   - the player's keys stay the player's: Space plays and pauses, and the
 *     viewer does not step to the next file while the player has focus
 */
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const SHOTS = join(process.cwd(), "test-results", "feed-video");
const CLIPS = join(process.cwd(), "e2e", "fixtures", "video");
const CANVAS = "feed-video";
const SEAT = "seat-ada";
const seatNode = crewSeatNode({ id: SEAT, label: "Ada", x: 120, y: 220 });

test("[fake-tui] a seat attaches videos to a signal and the card plays them", async () => {
  test.setTimeout(240_000);
  await mkdir(SHOTS, { recursive: true });
  const dir = await mkdtemp(join(tmpdir(), "junto-feed-video-"));
  const at = (name: string): string => join(dir, name);
  await copyFile(join(CLIPS, "clip.mp4"), at("walkthrough.mp4"));
  await copyFile(join(CLIPS, "clip.mov"), at("recording.mov"));
  // Named as something else: the bytes say what it is.
  await copyFile(join(CLIPS, "clip.webm"), at("capture.bin"));

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

    const raised = await ada.cli([
      "feedback",
      "The new onboarding flow is recorded end to end.",
      "--attach",
      `Walkthrough=${at("walkthrough.mp4")}`,
      "--attach",
      `Screen recording=${at("recording.mov")}`,
      "--attach",
      at("capture.bin"),
    ]);
    expect(raised.ok, `${raised.stdout}${raised.stderr}`).toBe(true);
    await expect.poll(async () => (await signalsNow()).length, { timeout: 15_000 }).toBe(1);
    const signal = (await signalsNow())[0]!;
    expect(signal.attachments?.map((attachment) => [attachment.caption, fileRef(attachment).displayName, fileRef(attachment).mediaType])).toEqual([
      ["Walkthrough", "walkthrough.mp4", "video/mp4"],
      ["Screen recording", "recording.mov", "video/quicktime"],
      [undefined, "capture.bin", "video/webm"],
    ]);
    await rm(dir, { recursive: true, force: true });

    await page.keyboard.press("Meta+I");
    const feed = page.getByTestId("operator-feed");
    await expect(feed).toBeVisible({ timeout: 10_000 });
    const card = feed.locator(`[data-item-id='signal:${signal.signalId}']`);
    await card.getByRole("button", { name: /Details/ }).click();
    const strip = card.getByTestId("preview-strip");
    const thumbs = strip.getByTestId("preview-thumbnail");
    await expect(thumbs).toHaveCount(3);
    // Each tile is a frame of its own film.
    await expect(strip.locator("img[src^='data:image/jpeg']")).toHaveCount(3, { timeout: 20_000 });
    await expect(strip).not.toContainText("file not found");
    await page.screenshot({ path: join(SHOTS, "card-videos-dark.png") });

    const viewer = page.getByTestId("preview-viewer");
    const film = (): Promise<{ duration: number; time: number; paused: boolean; width: number; error: number | null }> =>
      viewer.locator("video").evaluate((node) => {
        const video = node as HTMLVideoElement;
        return { duration: video.duration, time: video.currentTime, paused: video.paused, width: video.videoWidth, error: video.error?.code ?? null };
      });

    for (const [index, name] of ["walkthrough.mp4", "recording.mov", "capture.bin"].entries()) {
      await thumbs.nth(index).click();
      await expect(viewer.getByTestId("preview-viewer-title")).toHaveText(name);
      await expect(viewer.getByTestId("preview-video")).toBeVisible();
      await expect.poll(async () => (await film()).duration, { timeout: 20_000, message: `${name} has a duration` }).toBeGreaterThan(2);
      expect(await film()).toMatchObject({ width: 480, paused: true, error: null });

      // It plays.
      await viewer.locator("video").evaluate((node) => (node as HTMLVideoElement).play());
      await expect.poll(async () => (await film()).time, { timeout: 20_000, message: `${name} plays` }).toBeGreaterThan(0.3);
      // It seeks: main answers the read from the middle of the file.
      await viewer.locator("video").evaluate((node) => {
        const video = node as HTMLVideoElement;
        video.pause();
        video.currentTime = 2;
      });
      await expect.poll(async () => (await film()).time, { timeout: 20_000, message: `${name} seeks` }).toBeGreaterThanOrEqual(2);
      if (index === 0) {
        // The player's keys are the player's: Space plays, an arrow seeks, the viewer stays put.
        await viewer.locator("video").focus();
        await page.keyboard.press("ArrowLeft");
        await page.keyboard.press("ArrowRight");
        await expect(viewer.getByTestId("preview-viewer-title")).toHaveText(name);
        await page.screenshot({ path: join(SHOTS, "player-dark.png") });
      }
      await page.keyboard.press("Escape");
      await expect(viewer).toHaveCount(0);
    }
  } finally {
    await junto.close();
    await rm(dir, { recursive: true, force: true });
  }
});
