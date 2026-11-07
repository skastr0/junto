/**
 * Two cores on one real link session: the "mini" core runs the seat, the
 * "book" core edits its canvas. A seat started over the link must read
 * running from the book, and the mini's seat-state runtime must reach the
 * book as a published state.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import type { AgentSeatStateEvent } from "../src/shared/agent-seat-state";
import { eventually, miniSeat, twoCoreCanvas as canvas, twoCoreProcess, twoCores } from "./support/two-cores";

const cleanups: Array<() => Promise<void>> = [];
let restore: () => void;
beforeEach(() => { restore = twoCoreProcess(); });
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  restore();
});

it("a seat started over the link reads running from the editing core, and its state reaches it", async () => {
  const published: AgentSeatStateEvent[] = [];
  const { mini, bookEnd } = await twoCores({ cleanups, book: { publishState: (event) => { published.push(event); } } });

  const started = await bookEnd.request("seats", { _tag: "Start", canvas, seatId: miniSeat.id });
  expect(started).toMatchObject({ _tag: "Started", machine: "mini" });
  // The book's window reads the seat over the same link: running.
  expect(await bookEnd.request("seats", { _tag: "Get", canvas, seatId: miniSeat.id }))
    .toMatchObject({ _tag: "Started", status: "running" });

  // The stand-in prints, as a harness does; the mini's runtime reads it.
  mini.fake.controllers[0]!.emitData("stand-in ready\r\n");
  await eventually(() => expect(published.some((event) => event.bindingId === miniSeat.bindingId)).toBe(true));
});
