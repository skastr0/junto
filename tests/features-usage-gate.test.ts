import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { USAGE_ENABLED } from "../src/shared/features";

describe("usage product gate", () => {
  it.runIf(!USAGE_ENABLED)("omits usage bridges and live polling in the ship profile", () => {
    const preload = readFileSync("src/preload/index.ts", "utf8");
    const main = readFileSync("src/main/vellum/ipc.ts", "utf8");
    const app = readFileSync("src/renderer/App.tsx", "utf8");

    expect(preload).toContain("...(USAGE_ENABLED ? usageApi : {})");
    expect(main).toContain("if (USAGE_ENABLED) usage.start()");
    expect(main).toContain("if (USAGE_ENABLED) {");
    expect(app).toContain("USAGE_ENABLED && vellum.onUsageChanged");
    expect(app).toContain("USAGE_ENABLED && vellum.getUsage");
  });
});
