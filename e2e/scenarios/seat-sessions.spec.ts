/**
 * Seat sessions [fake-tui]: a seat that has run two sessions shows both in
 * its Sessions tab, and `junto onboard` lists the first one's notes path.
 *
 * The seat is the crew fixture's fake codex, which proxies real work-control
 * calls over the app's socket with its own process-bound identity, so
 * `offboard` and `onboard` take the product path. The seat's session id
 * changes on its canvas node between the two, the way a rotation or a new
 * capture changes it; the app's recorder turns that into history.
 *
 * Captures both themes to test-results/seat-sessions/.
 *
 *   bun run test:e2e:fast e2e/scenarios/seat-sessions.spec.ts
 */
import type { Page } from "@playwright/test";
import type { CanvasDoc, TextNode } from "../../src/shared/canvas";
import { PAST_SESSIONS_FRAMING } from "../../src/shared/seat-sessions";
import { expect, launchJunto, test } from "../harness/launch";
import {
  crewDoc,
  crewMutateCanvas,
  crewOccupySeat,
  crewPlayFactory,
  crewSeat,
  crewSeatNode,
  installCrewSeatHarness,
  type WorkEnvelope,
} from "../harness/crew-fixture";

const SHOTS = "test-results/seat-sessions";
const CANVAS = "seat-sessions";
const SEAT = "seat-ada";
const FIRST = "sess-first-0001";
const SECOND = "sess-second-0002";

const base = crewSeatNode({ id: SEAT, label: "ada", x: 80, y: 80 });
const seatNode: TextNode = {
  ...base,
  ether: { ...base.ether, terminal: { ...base.ether!.terminal!, sessionId: FIRST } },
};

const data = (envelope: WorkEnvelope): Record<string, any> => {
  expect(envelope.ok, JSON.stringify(envelope)).toBe(true);
  return (envelope as { data?: Record<string, any> }).data ?? {};
};

const setTheme = async (page: Page, theme: "dark" | "bright") => {
  await page.evaluate(async (next) => {
    await window.junto!.settingsPatch({ appearance: { theme: next } });
  }, theme);
  if (theme === "bright") await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
  else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
};

test("a seat with two sessions shows both, and onboard lists the first one's notes", async () => {
  test.setTimeout(240_000);
  const junto = await launchJunto({
    seedCanvases: { [CANVAS]: crewDoc([seatNode], []) },
    afterSeed: installCrewSeatHarness,
  });
  try {
    const { page, sandbox } = junto;
    await expect(page.locator(`.react-flow__node[data-id="${SEAT}"]`)).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);
    const seat = crewSeat(sandbox, CANVAS, SEAT);
    await crewOccupySeat(page, CANVAS, seatNode, seat);

    // Session one hands off.
    const notes = "# Parser wired for all three feeds\n\n- Next: retry on 429.\n- Why it matters: the nightly sync fails without it.";
    const offboard = data(await seat.op("offboard", { notes }));
    expect(offboard).toMatchObject({ session_id: FIRST, gist: "Parser wired for all three feeds" });
    const notesPath = String(offboard.notes_path);
    expect(notesPath).toContain(`/.junto/seats/${SEAT}/sessions/${FIRST}.md`);

    // The seat moves to a second session.
    await crewMutateCanvas(page, CANVAS, (doc: CanvasDoc) => ({
      ...doc,
      nodes: doc.nodes.map((node) =>
        node.id === SEAT && node.ether?.terminal
          ? { ...node, ether: { ...node.ether, terminal: { ...node.ether.terminal, sessionId: SECOND } } }
          : node,
      ),
    }));

    // The fresh session onboards: the first session is listed as history,
    // with its notes path and its notes inline.
    await expect
      .poll(async () => data(await seat.op("onboard", {})).sessions?.current?.session_id, { timeout: 15_000 })
      .toBe(SECOND);
    const sessions = data(await seat.op("onboard", {})).sessions;
    expect(sessions.note).toBe(PAST_SESSIONS_FRAMING);
    expect(sessions.past).toHaveLength(1);
    expect(sessions.past[0]).toMatchObject({
      session_id: FIRST,
      notes_path: notesPath,
      gist: "Parser wired for all three feeds",
      ended_because: "replaced",
    });
    expect(sessions.past[0].notes).toContain("retry on 429");

    // The Sessions tab lists both, newest first.
    for (const theme of ["dark", "bright"] as const) {
      await setTheme(page, theme);
      const box = (await page.locator(`.react-flow__node[data-id="${SEAT}"]`).boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
      await page.getByRole("button", { name: "Edit soul and instructions" }).click();
      await page.getByRole("tab", { name: "sessions" }).click();
      const rows = page.getByTestId("seat-session-row");
      await expect(rows).toHaveCount(2);
      await expect(rows.nth(0)).toHaveAttribute("data-current", "true");
      await expect(rows.nth(0)).toContainText("now");
      await expect(rows.nth(1)).toContainText("Parser wired for all three feeds");
      await expect(rows.nth(1).getByRole("button", { name: "Open notes" })).toBeEnabled();
      await rows.nth(1).getByRole("button", { name: "Open notes" }).click();
      await expect(rows.nth(1).getByTestId("seat-session-notes")).toContainText("retry on 429");
      await page.screenshot({ path: `${SHOTS}/${theme}-sessions.png` });
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("agent-editor")).toHaveCount(0);
    }
  } finally {
    await junto.close();
  }
});
