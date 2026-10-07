/**
 * Seat sessions [fake-tui]: after a seat moves to a second session,
 * `junto onboard` lists the first one's notes as history. Sessions are
 * internal to the seat, so this is proven through its CLI, never the UI.
 *
 * The seat is the crew fixture's fake codex, which proxies real work-control
 * calls over the app's socket with its own process-bound identity, so
 * `offboard` and `onboard` take the product path. The offboard moves the seat
 * on and leaves the first process to wind down off the seat; anything that
 * process asks of Junto afterwards is refused. So the second `onboard` comes
 * from a fresh process on the seat, once the first is gone: the two share the
 * fixture's one folder per seat, and only one of them may answer there. The
 * fresh process's session id arrives on the canvas node the way a new capture
 * sets it; the app's recorder turns that into history.
 *
 *   bun run test:e2e:fast e2e/scenarios/seat-sessions.spec.ts
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
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

/** The process is still there: signal 0 asks without touching it. */
const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
    const first = await crewOccupySeat(page, CANVAS, seatNode, seat);

    // Session one hands off.
    const notes = "# Parser wired for all three feeds\n\n- Next: retry on 429.\n- Why it matters: the nightly sync fails without it.";
    const offboard = data(await seat.op("offboard", { notes }));
    expect(offboard).toMatchObject({ session_id: FIRST, gist: "Parser wired for all three feeds" });
    const notesPath = String(offboard.notes_path);
    expect(notesPath).toContain(`/.junto/seats/${SEAT}/sessions/${FIRST}.md`);

    // The first process is off the seat and reads idle, as the fake does
    // between turns: Junto stops it after the settle (seat-sessions/drain.ts
    // DRAIN_SETTLE_MS).
    await expect.poll(() => isRunning(first.pid), { message: "the first process is gone", timeout: 30_000 }).toBe(false);
    await rm(join(seat.dir, "ready.json"), { force: true });

    // A fresh process takes the seat, started from the node as the offboard left it.
    const doc = (await page.evaluate(async (name) => (await window.junto!.readCanvas(name)).doc, CANVAS)) as CanvasDoc;
    const rested = doc.nodes.find((node) => node.id === SEAT) as TextNode;
    expect(rested.ether?.terminal?.sessionId, "the node no longer names the closed session").not.toBe(FIRST);
    const fresh = await crewOccupySeat(page, CANVAS, rested, seat);
    expect(fresh.pid, "a fresh process is on the seat").not.toBe(first.pid);

    // Its session id is captured onto the node.
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
      ended_because: "offboard",
    });
    expect(sessions.past[0].notes).toContain("retry on 429");
  } finally {
    await junto.close();
  }
});
