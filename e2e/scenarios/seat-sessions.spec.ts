/**
 * Seat sessions [fake-tui]: after a seat moves to a second session,
 * `junto onboard` lists the first one's notes as history. Sessions are
 * internal to the seat, so this is proven through its CLI, never the UI.
 *
 * The seat is the crew fixture's fake codex, which proxies real work-control
 * calls over the app's socket with its own process-bound identity, so
 * `offboard` and `onboard` take the product path. The seat's session id
 * changes on its canvas node between the two, the way a rotation or a new
 * capture changes it; the app's recorder turns that into history.
 *
 *   bun run test:e2e:fast e2e/scenarios/seat-sessions.spec.ts
 */
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

test("a seat's second session onboards with the first one's notes", async () => {
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
  } finally {
    await junto.close();
  }
});
