import { describe, expect, it } from "vitest";
import { defaultMachineName } from "../src/shared/machine-name";
import { isThisMachine, isValidMachineName } from "../src/shared/machine-identity";

describe("machine identity", () => {
  it("uses a stable short hostname as the default name", () => {
    expect(defaultMachineName("Guilherme-MacBook-Pro.local"))
      .toBe("guilherme-macbook-pro");
    expect(defaultMachineName()).toBe(defaultMachineName());
  });

  it("produces a host id for names that cannot be used as host ids", () => {
    for (const hostname of ["  João's Mac.local", "--mini", "", "🖥", "x".repeat(200)]) {
      expect(isValidMachineName(defaultMachineName(hostname))).toBe(true);
    }
  });

  it("does not persist the context-dependent local name", () => {
    expect(defaultMachineName("local")).toBe("machine-local");
    expect(isValidMachineName("local")).toBe(false);
  });

  it("checks placement independently of the editing machine", () => {
    expect(isThisMachine("mini", "mini")).toBe(true);
    expect(isThisMachine("mini", "book")).toBe(false);
    expect(isThisMachine(undefined, "book")).toBe(false);
    expect(isThisMachine("local", "book")).toBe(false);
  });
});
