import { describe, expect, it } from "vitest";
import type { Seat } from "../src/shared/model";
import { seat } from "./support/model-nodes";
import { SEAT_URGENCY, type SeatUrgency } from "../src/renderer/lib/seat-line";
import { needsOperator, seatUrgencyOrder } from "../src/renderer/lib/urgency-order";

const agent = (id: string, name: string): Seat => seat(id, { label: name as never });

describe("urgency order", () => {
  const ada = agent("a", "Ada");
  const bea = agent("b", "Bea");
  const cy = agent("c", "Cy");
  const by = (map: Record<string, SeatUrgency>) => (node: Seat) => map[node.id]!;

  it("puts the most urgent first", () => {
    const order = seatUrgencyOrder([ada, bea, cy], by({ a: SEAT_URGENCY.resting, b: SEAT_URGENCY.blocked, c: SEAT_URGENCY.waiting }));
    expect(order.map((node) => node.id)).toEqual(["b", "c", "a"]);
  });

  it("breaks a tie by name, whatever order the agents came in", () => {
    const same = by({ a: SEAT_URGENCY.working, b: SEAT_URGENCY.working, c: SEAT_URGENCY.working });
    expect(seatUrgencyOrder([cy, ada, bea], same).map((node) => node.id)).toEqual(["a", "b", "c"]);
  });

  it("reads each agent's urgency once", () => {
    let reads = 0;
    seatUrgencyOrder([ada, bea, cy], () => {
      reads += 1;
      return SEAT_URGENCY.resting;
    });
    expect(reads).toBe(3);
  });

  it("does not reorder the list it was given", () => {
    const given = [cy, ada];
    seatUrgencyOrder(given, () => SEAT_URGENCY.resting);
    expect(given.map((node) => node.id)).toEqual(["c", "a"]);
  });
});

describe("needs the operator", () => {
  it("is true for blocked, waiting and review, and false for the rest", () => {
    expect([SEAT_URGENCY.blocked, SEAT_URGENCY.waiting, SEAT_URGENCY.review].map(needsOperator)).toEqual([true, true, true]);
    expect([SEAT_URGENCY.working, SEAT_URGENCY.resting, SEAT_URGENCY.offline].map(needsOperator)).toEqual([false, false, false]);
  });
});
