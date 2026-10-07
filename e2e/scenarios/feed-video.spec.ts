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
 *
 * And a video at a web address (`--video`), against a local web server:
 *   - the card and the viewer show the address whole, and the server is not
 *     asked for anything until the operator presses play
 *   - play streams it through the app: it has a duration, plays and seeks
 *   - an address that redirects to another site does not play, and that
 *     other site is never asked
 */
import { createReadStream, statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "bright" } }));
    await page.screenshot({ path: join(SHOTS, "card-videos-bright.png") });

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
        await page.screenshot({ path: join(SHOTS, "player-bright.png") });
        await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
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

/** A web server for one clip, with range reads, that counts what it is asked. */
const serveClip = async (redirectTo?: () => string): Promise<{ readonly server: Server; readonly origin: string; readonly asked: string[] }> => {
  const clip = join(CLIPS, "clip.mp4");
  const size = statSync(clip).size;
  const asked: string[] = [];
  const server = createServer((request, response) => {
    asked.push(`${request.method} ${request.url}`);
    if (request.url === "/moved.mp4" && redirectTo) {
      response.writeHead(302, { Location: redirectTo() }).end();
      return;
    }
    if (request.url !== "/runs/onboarding.mp4") {
      response.writeHead(404).end();
      return;
    }
    const range = /^bytes=(\d+)-(\d*)$/u.exec(request.headers.range ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    response.writeHead(range ? 206 : 200, {
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(clip, { start, end }).pipe(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked };
};

test("[fake-tui] a video at a web address plays only after play is pressed, and is never followed elsewhere", async () => {
  test.setTimeout(240_000);
  await mkdir(SHOTS, { recursive: true });
  const elsewhere = await serveClip();
  const host = await serveClip(() => `${elsewhere.origin}/runs/onboarding.mp4`);
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

    const good = `${host.origin}/runs/onboarding.mp4`;
    const moved = `${host.origin}/moved.mp4`;
    const raised = await ada.cli(["feedback", "The recorded run is up.", "--video", `The run=${good}`, "--video", moved]);
    expect(raised.ok, `${raised.stdout}${raised.stderr}`).toBe(true);
    await expect.poll(async () => (await signalsNow()).length, { timeout: 15_000 }).toBe(1);
    const signal = (await signalsNow())[0]!;
    expect(signal.attachments).toEqual([
      { kind: "link", url: good, caption: "The run" },
      { kind: "link", url: moved },
    ]);

    await page.keyboard.press("Meta+I");
    const feed = page.getByTestId("operator-feed");
    await expect(feed).toBeVisible({ timeout: 10_000 });
    const card = feed.locator(`[data-item-id='signal:${signal.signalId}']`);
    await card.getByRole("button", { name: /Details/ }).click();
    const thumbs = card.getByTestId("preview-strip").getByTestId("preview-thumbnail");
    await expect(thumbs).toHaveCount(2);
    await thumbs.nth(0).click();
    const viewer = page.getByTestId("preview-viewer");
    await expect(viewer.getByTestId("preview-link-address")).toHaveText(good);
    await expect(viewer).toContainText("Nothing is fetched until you press play");
    await page.screenshot({ path: join(SHOTS, "remote-address-dark.png") });
    // Shown, on the card and in the viewer, and still nothing was asked of the server.
    expect(host.asked).toEqual([]);

    await viewer.getByRole("button", { name: "Play", exact: true }).click();
    const video = viewer.locator("video");
    await expect(video).toBeVisible();
    // The player holds the app's own address, never the agent's.
    expect(await video.getAttribute("src")).toMatch(/^junto-content:\/\/remote\/[a-f0-9]{32}$/);
    await expect
      .poll(() => video.evaluate((node) => (node as HTMLVideoElement).duration), { timeout: 20_000 })
      .toBeGreaterThan(2);
    await expect
      .poll(() => video.evaluate((node) => (node as HTMLVideoElement).currentTime), { timeout: 20_000 })
      .toBeGreaterThan(0.3);
    await video.evaluate((node) => {
      (node as HTMLVideoElement).pause();
      (node as HTMLVideoElement).currentTime = 2;
    });
    await expect
      .poll(() => video.evaluate((node) => (node as HTMLVideoElement).currentTime), { timeout: 20_000 })
      .toBeGreaterThanOrEqual(2);
    expect(host.asked.length).toBeGreaterThan(0);
    expect(host.asked.every((line) => line.endsWith(" /runs/onboarding.mp4"))).toBe(true);
    await page.screenshot({ path: join(SHOTS, "remote-playing-dark.png") });

    // The second address sends the player to another site: it does not play, and that site is never asked.
    await viewer.getByRole("button", { name: "Next" }).click();
    await expect(viewer.getByTestId("preview-link-address")).toHaveText(moved);
    await viewer.getByRole("button", { name: "Play", exact: true }).click();
    await expect(viewer).toContainText("did not answer with a video", { timeout: 20_000 });
    expect(host.asked.some((line) => line.endsWith(" /moved.mp4"))).toBe(true);
    expect(elsewhere.asked).toEqual([]);
  } finally {
    await junto.close();
    host.server.close();
    elsewhere.server.close();
  }
});
