import { describe, expect, it } from "vitest";
import { decodeCanvasDoc } from "../src/shared/canvas";
import { defaultSettings, SETTINGS_VERSION } from "../src/shared/settings";
import { decodeStoredSettings, preferencesFromSettings } from "../src/main/junto/settings/state-schema";

// Token pressure is retired: Junto no longer reads a seat's context size, and
// agents offboard on their own. Rows and documents written while it existed
// still carry its keys, and must load as if they never had them.

const seatDoc = (terminal: Record<string, unknown>) => ({
  nodes: [
    {
      id: "a1",
      type: "text",
      text: "seat",
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      ether: { entity: { kind: "agent", name: "local:claude" }, terminal },
    },
  ],
  edges: [],
});

describe("retired token pressure in stored data", () => {
  it("loads a canvas whose seat carries its own threshold, dropping only that key", () => {
    for (const tokenPressure of [
      { kind: "percent", percent: 75 },
      { kind: "tokens", tokens: 150_000 },
      { kind: "off" },
    ]) {
      const decoded = decodeCanvasDoc(
        seatDoc({ bindingId: "b1", harness: "claude", sessionId: "s1", tokenPressure }),
      );
      expect(decoded._tag).toBe("Success");
      if (decoded._tag !== "Success") return;
      expect(decoded.success.nodes[0]?.ether?.terminal).toEqual({
        bindingId: "b1",
        harness: "claude",
        sessionId: "s1",
      });
    }
  });

  it("loads a settings row that still carries the default threshold", () => {
    const stored = {
      ...(JSON.parse(JSON.stringify(preferencesFromSettings(defaultSettings()))) as Record<string, unknown>),
      tokenPressure: { enabled: true, threshold: { kind: "percent", percent: 75 }, graceMinutes: 10 },
    };
    const settings = decodeStoredSettings(SETTINGS_VERSION, stored, defaultSettings().station);
    expect(Object.hasOwn(settings, "tokenPressure")).toBe(false);
    // The next persist writes the row clean.
    expect(Object.hasOwn(preferencesFromSettings(settings), "tokenPressure")).toBe(false);
  });
});
