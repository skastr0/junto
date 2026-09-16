import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  BOOTSTRAP_MARKER_PREFIX,
  appendBootstrapMarker,
  buildBootstrapMarker,
  buildOrientNotice,
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

describe("appendBootstrapMarker", () => {
  it("keeps a one-line body on one line so ink TUIs do not chip", () => {
    const marked = appendBootstrapMarker("run onboard", "binding-1");
    expect(marked).not.toContain("\n");
    expect(marked.startsWith(buildBootstrapMarker("binding-1") + " ")).toBe(true);
    expect(marked.endsWith("run onboard")).toBe(true);
  });

  it("puts the marker on the first line of a multiline body — no blank separator", () => {
    const marked = appendBootstrapMarker("line one\nline two", "binding-1");
    expect(marked).toBe(
      `${buildBootstrapMarker("binding-1")}\nline one\nline two`,
    );
  });
});

describe("buildOrientNotice", () => {
  it("is a single line (marker-prefixed notice must not chip)", () => {
    const notice = buildOrientNotice("seat-1");
    expect(notice).not.toContain("\n");
    expect(notice).toContain("junto onboard");
    expect(notice).toContain("seat-1");
    expect(appendBootstrapMarker(notice, "seat-1")).not.toContain("\n");
  });
});
