import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  BOOTSTRAP_MARKER_PREFIX,
  appendBootstrapMarker,
  buildBootstrapMarker,
  buildRepairEnvNudge,
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

describe("buildRepairEnvNudge", () => {
  const cliPath = "/opt/vellum-command/bin/vellum-command";
  const nudge = buildRepairEnvNudge(cliPath, "binding-1", {
    seatRef: "seat-x",
  });

  it("contains the given absolute path and the onboard command", () => {
    expect(nudge).toContain(cliPath);
    expect(nudge).toContain(`${cliPath} onboard`);
    expect(nudge).toContain("onboard");
  });

  it("starts with the marker and is short (4-6 body lines)", () => {
    expect(nudge.split("\n")[0]).toMatch(MARKER_RE);
    const body = nudge.split("\n").slice(2);
    expect(body.length).toBeGreaterThanOrEqual(4);
    expect(body.length).toBeLessThanOrEqual(6);
  });

  it("never exposes socket/token/home/debug words", () => {
    for (const forbidden of ["socket", "token", "home", "debug"]) {
      expect(nudge).not.toContain(forbidden);
    }
  });

  it("uses ctx.seatRef when provided", () => {
    expect(nudge).toContain("seat-x");
    const bare = buildRepairEnvNudge(cliPath, "binding-1");
    expect(bare).not.toContain("seat-x");
    expect(bare).toContain(cliPath);
    expect(bare.split("\n")[0]).toMatch(MARKER_RE);
  });
});
