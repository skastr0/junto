import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { USAGE_ENABLED } from "../src/shared/features";

describe("usage product gate", () => {
  it.runIf(!USAGE_ENABLED)("omits usage bridges and live polling in the ship profile", () => {
    const preload = readFileSync("src/window/preload/index.ts", "utf8");
    // Main's usage handlers are registered with the status group's registrar.
    const main = readFileSync("src/app/status/status-ipc.ts", "utf8");
    const app = readFileSync("src/window/App.tsx", "utf8");

    expect(preload).toContain("...(USAGE_ENABLED ? usageApi : {})");
    // Usage polls in the core, started with the core's startup wiring.
    expect(readFileSync("src/core/ops/ipc-startup.ts", "utf8")).toContain("if (USAGE_ENABLED) usage.start()");
    expect(main).toContain("if (USAGE_ENABLED) {");
    expect(app).toContain("USAGE_ENABLED && junto.onUsageChanged");
    expect(app).toContain("USAGE_ENABLED && junto.getUsage");
  });
});
