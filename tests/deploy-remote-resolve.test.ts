import { describe, expect, it } from "vitest";
import { resolveLocalAppBundle } from "../src/main/vellum/hosts/deploy-remote";

describe("resolveLocalAppBundle", () => {
  it("returns a string path or null without throwing", () => {
    // In CI / bare checkout there may be no .app; function must stay pure-safe.
    const path = resolveLocalAppBundle();
    expect(path === null || (typeof path === "string" && path.length > 0)).toBe(true);
  });
});
