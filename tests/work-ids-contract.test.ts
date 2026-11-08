import { Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import { isItemId, isOpId, isTaskNumber, ItemId, OpId, TaskNumber } from "../src/shared/work-ids";

const ULID = "01M5ESS4R68EVCEB1K7Y9GTQX6";

describe("work ids", () => {
  it("mints a ULID as an op id and an item id", () => {
    expect(isOpId(OpId.make(ULID))).toBe(true);
    expect(isItemId(ItemId.make(ULID))).toBe(true);
  });

  it("refuses anything that is not a bare ULID", () => {
    for (const bad of [
      "",
      ULID.toLowerCase(),
      `${ULID}0`,
      ULID.slice(1),
      `op-${ULID}`,
      // Crockford base32 has no I, L, O or U.
      "01M5ESS4R68EVCEB1K7Y9GTQXI",
      "01M5ESS4R68EVCEB1K7Y9GTQXU",
    ]) {
      expect(isOpId(bad)).toBe(false);
      expect(isItemId(bad)).toBe(false);
      expect(() => OpId.make(bad)).toThrow();
      expect(() => ItemId.make(bad)).toThrow();
    }
  });

  it("decodes a task number only as a whole number from 1", () => {
    expect(isTaskNumber(TaskNumber.make(1))).toBe(true);
    expect(isTaskNumber(42)).toBe(true);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "42"]) {
      expect(isTaskNumber(bad)).toBe(false);
    }
    expect(() => Schema.decodeUnknownSync(TaskNumber)(0)).toThrow();
  });

  it("keeps a bare string or number from standing in for an id", () => {
    // @ts-expect-error: a bare string is not an op id.
    const op: OpId = ULID;
    // @ts-expect-error: a bare string is not an item id.
    const item: ItemId = ULID;
    // @ts-expect-error: a bare number is not a task number.
    const number: TaskNumber = 42;
    void [op, item, number];
  });

  it("keeps the brands apart though op and item share a shape", () => {
    expectTypeOf<OpId>().not.toExtend<ItemId>();
    expectTypeOf<ItemId>().not.toExtend<OpId>();
    // @ts-expect-error: an op id is not an item id.
    const item: ItemId = OpId.make(ULID);
    // @ts-expect-error: an item id is not an op id.
    const op: OpId = ItemId.make(ULID);
    void [item, op];
  });

  it("narrows an unknown value through its guard", () => {
    const value: unknown = ULID;
    if (isOpId(value)) expectTypeOf(value).toEqualTypeOf<OpId>();
    if (isItemId(value)) expectTypeOf(value).toEqualTypeOf<ItemId>();
    if (isTaskNumber(value)) expectTypeOf(value).toEqualTypeOf<TaskNumber>();
  });
});
