import { describe, expect, it } from "vitest";
import { resolveAuthoredPageHost } from "../src/renderer/lib/page-authoring";

describe("the machine a new page goes on", () => {
  it("is the one the region chose, at every creation entry point", () => {
    expect(resolveAuthoredPageHost("browser-box", "studio")).toBe("browser-box");
    expect(resolveAuthoredPageHost("browser-box", "service-box")).toBe("browser-box");
  });

  it("is where its source is when the region chose none", () => {
    expect(resolveAuthoredPageHost(undefined, "service-box")).toBe("service-box");
    expect(resolveAuthoredPageHost("  ", " studio ")).toBe("studio");
  });
});
