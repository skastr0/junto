import { describe, expect, it } from "vitest";
import {
  assertWorkControlSocketPathFits,
  unixSocketPathLimit,
  WorkSocketPathTooLong,
  workControlSocketPathBudget,
} from "../src/main/junto/work/socket-path";
import { buildStartupStateFailureCopy } from "../src/main/junto/state/startup-state-failure-dialog";
import { PRODUCT_NAME } from "../src/shared/product-name";

/** A work home whose `<workHome>/control.sock` is exactly `bytes` bytes. */
const homeWithSocketBytes = (bytes: number): string => {
  const prefix = "/tmp/";
  const suffix = "/control.sock";
  return `${prefix}${"a".repeat(bytes - prefix.length - suffix.length)}`;
};

describe("work socket path budget", () => {
  it("measures the control socket and names the platform limit", () => {
    const budget = workControlSocketPathBudget(homeWithSocketBytes(103), "darwin");
    expect(budget.path).toBe(`${homeWithSocketBytes(103)}/control.sock`);
    expect(budget.bytes).toBe(103);
    expect(budget.limit).toBe(104);
    expect(unixSocketPathLimit("linux")).toBe(108);
  });

  it("accepts the longest path that binds and refuses one byte more", () => {
    expect(() => assertWorkControlSocketPathFits(homeWithSocketBytes(103), "darwin")).not.toThrow();
    expect(() => assertWorkControlSocketPathFits(homeWithSocketBytes(104), "darwin")).toThrow(
      WorkSocketPathTooLong,
    );

    const long = homeWithSocketBytes(104);
    try {
      assertWorkControlSocketPathFits(long, "darwin");
      expect.unreachable("a 104-byte path must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkSocketPathTooLong);
      const tooLong = error as WorkSocketPathTooLong;
      expect(tooLong.path).toBe(`${long}/control.sock`);
      expect(tooLong.bytes).toBe(104);
      expect(tooLong.limit).toBe(104);
    }
  });

  it("uses the larger Linux limit", () => {
    expect(() => assertWorkControlSocketPathFits(homeWithSocketBytes(107), "linux")).not.toThrow();
    expect(() => assertWorkControlSocketPathFits(homeWithSocketBytes(108), "linux")).toThrow(
      WorkSocketPathTooLong,
    );
  });
});

describe("long work socket startup copy", () => {
  it("names the path and the limit, and tells the operator to shorten the home", () => {
    const path = `${homeWithSocketBytes(120)}/control.sock`;
    const copy = buildStartupStateFailureCopy({
      error: new WorkSocketPathTooLong({ path, bytes: 120, limit: 104 }),
    });

    expect(copy.title).toBe("Could not start");
    expect(copy.message).toBe(`${PRODUCT_NAME} could not start its work socket`);
    expect(copy.detail).toContain(path);
    expect(copy.detail).toContain("120 bytes");
    expect(copy.detail).toContain("104-byte limit");
    expect(copy.detail).toMatch(/shorter path/i);
    expect(copy.detail).toMatch(/was not deleted/i);
  });
});
