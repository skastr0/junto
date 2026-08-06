/**
 * Demo growth-50 capture — NOT a correctness spec. Rolls the growth-ladder
 * demo scenario (VELLUM_COMMAND_DEMO=1, scenario via VELLUM_COMMAND_DEMO_SCENARIO) and
 * records the take as a CDP screencast frame sequence + manifest. Post
 * (label overlays, encode) aligns everything by epoch: screencast frame
 * timestamps and the EDL's startedAtEpochMs share the machine clock.
 *   DEMO_CAPTURE_DIR=/somewhere/durable bun run test:e2e:fast e2e/scenarios/demo-growth-capture.spec.ts
 * Playwright's recordVideo is NOT used: on this electron launch path it
 * wedges renderer boot (window never paints). The CDP screencast attaches
 * after boot and has no such interaction — and needs no screen-recording TCC.
 *
 * The window is shown (VELLUM_COMMAND_E2E_SHOW=1) for the length of the take: hidden
 * or occluded windows stop compositing and the screencast stalls with them.
 * Keep the window unobstructed while this spec runs.
 */
import { writeFileSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, launchVellum, test } from "../harness/launch";

const OUT = process.env.DEMO_CAPTURE_DIR ?? join(process.cwd(), "test-results", "demo-capture");
// Same 16:10 frame as marketing-shots; Retina compositor yields 2x frames.
const FRAME = { width: 1760, height: 1100 };
// growth-50 runs ~52s at 112 BPM (+2-beat tail); generous ceiling for drift.
const TAKE_CEILING_MS = 90_000;

interface FrameRecord {
  readonly file: string;
  /** Epoch seconds (Chromium compositor clock — same machine clock as the
   * EDL's startedAtEpochMs). */
  readonly ts: number;
}

test("roll growth-50 and record the take", async () => {
  test.setTimeout(240_000);
  const framesDir = join(OUT, "frames");
  await mkdir(framesDir, { recursive: true });

  const vellum = await launchVellum({
    demo: true,
    extraEnv: {
      VELLUM_COMMAND_DEMO_SCENARIO: "growth-50",
      VELLUM_COMMAND_E2E_SHOW: "1",
    },
  });

  const { app, page, sandbox } = vellum;
  try {
    await app.evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.setSize(size.width, size.height);
        win.center();
        win.show();
        win.focus();
      }
    }, FRAME);

    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

    // Film-set chrome out of frame: demo HUD chip + provider usage HUD (same
    // presentation-only hides as marketing-shots — no product state is faked).
    await page
      .getByText("DEMO - F9 to roll", { exact: false })
      .evaluate((el) => {
        const chip = el.parentElement;
        if (chip) chip.style.display = "none";
      })
      .catch(() => undefined);
    await page.addStyleTag({
      content: ".usage-hud { visibility: hidden !important; }",
    });

    // The story says "press play" — the top-bar chip must not read PAUSED for
    // the whole take. Real product controls, clicked like an operator would:
    // the pause switch, then the first-play confirm gate.
    try {
      await page.getByRole("button", { name: "Play factory" }).click({ timeout: 3_000 });
      await page
        .locator('[data-testid="first-play-confirm"]')
        .getByRole("button", { name: "play" })
        .click({ timeout: 3_000 });
    } catch {
      console.log("WARN: factory play control not clickable — chip may read PAUSED on film");
    }
    // Park the cursor — camera moves sweep nodes under a centered mouse and
    // pop hover tooltips into the recording.
    await page.mouse.move(4, 4);
    await page.waitForTimeout(500);

    // Screencast on. Frames are written synchronously in event order; the ack
    // keeps the compositor streaming.
    const cdp = await app.context().newCDPSession(page);
    const frames: FrameRecord[] = [];
    cdp.on(
      "Page.screencastFrame",
      (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
        const file = `f${String(frames.length).padStart(5, "0")}.jpg`;
        writeFileSync(join(framesDir, file), Buffer.from(f.data, "base64"));
        frames.push({ file, ts: f.metadata.timestamp ?? 0 });
        void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => undefined);
      },
    );
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 92,
      maxWidth: FRAME.width * 2,
      maxHeight: FRAME.height * 2,
      everyNthFrame: 1,
    });

    await page.keyboard.press("F9");

    // The EDL landing in the sandbox home is the take-completion receipt —
    // the conductor writes it only after the full beat map has executed.
    const edlDir = join(sandbox.homeDir, ".vellum-command", "demo");
    await expect
      .poll(
        async () => {
          const entries = await readdir(edlDir).catch(() => [] as string[]);
          return entries.some((f) => f.startsWith("edl-growth-50"));
        },
        { timeout: TAKE_CEILING_MS, intervals: [1_000] },
      )
      .toBe(true);

    // Let the final camera glide settle on film, then stop.
    await page.waitForTimeout(2_000);
    await cdp.send("Page.stopScreencast").catch(() => undefined);
    await page.waitForTimeout(300);

    const edlName = (await readdir(edlDir)).find((f) => f.startsWith("edl-growth-50"));
    expect(edlName).toBeDefined();
    if (edlName) {
      // Copy before close — sandbox teardown deletes the temp home.
      await copyFile(join(edlDir, edlName), join(OUT, "edl-growth-50.json"));
    }
    await writeFile(
      join(OUT, "frames-manifest.json"),
      JSON.stringify({ frame: FRAME, frames }, null, 2),
    );

    expect(frames.length).toBeGreaterThan(100);
    const edl = edlName
      ? (JSON.parse(await readFile(join(OUT, "edl-growth-50.json"), "utf8")) as {
          startedAtEpochMs: number;
        })
      : undefined;
    console.log(
      `CAPTURE frames=${frames.length} first=${frames[0]?.ts} last=${frames[frames.length - 1]?.ts} takeT0=${edl ? edl.startedAtEpochMs / 1000 : "?"}`,
    );
  } finally {
    await vellum.close();
  }
});
