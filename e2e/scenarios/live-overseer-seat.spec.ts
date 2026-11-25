/**
 * A Live seat starts its host [all-on].
 *
 * A junto-overseer seat's occupant is the live overseer host of this build
 * (`out/main/overseer-host.js`), run on Junto's own Node, not a `junto`
 * subcommand. Opened, the seat's terminal says the host is ready, and the host
 * stays up: it asks main for its next Live run and is told it has none, which
 * leaves its banner on screen with no connection failure under it.
 */
import { card, canvasReady } from "../harness/canvas";
import { modelFixture, modelSeat } from "../harness/model";
import { terminalRows } from "../harness/term-ready";
import { expect, launchJunto, test } from "../harness/launch";

const CANVAS = "live";
const SEAT = "live-overseer";
const seat = modelSeat({ id: SEAT, label: "Overseer", harness: "junto-overseer", x: 80, y: 80 });

test("[all-on] a junto-overseer seat runs the build's live host and the host stays up", async () => {
  test.setTimeout(180_000);
  const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture([seat], []) } });
  const page = junto.page;
  await canvasReady(page);
  await page.evaluate(async ([canvas, id]) => {
    await window.junto!.modelStart({ canvas, id });
  }, [CANVAS, SEAT] as const);
  await card(page, SEAT).dblclick();
  const screen = async (): Promise<string> => (await terminalRows(page)).join("\n");
  await expect.poll(screen, { timeout: 60_000, message: "the host's banner" })
    .toContain("Junto Overseer is ready. Start a live conversation from its command card.");
  // The host polls main every 250 ms; ten seconds of polling without a refusal is a host that runs.
  await page.waitForTimeout(10_000);
  const settled = await screen();
  expect(settled).toContain("Junto Overseer is ready.");
  expect(settled).not.toMatch(/Controller connection failed|not found|disabled in this build|is not part of this Junto build/u);
});
