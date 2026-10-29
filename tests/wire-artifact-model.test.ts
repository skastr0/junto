/**
 * The artifact model is a wire model (0.11.3, the phone's artifacts): its
 * schemas and rules live in src/shared/wire/ with an `effect`-only closure
 * (tests/wire-closure.test.ts), and every desktop path that held them
 * re-exports the very same value. So the phone decodes and rules a write with
 * the schema and the function the Mac uses, not a copy that can drift.
 */
import { describe, expect, it } from "vitest";
import * as actorSeat from "../src/shared/actor-seat";
import * as labels from "../src/shared/artifact-labels";
import * as modelSheet from "../src/shared/model/sheet";
import * as physics from "../src/shared/physics/schema";
import * as resourceCommand from "../src/shared/resource-command";
import * as sheet from "../src/shared/sheet";
import { ULID_PATTERN } from "../src/shared/ulid";
import * as workIds from "../src/shared/work-ids";
import * as wireIds from "../src/shared/wire/ids";
import * as wireLabels from "../src/shared/wire/artifact-labels";
import * as wireActor from "../src/shared/wire/resource-actor";
import * as wireSheet from "../src/shared/wire/sheet";

/** Each name is the same object on the desktop path as on the wire. */
const same = (desktop: Record<string, unknown>, wire: Record<string, unknown>, names: ReadonlyArray<string>): void => {
  for (const name of names) {
    expect(wire[name], `wire has ${name}`).toBeDefined();
    expect(desktop[name], name).toBe(wire[name]);
  }
};

describe("the artifact model on the wire is the desktop's own", () => {
  it("ids: NodeId, ItemId, OpId and TaskNumber are one definition", () => {
    same(physics, wireIds, ["NodeId"]);
    same(workIds, wireIds, ["ItemId", "OpId", "TaskNumber", "isItemId", "isOpId", "isTaskNumber", "ULID_SHAPE"]);
    expect(wireIds.WIRE_ULID_PATTERN.source).toBe(ULID_PATTERN.source);
    expect(wireIds.WIRE_ULID_PATTERN.flags).toBe(ULID_PATTERN.flags);
  });

  it("the writer: ResourceActor and ActorSeatId are one definition", () => {
    same(resourceCommand, wireActor, ["ResourceActor"]);
    same(actorSeat, wireActor, ["ActorSeatId"]);
  });

  it("labels: the label rule, its schemas and the colours are one definition", () => {
    same(labels, wireLabels, Object.keys(wireLabels));
    expect(Object.keys(labels).sort()).toEqual(Object.keys(wireLabels).sort());
  });

  it("sheets: the grid, its rows and columns and every sheet rule are one definition", () => {
    same(sheet, wireSheet, Object.keys(wireSheet));
    same(modelSheet, wireSheet, ["SheetGrid"]);
  });
});
