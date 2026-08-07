import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  BOOTSTRAP_MARKER_PREFIX,
  appendBootstrapMarker,
  buildBootstrapMarker,
} from "../src/shared/managed-terminal-injection";
const MARKER_RE = /^\[vc-[0-9a-f]{8}\]$/;

describe("buildBootstrapMarker", () => {
  it("matches the marker format and is deterministic", () => {
    expect(buildBootstrapMarker("binding-1")).toMatch(MARKER_RE);
    expect(buildBootstrapMarker("binding-1")).toBe(buildBootstrapMarker("binding-1"));
  });

  it("differs across distinct binding ids", () => {
    const a = buildBootstrapMarker("binding-a");
    const b = buildBootstrapMarker("binding-b");
    expect(a).not.toBe(b);
  });

  it("prefix and suffix round-trip", () => {
    const marker = buildBootstrapMarker("x");
    expect(marker.startsWith(BOOTSTRAP_MARKER_PREFIX)).toBe(true);
    expect(marker.endsWith("]")).toBe(true);
  });
});
