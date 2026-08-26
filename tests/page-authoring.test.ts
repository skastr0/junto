import { describe, expect, it } from "vitest";
import { resolveAuthoredPageHost } from "../src/renderer/lib/page-authoring";

describe("page authoring host policy", () => {
  it("uses the region-selected page host at every creation entry point", () => {
    expect(resolveAuthoredPageHost("browser-fleet", "local")).toBe("browser-fleet");
    expect(resolveAuthoredPageHost("browser-fleet", "service-host")).toBe("browser-fleet");
    expect(resolveAuthoredPageHost("browser-fleet", "shell-host")).toBe("browser-fleet");
  });

  it("preserves the source surface host when a region does not select one", () => {
    expect(resolveAuthoredPageHost(undefined, "service-host")).toBe("service-host");
    expect(resolveAuthoredPageHost("  ", "shell-host")).toBe("shell-host");
  });

  it("keeps legacy generic creation local when both sources are absent", () => {
    expect(resolveAuthoredPageHost(undefined, undefined)).toBe("local");
  });
});
