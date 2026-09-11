import { describe, expect, it, vi } from "vitest";
import {
  findPackagedSandboxDisablingSwitch,
  PACKAGED_SANDBOX_DISABLING_SWITCHES,
} from "../src/main/vellum-command/packaged-sandbox-policy";

describe("packaged Chromium sandbox policy", () => {
  it.each(PACKAGED_SANDBOX_DISABLING_SWITCHES)(
    "rejects --%s in a packaged process",
    (candidate) => {
      expect(findPackagedSandboxDisablingSwitch({
        packaged: true,
        hasSwitch: (name) => name === candidate,
      })).toBe(candidate);
    },
  );

  it("accepts a packaged process with every sandbox layer intact", () => {
    expect(findPackagedSandboxDisablingSwitch({
      packaged: true,
      hasSwitch: () => false,
    })).toBeUndefined();
  });

  it("does not turn development tooling into release authority", () => {
    const hasSwitch = vi.fn(() => true);
    expect(findPackagedSandboxDisablingSwitch({
      packaged: false,
      hasSwitch,
    })).toBeUndefined();
    expect(hasSwitch).not.toHaveBeenCalled();
  });
});
