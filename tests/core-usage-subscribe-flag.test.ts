/**
 * Usage reaches the window only where the build turns usage on: the baseline
 * junto/ipc.ts:896 subscribed under USAGE_ENABLED, and the core's startup op
 * must keep that gate or a build without usage starts publishing nothing.
 */
import { describe, expect, it, vi } from "vitest";
import { subscribeUsageWhenEnabled } from "../src/main/core-process/ops/ipc-startup";

describe("the usage snapshot publish", () => {
  it("subscribes where the build turns usage on", () => {
    const subscribe = vi.fn(() => () => undefined);
    subscribeUsageWhenEnabled({ subscribe }, true);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("subscribes nowhere where the build turns usage off", () => {
    const subscribe = vi.fn(() => () => undefined);
    subscribeUsageWhenEnabled({ subscribe }, false);
    expect(subscribe).not.toHaveBeenCalled();
  });
});
