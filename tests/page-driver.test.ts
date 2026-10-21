import { describe, expect, expectTypeOf, it } from "vitest";
import { asNodeId, type NodeId } from "../src/shared/model/base";
import {
  DRIVER_RECENT_MS,
  admitSeat,
  driverMark,
  initialPageDriving,
  reducePageDriving,
  type DriverMark,
  type PageDriving,
  type PageDrivingEvent,
} from "../src/shared/page-driver";

const planner = asNodeId("planner");
const builder = asNodeId("builder");

const run = (...events: PageDrivingEvent[]): PageDriving =>
  events.reduce(reducePageDriving, initialPageDriving);

describe("page driver", () => {
  it("is idle until someone acts", () => {
    expect(driverMark(initialPageDriving, 0)).toEqual({ kind: "idle" });
    expect(admitSeat(initialPageDriving)).toEqual({ ok: true });
  });

  it("marks the seat driving while its action runs and shortly after", () => {
    const started = run({ kind: "seat-start", nodeId: planner, at: 100 });
    expect(driverMark(started, 100 + DRIVER_RECENT_MS * 10)).toEqual({ kind: "seat", nodeId: planner, running: true });
    const ended = reducePageDriving(started, { kind: "seat-end", nodeId: planner, at: 200 });
    expect(driverMark(ended, 200 + DRIVER_RECENT_MS - 1)).toEqual({ kind: "seat", nodeId: planner, running: false });
    expect(driverMark(ended, 200 + DRIVER_RECENT_MS)).toEqual({ kind: "idle" });
  });

  it("names the seat that acted last", () => {
    const state = run(
      { kind: "seat-start", nodeId: planner, at: 1 },
      { kind: "seat-end", nodeId: planner, at: 2 },
      { kind: "seat-start", nodeId: builder, at: 3 },
    );
    expect(driverMark(state, 3)).toEqual({ kind: "seat", nodeId: builder, running: true });
    // A late end from the earlier seat does not touch the current driver.
    expect(reducePageDriving(state, { kind: "seat-end", nodeId: planner, at: 4 })).toBe(state);
  });

  it("refuses every seat while the operator holds the page, and resumes on release", () => {
    const held = run({ kind: "seat-start", nodeId: planner, at: 1 }, { kind: "take-over", at: 5 });
    expect(admitSeat(held)).toEqual({ ok: false, refusal: { kind: "operator_holds", since: 5 } });
    expect(driverMark(held, 6)).toEqual({ kind: "operator-held", since: 5 });
    expect(reducePageDriving(held, { kind: "seat-start", nodeId: builder, at: 6 })).toBe(held);
    // Taking over twice keeps the first time.
    expect(reducePageDriving(held, { kind: "take-over", at: 9 })).toBe(held);
    const released = reducePageDriving(held, { kind: "release", at: 10 });
    expect(admitSeat(released)).toEqual({ ok: true });
    expect(driverMark(released, 10)).toEqual({ kind: "operator" });
  });

  it("counts overlapping actions of one seat", () => {
    const two = run({ kind: "seat-start", nodeId: planner, at: 1 }, { kind: "seat-start", nodeId: planner, at: 2 });
    const one = reducePageDriving(two, { kind: "seat-end", nodeId: planner, at: 3 });
    expect(driverMark(one, 3 + DRIVER_RECENT_MS * 2)).toMatchObject({ running: true });
  });

  it("keeps its contract closed at the type level", () => {
    expectTypeOf<DriverMark["kind"]>().toEqualTypeOf<"idle" | "operator-held" | "seat" | "operator">();
    expectTypeOf<Extract<DriverMark, { kind: "seat" }>["nodeId"]>().toEqualTypeOf<NodeId>();
    // @ts-expect-error a seat is named by its node id, not any string
    reducePageDriving(initialPageDriving, { kind: "seat-start", nodeId: "planner", at: 1 });
  });
});
