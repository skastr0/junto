import { describe, expect, it } from "vitest";
import type { Seat } from "../src/shared/model";
import { seat } from "./support/model-nodes";
import type { SeatGroup } from "../src/renderer/lib/seat-line";
import { seatUrgencyOrder } from "../src/renderer/lib/urgency-order";
import { SeatUrgency } from "../src/shared/wire/urgency";

const agent = (id: string, name: string): Seat => seat(id, { label: name as never });

describe("urgency order", () => {
  const ada = agent("a", "Ada");
  const bea = agent("b", "Bea");
  const cy = agent("c", "Cy");
  const by = (map: Record<string, SeatGroup>) => (node: Seat) => map[node.id]!;

  it("puts the most urgent first", () => {
    const order = seatUrgencyOrder([ada, bea, cy], by({ a: SeatUrgency.group.resting, b: SeatUrgency.group.blocked, c: SeatUrgency.group.waiting }));
    expect(order.map((node) => node.id)).toEqual(["b", "c", "a"]);
  });

  it("breaks a tie by name, whatever order the agents came in", () => {
    const same = by({ a: SeatUrgency.group.working, b: SeatUrgency.group.working, c: SeatUrgency.group.working });
    expect(seatUrgencyOrder([cy, ada, bea], same).map((node) => node.id)).toEqual(["a", "b", "c"]);
  });

  it("reads each agent's urgency once", () => {
    let reads = 0;
    seatUrgencyOrder([ada, bea, cy], () => {
      reads += 1;
      return SeatUrgency.group.resting;
    });
    expect(reads).toBe(3);
  });

  it("does not reorder the list it was given", () => {
    const given = [cy, ada];
    seatUrgencyOrder(given, () => SeatUrgency.group.resting);
    expect(given.map((node) => node.id)).toEqual(["c", "a"]);
  });
});
