import { describe, expect, it } from "vitest";
import {
  doorForMode,
  modeFromConfiguration,
  startupDoor,
  type StationProcessMode,
} from "../src/shared/station-mode";

const MODES: readonly StationProcessMode[] = [
  "unenrolled",
  "remote",
  "command-center",
];

const SHAPES = [
  { packaged: true, headless: true },
  { packaged: true, headless: false },
  { packaged: false, headless: true },
  { packaged: false, headless: false },
] as const;

describe("startup door selection", () => {
  it("opens enrollment ingress only on a packaged headless Unenrolled boot", () => {
    expect(
      startupDoor({ mode: "unenrolled", packaged: true, headless: true }),
    ).toBe("enroll");
    expect(
      startupDoor({ mode: "unenrolled", packaged: true, headless: false }),
    ).toBeUndefined();
    expect(
      startupDoor({ mode: "unenrolled", packaged: false, headless: true }),
    ).toBeUndefined();
    expect(
      startupDoor({ mode: "unenrolled", packaged: false, headless: false }),
    ).toBeUndefined();
  });

  it("binds peer on a packaged headless Remote, never enroll", () => {
    // Regression: a packaged headless launch used to bind the enroll door on
    // an install that was already enrolled as a Remote.
    expect(
      startupDoor({ mode: "remote", packaged: true, headless: true }),
    ).toBe("peer");
    for (const shape of SHAPES) {
      expect(startupDoor({ mode: "remote", ...shape })).toBe("peer");
    }
  });

  it("boots Command Center doorless in every launch shape", () => {
    for (const shape of SHAPES) {
      expect(
        startupDoor({ mode: "command-center", ...shape }),
      ).toBeUndefined();
    }
  });

  it("never returns a door the mode does not own", () => {
    for (const mode of MODES) {
      for (const shape of SHAPES) {
        const door = startupDoor({ mode, ...shape });
        if (door !== undefined) expect(door).toBe(doorForMode(mode));
      }
    }
  });

  it("reads the door from the persisted role, not from the launch shape", () => {
    const persisted = [
      { role: "remote" as const, door: "peer" },
      { role: "command-center" as const, door: undefined },
      { role: "" as const, door: "enroll" },
      { role: undefined, door: "enroll" },
    ];
    for (const { role, door } of persisted) {
      expect(
        startupDoor({
          mode: modeFromConfiguration(role),
          packaged: true,
          headless: true,
        }),
      ).toBe(door);
    }
  });
});
